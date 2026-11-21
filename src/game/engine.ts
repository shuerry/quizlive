/**
 * QuizLive game engine: every server action's rules.
 *
 * Runs INSIDE the record Durable Object, under state.blockConcurrencyWhile
 * (see AppRecordRoom in worker.ts). While one op runs, the DO delivers no
 * other request, so each op's read-check-write sequence is atomic: two
 * submits, or a submit racing a reveal, run one after the other, never
 * interleaved.
 *
 * Identity: `callerId` is the verified JWT subject, set by the worker
 * (src/actions/index.ts). Ops never read a user id from `params`.
 * Time: `now()` is the DO's clock. Clients never send timestamps.
 */

import {
  makeJoinCode,
  normalizeJoinCode,
  scoreAnswer,
  validateNickname,
  validateQuestion,
  validateTitle,
} from './scoring'

// ── Store: the minimal record API the engine needs ──────────────────────────

export interface Rec<T> {
  recordId: string
  data: T
  createdBy?: string
}

export type WriteResult = { ok: true; recordId: string } | { ok: false; error: string }

export interface Store {
  get<T>(collection: string, recordId: string): Promise<Rec<T> | null>
  query<T>(collection: string, where: Record<string, string | number>): Promise<Rec<T>[]>
  /** `actingUserId` is stamped into userBound columns on create. */
  create(collection: string, data: Record<string, unknown>, actingUserId: string, recordId?: string): Promise<WriteResult>
  update(collection: string, recordId: string, patch: Record<string, unknown>, actingUserId: string): Promise<WriteResult>
  remove(collection: string, recordId: string, actingUserId: string): Promise<WriteResult>
}

// ── Record shapes ───────────────────────────────────────────────────────────

export type GameState = 'lobby' | 'question' | 'reveal' | 'ended'

export interface Quiz { title: string; hostId: string }
export interface Question {
  quizId: string
  order: number
  prompt: string
  choices: string[]
  timeLimitSec: number
  hostId: string
}
export interface AnswerKey { questionId: string; correctIndex: number; hostId: string }

/** What players see while a question is live. Never contains the answer. */
export interface LiveQuestion {
  questionId: string
  index: number
  total: number
  prompt: string
  choices: string[]
  timeLimitSec: number
}

export interface Game {
  quizId: string
  hostId: string
  code: string
  state: GameState
  currentIndex: number
  startedAt?: number
  endsAt?: number
  revealedIndex: number
  teamId: string
  currentQuestion?: LiveQuestion | null
  answeredCount: number
}
export interface Player { gameId: string; userId: string; nickname: string; score: number }
export interface Answer {
  gameId: string
  questionId: string
  userId: string
  choice: number
  receivedAt: number
  points?: number
}

// ── Op plumbing ─────────────────────────────────────────────────────────────

export interface OpContext {
  callerId: string
  params: Record<string, unknown>
  store: Store
  now: () => number
  newId: () => string
  joinCode?: () => string
}

export type OpResult =
  | { success: true; data: Record<string, unknown>; serverNow: number }
  | { success: false; error: string; code: string; serverNow: number }

class OpError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

function fail(code: string, message: string): never {
  throw new OpError(code, message)
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== 'string' || !v.trim()) fail('bad_request', `Missing ${key}`)
  return (v as string).trim()
}

async function must(result: Promise<WriteResult>, what: string): Promise<string> {
  const r = await result
  if (!r.ok) fail('write_failed', `Could not ${what}: ${r.error}`)
  return (r as { recordId: string }).recordId
}

// ── Shared loaders / guards ─────────────────────────────────────────────────

async function loadOwnQuiz(ctx: OpContext, quizId: string): Promise<Rec<Quiz>> {
  const quiz = await ctx.store.get<Quiz>('quizzes', quizId)
  if (!quiz) fail('not_found', 'Quiz not found')
  if (quiz!.data.hostId !== ctx.callerId) fail('forbidden', 'Only the quiz host can do that')
  return quiz!
}

async function loadGame(ctx: OpContext): Promise<Rec<Game>> {
  const game = await ctx.store.get<Game>('games', str(ctx.params, 'gameId'))
  if (!game) fail('not_found', 'Game not found')
  return game!
}

async function loadHostGame(ctx: OpContext): Promise<Rec<Game>> {
  const game = await loadGame(ctx)
  if (game.data.hostId !== ctx.callerId) fail('forbidden', 'Only the host can control the game')
  return game
}

async function quizQuestions(ctx: OpContext, quizId: string): Promise<Rec<Question>[]> {
  const qs = await ctx.store.query<Question>('questions', { quizId })
  return qs.sort((a, b) => a.data.order - b.data.order || a.recordId.localeCompare(b.recordId))
}

/** Start question `index` on the server clock. The answer is not copied. */
async function beginQuestion(ctx: OpContext, game: Rec<Game>, index: number) {
  const qs = await quizQuestions(ctx, game.data.quizId)
  const q = qs[index]
  if (!q) fail('no_more_questions', 'There is no question at that position')
  const startedAt = ctx.now()
  const endsAt = startedAt + q!.data.timeLimitSec * 1000
  // Explicit field list: nothing from the question or its key leaks by accident.
  const currentQuestion: LiveQuestion = {
    questionId: q!.recordId,
    index,
    total: qs.length,
    prompt: q!.data.prompt,
    choices: [...q!.data.choices],
    timeLimitSec: q!.data.timeLimitSec,
  }
  await must(
    ctx.store.update(
      'games',
      game.recordId,
      {
        state: 'question',
        currentIndex: index,
        startedAt,
        endsAt,
        revealedIndex: -1,
        answeredCount: 0,
        currentQuestion,
      },
      ctx.callerId,
    ),
    'start the question',
  )
  return { index, total: qs.length, startedAt, endsAt }
}

// ── Ops ─────────────────────────────────────────────────────────────────────

async function createQuiz(ctx: OpContext) {
  const title = validateTitle(ctx.params.title)
  if (!title.ok) fail('invalid', title.error)
  const quizId = await must(
    ctx.store.create('quizzes', { title: (title as { value: string }).value, hostId: ctx.callerId }, ctx.callerId),
    'create the quiz',
  )
  return { quizId }
}

async function saveQuestion(ctx: OpContext) {
  const quiz = await loadOwnQuiz(ctx, str(ctx.params, 'quizId'))
  const v = validateQuestion(ctx.params)
  if (!v.ok) fail('invalid', v.error)
  const { prompt, choices, timeLimitSec, correctIndex } = v.value

  const existingId = typeof ctx.params.questionId === 'string' ? ctx.params.questionId : ''
  if (existingId) {
    // Edit: the question must belong to this quiz and this host.
    const q = await ctx.store.get<Question>('questions', existingId)
    if (!q || q.data.quizId !== quiz.recordId || q.data.hostId !== ctx.callerId) {
      fail('not_found', 'Question not found in this quiz')
    }
    await must(ctx.store.update('questions', existingId, { prompt, choices, timeLimitSec }, ctx.callerId), 'update the question')
    const [key] = await ctx.store.query<AnswerKey>('answerKeys', { questionId: existingId })
    if (key) {
      await must(ctx.store.update('answerKeys', key.recordId, { correctIndex }, ctx.callerId), 'update the answer key')
    } else {
      await must(
        ctx.store.create('answerKeys', { questionId: existingId, correctIndex, hostId: ctx.callerId }, ctx.callerId),
        'save the answer key',
      )
    }
    return { questionId: existingId }
  }

  const order = (await ctx.store.query<Question>('questions', { quizId: quiz.recordId })).length
  const questionId = await must(
    ctx.store.create(
      'questions',
      { quizId: quiz.recordId, order, prompt, choices, timeLimitSec, hostId: ctx.callerId },
      ctx.callerId,
    ),
    'save the question',
  )
  const key = await ctx.store.create(
    'answerKeys',
    { questionId, correctIndex, hostId: ctx.callerId },
    ctx.callerId,
  )
  if (!key.ok) {
    // Never leave a question without its key.
    await ctx.store.remove('questions', questionId, ctx.callerId)
    fail('write_failed', `Could not save the answer key: ${key.error}`)
  }
  return { questionId, order }
}

async function createGame(ctx: OpContext) {
  const quiz = await loadOwnQuiz(ctx, str(ctx.params, 'quizId'))
  const qs = await quizQuestions(ctx, quiz.recordId)
  if (qs.length === 0) fail('invalid', 'Add at least one question first')

  const nextCode = ctx.joinCode ?? (() => makeJoinCode())
  let code = ''
  for (let i = 0; i < 20 && !code; i++) {
    const candidate = nextCode()
    if ((await ctx.store.query<Game>('games', { code: candidate })).length === 0) code = candidate
  }
  if (!code) fail('write_failed', 'Could not find a free join code, try again')

  const gameId = ctx.newId()
  await must(
    ctx.store.create(
      'games',
      {
        quizId: quiz.recordId,
        hostId: ctx.callerId,
        code,
        state: 'lobby',
        currentIndex: -1,
        revealedIndex: -1,
        teamId: gameId,
        currentQuestion: null,
        answeredCount: 0,
      },
      ctx.callerId,
      gameId,
    ),
    'create the game',
  )
  await must(
    ctx.store.create('team_members', { teamId: gameId, userId: ctx.callerId, status: 'active' }, ctx.callerId),
    'add the host to the game',
  )
  return { gameId, code, questionCount: qs.length }
}

async function joinGame(ctx: OpContext) {
  const code = normalizeJoinCode(ctx.params.code)
  if (!code) fail('invalid', 'Enter the 6-character code')
  const nick = validateNickname(ctx.params.nickname)
  if (!nick.ok) fail('invalid', nick.error)
  const nickname = (nick as { value: string }).value

  const [game] = await ctx.store.query<Game>('games', { code: code! })
  if (!game) fail('not_found', 'No game with that code')
  if (game!.data.state === 'ended') fail('game_ended', 'That game has ended')
  if (game!.data.state !== 'lobby' && game!.data.state !== 'question') {
    fail('not_joinable', 'Wait for the next question to join')
  }
  if (game!.data.hostId === ctx.callerId) fail('forbidden', 'The host cannot join as a player')

  const gameId = game!.recordId
  const players = await ctx.store.query<Player>('players', { gameId })
  const mine = players.find((p) => p.data.userId === ctx.callerId)
  if (mine) return { gameId, playerId: mine.recordId, nickname: mine.data.nickname, alreadyJoined: true }

  if (players.some((p) => p.data.nickname.toLowerCase() === nickname.toLowerCase())) {
    fail('nickname_taken', 'Someone already has that nickname')
  }

  const playerId = await must(
    ctx.store.create('players', { gameId, userId: ctx.callerId, nickname, score: 0 }, ctx.callerId),
    'join the game',
  )
  const membership = await ctx.store.query('team_members', { teamId: gameId, userId: ctx.callerId })
  if (membership.length === 0) {
    await must(
      ctx.store.create('team_members', { teamId: gameId, userId: ctx.callerId, status: 'active' }, ctx.callerId),
      'join the game',
    )
  }
  return { gameId, playerId, nickname, alreadyJoined: false }
}

async function startQuestion(ctx: OpContext) {
  const game = await loadHostGame(ctx)
  if (game.data.state !== 'lobby') fail('bad_state', 'The game has already started')
  return beginQuestion(ctx, game, 0)
}

async function submitAnswer(ctx: OpContext) {
  // receivedAt is the server's time at the moment this op runs.
  const receivedAt = ctx.now()
  const game = await loadGame(ctx)
  const gameId = game.recordId

  const [player] = await ctx.store.query<Player>('players', { gameId, userId: ctx.callerId })
  if (!player) fail('not_in_game', 'Join the game first')

  // ── Deadline check ──
  if (game.data.state !== 'question' || !game.data.currentQuestion) {
    fail('not_accepting', 'This question is closed')
  }
  if (typeof game.data.endsAt !== 'number' || receivedAt >= game.data.endsAt) {
    fail('too_late', "Time's up")
  }

  const live = game.data.currentQuestion!
  const choice = ctx.params.choice
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= live.choices.length) {
    fail('invalid', 'Pick one of the choices')
  }

  // ── One-answer check ── (the schema's uniqueOn is the backstop)
  const questionId = live.questionId
  const prior = await ctx.store.query<Answer>('answers', { gameId, questionId, userId: ctx.callerId })
  if (prior.length > 0) fail('already_answered', 'You already answered this question')
  const created = await ctx.store.create(
    'answers',
    { gameId, questionId, userId: ctx.callerId, choice, receivedAt },
    ctx.callerId,
  )
  if (!created.ok) {
    if (/duplicate/i.test(created.error)) fail('already_answered', 'You already answered this question')
    fail('write_failed', `Could not save your answer: ${created.error}`)
  }

  // Exact count: recomputed, not incremented, and nothing else runs meanwhile.
  const answeredCount = (await ctx.store.query<Answer>('answers', { gameId, questionId })).length
  await must(ctx.store.update('games', gameId, { answeredCount }, ctx.callerId), 'update the answer count')

  // No hint of correctness here; that only arrives with the reveal.
  return { accepted: true, receivedAt }
}

async function reveal(ctx: OpContext) {
  const game = await loadHostGame(ctx)
  if (game.data.state !== 'question' || !game.data.currentQuestion) {
    fail('bad_state', 'There is no live question to reveal')
  }
  const gameId = game.recordId
  const live = game.data.currentQuestion!
  const [key] = await ctx.store.query<AnswerKey>('answerKeys', { questionId: live.questionId })
  if (!key) fail('missing_answer_key', 'This question has no answer key')
  const correctIndex = key!.data.correctIndex

  // Closing early locks the window at reveal time.
  const now = ctx.now()
  const endsAt = Math.min(game.data.endsAt ?? now, now)

  // 1. Points on this question's answers.
  const answers = await ctx.store.query<Answer>('answers', { gameId, questionId: live.questionId })
  let correctCount = 0
  for (const a of answers) {
    const correct = a.data.choice === correctIndex
    if (correct) correctCount++
    const points = scoreAnswer({
      correct,
      receivedAt: a.data.receivedAt,
      endsAt: game.data.endsAt ?? endsAt,
      timeLimitSec: live.timeLimitSec,
    })
    await must(ctx.store.update('answers', a.recordId, { points }, ctx.callerId), 'score an answer')
  }

  // 2. Scores recomputed from all scored answers: idempotent, never double-counts.
  const totals = new Map<string, number>()
  for (const a of await ctx.store.query<Answer>('answers', { gameId })) {
    totals.set(a.data.userId, (totals.get(a.data.userId) ?? 0) + (a.data.points ?? 0))
  }
  for (const p of await ctx.store.query<Player>('players', { gameId })) {
    const score = totals.get(p.data.userId) ?? 0
    if (score !== p.data.score) {
      await must(ctx.store.update('players', p.recordId, { score }, ctx.callerId), 'update a score')
    }
  }

  // 3. Only now does the answer become visible to players.
  await must(
    ctx.store.update('games', gameId, { state: 'reveal', revealedIndex: correctIndex, endsAt }, ctx.callerId),
    'reveal the answer',
  )
  return { revealedIndex: correctIndex, answeredCount: answers.length, correctCount }
}

async function nextQuestion(ctx: OpContext) {
  const game = await loadHostGame(ctx)
  if (game.data.state !== 'reveal') fail('bad_state', 'Reveal the current question first')
  const next = game.data.currentIndex + 1
  const total = (await quizQuestions(ctx, game.data.quizId)).length
  if (next >= total) {
    await must(ctx.store.update('games', game.recordId, { state: 'ended' }, ctx.callerId), 'end the game')
    return { ended: true }
  }
  return { ended: false, ...(await beginQuestion(ctx, game, next)) }
}

async function endGame(ctx: OpContext) {
  const game = await loadHostGame(ctx)
  if (game.data.state !== 'ended') {
    await must(ctx.store.update('games', game.recordId, { state: 'ended' }, ctx.callerId), 'end the game')
  }
  return { ended: true }
}

export const OPS = {
  createQuiz,
  saveQuestion,
  createGame,
  joinGame,
  startQuestion,
  submitAnswer,
  reveal,
  nextQuestion,
  endGame,
} as const

export type OpName = keyof typeof OPS
export const OP_NAMES = Object.keys(OPS) as OpName[]

/** Never throws (a throw inside blockConcurrencyWhile resets the DO). */
export async function runOp(name: string, ctx: OpContext): Promise<OpResult> {
  try {
    if (!Object.hasOwn(OPS, name)) fail('not_found', 'Unknown action')
    if (!ctx.callerId) fail('unauthorized', 'Sign in first')
    const data = await OPS[name as OpName](ctx)
    return { success: true, data, serverNow: ctx.now() }
  } catch (err) {
    if (err instanceof OpError) {
      return { success: false, code: err.code, error: err.message, serverNow: ctx.now() }
    }
    console.error(`[quiz] ${name} failed:`, err instanceof Error ? err.message : String(err))
    return { success: false, code: 'internal', error: 'Something went wrong', serverNow: ctx.now() }
  }
}

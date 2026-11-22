import { beforeEach, describe, expect, it } from 'vitest'
import { canRead } from 'deepspace/worker'
import { quizSchemas } from '../schemas/quiz-schemas'
import { runOp, type OpResult } from './engine'
import { MemoryStore, serialized } from './test-store'

const HOST = 'user-host'
const P1 = 'user-p1'
const P2 = 'user-p2'
const OUTSIDER = 'user-outsider'

let store: MemoryStore
let clock: number
let lock: ReturnType<typeof serialized>
/** Every response each user received, for the leak test. */
let inbox: Map<string, OpResult[]>

function call(op: string, callerId: string, params: Record<string, unknown> = {}, opts?: { unlocked?: boolean }) {
  const run = () =>
    runOp(op, {
      callerId,
      params,
      store,
      now: () => clock,
      newId: () => `game-${Math.random().toString(36).slice(2, 8)}`,
    })
  const p = opts?.unlocked ? run() : lock(run)
  return p.then((r) => {
    inbox.set(callerId, [...(inbox.get(callerId) ?? []), r])
    return r
  })
}

async function ok(op: string, callerId: string, params: Record<string, unknown> = {}) {
  const r = await call(op, callerId, params)
  if (!r.success) throw new Error(`${op} failed: ${r.code} ${r.error}`)
  return r.data
}

const game = (id: string) => store.all('games').find((g) => g.recordId === id)!.data

/** Host with a 2-question quiz (correct answers: index 1, then index 0), players P1 and P2 joined. */
async function setup() {
  const { quizId } = await ok('createQuiz', HOST, { title: 'Cells' })
  await ok('saveQuestion', HOST, {
    quizId,
    prompt: 'Powerhouse of the cell?',
    choices: ['Nucleus', 'Mitochondria', 'Ribosome'],
    timeLimitSec: 20,
    correctIndex: 1,
  })
  await ok('saveQuestion', HOST, {
    quizId,
    prompt: 'DNA lives mainly in the…',
    choices: ['Nucleus', 'Membrane'],
    timeLimitSec: 10,
    correctIndex: 0,
  })
  const { gameId, code } = (await ok('createGame', HOST, { quizId })) as { gameId: string; code: string }
  await ok('joinGame', P1, { code, nickname: 'Ada' })
  await ok('joinGame', P2, { code, nickname: 'Linus' })
  return { quizId: quizId as string, gameId, code }
}

beforeEach(() => {
  store = new MemoryStore()
  clock = 1_000_000
  lock = serialized()
  inbox = new Map()
})

describe('submitAnswer: deadline', () => {
  it('accepts an answer 1 ms before endsAt and rejects one at endsAt', async () => {
    const { gameId } = await setup()
    clock = 2_000_000
    await ok('startQuestion', HOST, { gameId })
    expect(game(gameId).endsAt).toBe(2_000_000 + 20_000)

    clock = 2_000_000 + 20_000 // exactly endsAt
    const late = await call('submitAnswer', P1, { gameId, choice: 1 })
    expect(late).toMatchObject({ success: false, code: 'too_late' })

    clock = 2_000_000 + 19_999
    const inTime = await call('submitAnswer', P2, { gameId, choice: 1 })
    expect(inTime).toMatchObject({ success: true, data: { accepted: true, receivedAt: 2_019_999 } })

    expect(store.all('answers').map((a) => a.data.userId)).toEqual([P2])
    expect(game(gameId).answeredCount).toBe(1)
  })

  it('ignores any timestamp the client sends; receivedAt is server time', async () => {
    const { gameId } = await setup()
    await ok('startQuestion', HOST, { gameId })
    clock += 25_000 // past the deadline
    const r = await call('submitAnswer', P1, { gameId, choice: 1, receivedAt: 0, now: 0, endsAt: 9e15 })
    expect(r).toMatchObject({ success: false, code: 'too_late' })
  })

  it('rejects answers once the host has revealed, even before endsAt', async () => {
    const { gameId } = await setup()
    await ok('startQuestion', HOST, { gameId })
    clock += 1_000
    await ok('reveal', HOST, { gameId })
    const r = await call('submitAnswer', P1, { gameId, choice: 1 })
    expect(r).toMatchObject({ success: false, code: 'not_accepting' })
  })

  it('rejects answers in the lobby and from people who never joined', async () => {
    const { gameId } = await setup()
    expect(await call('submitAnswer', P1, { gameId, choice: 0 })).toMatchObject({ code: 'not_accepting' })
    await ok('startQuestion', HOST, { gameId })
    expect(await call('submitAnswer', OUTSIDER, { gameId, choice: 0 })).toMatchObject({ code: 'not_in_game' })
  })
})

describe('submitAnswer: one answer per player per question', () => {
  it('rejects a second answer and keeps the first one', async () => {
    const { gameId } = await setup()
    await ok('startQuestion', HOST, { gameId })
    clock += 1_000
    await ok('submitAnswer', P1, { gameId, choice: 0 })
    clock += 1_000
    const again = await call('submitAnswer', P1, { gameId, choice: 1 })
    expect(again).toMatchObject({ success: false, code: 'already_answered' })

    const answers = store.all('answers')
    expect(answers).toHaveLength(1)
    expect(answers[0].data).toMatchObject({ userId: P1, choice: 0, receivedAt: 1_001_000 })
    expect(game(gameId).answeredCount).toBe(1)
  })

  it('two simultaneous submits from one user: exactly one counts', async () => {
    const { gameId } = await setup()
    await ok('startQuestion', HOST, { gameId })
    const [a, b] = await Promise.all([
      call('submitAnswer', P1, { gameId, choice: 0 }),
      call('submitAnswer', P1, { gameId, choice: 1 }),
    ])
    expect([a.success, b.success].sort()).toEqual([false, true])
    expect([a, b].find((r) => !r.success)).toMatchObject({ code: 'already_answered' })
    expect(store.all('answers')).toHaveLength(1)
    expect(game(gameId).answeredCount).toBe(1)
  })

  it('even WITHOUT the DO lock, the schema uniqueOn keeps it to one stored answer', async () => {
    const { gameId } = await setup()
    await ok('startQuestion', HOST, { gameId })
    const results = await Promise.all(
      [0, 1, 0, 1].map((choice) => call('submitAnswer', P1, { gameId, choice }, { unlocked: true })),
    )
    expect(results.filter((r) => r.success)).toHaveLength(1)
    expect(store.all('answers')).toHaveLength(1)
  })

  it('answeredCount is exact when many players answer at once', async () => {
    const { gameId, code } = await setup()
    const extra = Array.from({ length: 10 }, (_, i) => `user-x${i}`)
    for (const [i, u] of extra.entries()) await ok('joinGame', u, { code, nickname: `X${i}` })
    await ok('startQuestion', HOST, { gameId })
    await Promise.all([P1, P2, ...extra].map((u) => call('submitAnswer', u, { gameId, choice: 1 })))
    expect(game(gameId).answeredCount).toBe(12)
  })
})

describe('host-only controls', () => {
  it('players and outsiders cannot start, reveal, advance or end the game', async () => {
    const { gameId } = await setup()
    for (const user of [P1, OUTSIDER]) {
      expect(await call('startQuestion', user, { gameId })).toMatchObject({ success: false, code: 'forbidden' })
    }
    expect(game(gameId).state).toBe('lobby')

    await ok('startQuestion', HOST, { gameId })
    for (const user of [P1, OUTSIDER]) {
      expect(await call('reveal', user, { gameId })).toMatchObject({ success: false, code: 'forbidden' })
      expect(await call('nextQuestion', user, { gameId })).toMatchObject({ success: false, code: 'forbidden' })
      expect(await call('endGame', user, { gameId })).toMatchObject({ success: false, code: 'forbidden' })
    }
    expect(game(gameId)).toMatchObject({ state: 'question', revealedIndex: -1 })
  })

  it('a forged hostId or userId in the request body changes nothing', async () => {
    const { gameId } = await setup()
    const forged = { gameId, userId: HOST, hostId: HOST, callerId: HOST }
    expect(await call('startQuestion', P1, forged)).toMatchObject({ code: 'forbidden' })

    await ok('startQuestion', HOST, { gameId })
    await ok('submitAnswer', P1, { gameId, choice: 1, userId: P2 })
    expect(store.all('answers')[0].data.userId).toBe(P1)
  })

  it('only the quiz host can add questions or start a game from the quiz', async () => {
    const { quizId } = await setup()
    const q = { quizId, prompt: 'x?', choices: ['a', 'b'], timeLimitSec: 10, correctIndex: 0 }
    expect(await call('saveQuestion', P1, q)).toMatchObject({ code: 'forbidden' })
    expect(await call('createGame', P1, { quizId })).toMatchObject({ code: 'forbidden' })
  })
})

describe('the answer key never reaches a player before reveal', () => {
  /** Everything player `u` could read: the DO's own canRead over every stored row. */
  function readableBy(u: string) {
    const memberships = store.all('team_members')
    const ctx = {
      isTeamMember: (teamId: string, userId: string) =>
        memberships.some((m) => m.data.teamId === teamId && m.data.userId === userId && m.data.status === 'active'),
    }
    const out: { collection: string; data: Record<string, unknown> }[] = []
    for (const schema of quizSchemas) {
      for (const rec of store.all(schema.name)) {
        if (canRead(schema, 'member', rec, u, ctx)) out.push({ collection: schema.name, data: rec.data })
      }
    }
    return out
  }

  const KEY_FIELD = /correctIndex|answerKey/i

  function assertNoKey(u: string) {
    const readable = readableBy(u)
    expect(readable.map((r) => r.collection)).not.toContain('answerKeys')
    expect(readable.map((r) => r.collection)).not.toContain('questions')
    expect(JSON.stringify(readable)).not.toMatch(KEY_FIELD)
    expect(JSON.stringify(inbox.get(u) ?? [])).not.toMatch(KEY_FIELD)
    for (const r of readable.filter((x) => x.collection === 'games')) {
      expect(r.data.revealedIndex).toBe(-1)
      if (r.data.currentQuestion) {
        expect(Object.keys(r.data.currentQuestion as object).sort()).toEqual(
          ['choices', 'index', 'prompt', 'questionId', 'timeLimitSec', 'total'].sort(),
        )
      }
    }
  }

  it('holds in the lobby, during the question and after answering; revealedIndex appears only at reveal', async () => {
    const { gameId } = await setup()
    assertNoKey(P1)

    await ok('startQuestion', HOST, { gameId })
    assertNoKey(P1)

    clock += 2_000
    await ok('submitAnswer', P1, { gameId, choice: 0 }) // wrong
    await ok('submitAnswer', P2, { gameId, choice: 1 }) // right
    assertNoKey(P1)
    assertNoKey(P2)
    // The player's own answer row is readable, but holds no verdict yet.
    expect(readableBy(P1).find((r) => r.collection === 'answers')?.data.points).toBeUndefined()

    await ok('reveal', HOST, { gameId })
    const g = readableBy(P1).find((r) => r.collection === 'games')!.data
    expect(g).toMatchObject({ state: 'reveal', revealedIndex: 1 })

    // Next question: the reveal is cleared again before anyone answers.
    await ok('nextQuestion', HOST, { gameId })
    assertNoKey(P1)
    // The answerKeys table itself is never readable by a player, at any point.
    expect(readableBy(P1).some((r) => r.collection === 'answerKeys')).toBe(false)
    // ...while the host can read their own keys.
    expect(readableBy(HOST).filter((r) => r.collection === 'answerKeys')).toHaveLength(2)
  })

  it('outsiders who never joined cannot read the game at all', async () => {
    const { gameId } = await setup()
    await ok('startQuestion', HOST, { gameId })
    expect(readableBy(OUTSIDER)).toEqual([])
  })
})

describe('reveal and scoring', () => {
  it('scores on the server, updates the leaderboard, and runs through to the end', async () => {
    const { gameId } = await setup()
    const start = clock
    await ok('startQuestion', HOST, { gameId })
    clock = start + 5_000 // 15 s of 20 left
    await ok('submitAnswer', P1, { gameId, choice: 1 }) // right → 500 + 375
    clock = start + 6_000
    await ok('submitAnswer', P2, { gameId, choice: 2 }) // wrong → 0

    const r = await ok('reveal', HOST, { gameId })
    expect(r).toMatchObject({ revealedIndex: 1, answeredCount: 2, correctCount: 1 })
    const score = (u: string) => store.all('players').find((p) => p.data.userId === u)!.data.score
    expect(score(P1)).toBe(875)
    expect(score(P2)).toBe(0)

    // A second reveal is refused, so points can't be added twice.
    expect(await call('reveal', HOST, { gameId })).toMatchObject({ code: 'bad_state' })
    expect(score(P1)).toBe(875)

    await ok('nextQuestion', HOST, { gameId })
    expect(game(gameId)).toMatchObject({ state: 'question', currentIndex: 1, answeredCount: 0, revealedIndex: -1 })
    clock += 1_000 // 9 s of 10 left
    await ok('submitAnswer', P2, { gameId, choice: 0 }) // right → 500 + 450
    await ok('reveal', HOST, { gameId })
    expect(score(P1)).toBe(875)
    expect(score(P2)).toBe(950)

    expect(await ok('nextQuestion', HOST, { gameId })).toEqual({ ended: true, emailClaimed: true })
    expect(game(gameId).state).toBe('ended')
  })
})

describe('joining', () => {
  it('one player row per user per game; rejoining returns the same row', async () => {
    const { code } = await setup()
    const again = await ok('joinGame', P1, { code, nickname: 'Someone else' })
    expect(again).toMatchObject({ alreadyJoined: true, nickname: 'Ada' })
    expect(store.all('players').filter((p) => p.data.userId === P1)).toHaveLength(1)
    expect(store.all('team_members').filter((m) => m.data.userId === P1)).toHaveLength(1)
  })

  it('codes stop working when the game ends, and during a reveal', async () => {
    const { gameId, code } = await setup()
    await ok('startQuestion', HOST, { gameId })
    expect(await call('joinGame', 'user-late', { code, nickname: 'Late' })).toMatchObject({ success: true })
    await ok('reveal', HOST, { gameId })
    expect(await call('joinGame', 'user-later', { code, nickname: 'Later' })).toMatchObject({ code: 'not_joinable' })
    await ok('endGame', HOST, { gameId })
    expect(await call('joinGame', 'user-last', { code, nickname: 'Last' })).toMatchObject({ code: 'game_ended' })
  })

  it('rejects unknown codes, the host joining, and duplicate nicknames', async () => {
    const { code } = await setup()
    expect(await call('joinGame', OUTSIDER, { code: 'ZZZZZZ', nickname: 'Z' })).toMatchObject({ code: 'not_found' })
    expect(await call('joinGame', HOST, { code, nickname: 'Host' })).toMatchObject({ code: 'forbidden' })
    expect(await call('joinGame', OUTSIDER, { code, nickname: 'ada' })).toMatchObject({ code: 'nickname_taken' })
  })
})

describe('questions and keys', () => {
  it('saveQuestion writes the question and its key together; editing updates both', async () => {
    const { quizId } = await ok('createQuiz', HOST, { title: 'Q' })
    const { questionId } = await ok('saveQuestion', HOST, {
      quizId,
      prompt: 'Pick b',
      choices: ['a', 'b'],
      timeLimitSec: 10,
      correctIndex: 1,
    })
    expect(store.all('questions')[0].data).toMatchObject({ hostId: HOST, choices: ['a', 'b'] })
    expect(store.all('questions')[0].data).not.toHaveProperty('correctIndex')
    expect(store.all('answerKeys')[0].data).toEqual({ questionId, correctIndex: 1, hostId: HOST })

    await ok('saveQuestion', HOST, { quizId, questionId, prompt: 'Pick a', choices: ['a', 'b'], timeLimitSec: 10, correctIndex: 0 })
    expect(store.all('questions')).toHaveLength(1)
    expect(store.all('answerKeys')).toEqual([expect.objectContaining({ data: { questionId, correctIndex: 0, hostId: HOST } })])
  })

  it('invalid questions are refused and nothing is written', async () => {
    const { quizId } = await ok('createQuiz', HOST, { title: 'Q' })
    const r = await call('saveQuestion', HOST, { quizId, prompt: 'x', choices: ['a', 'b'], timeLimitSec: 10, correctIndex: 5 })
    expect(r).toMatchObject({ success: false, code: 'invalid' })
    expect(store.all('questions')).toHaveLength(0)
    expect(store.all('answerKeys')).toHaveLength(0)
  })
})

describe('every response carries serverNow', () => {
  it('on success and on failure', async () => {
    clock = 1_234_567
    const okRes = await call('createQuiz', HOST, { title: 'T' })
    const badRes = await call('startQuestion', P1, { gameId: 'nope' })
    const unknown = await call('dropTables', HOST, {})
    for (const r of [okRes, badRes, unknown]) expect(r.serverNow).toBe(1_234_567)
    expect(unknown).toMatchObject({ success: false, code: 'not_found' })
  })

  it('refuses a call with no verified caller', async () => {
    expect(await call('createQuiz', '', { title: 'T' })).toMatchObject({ success: false, code: 'unauthorized' })
  })
})

/**
 * The real endGame / nextQuestion ACTIONS (src/actions/index.ts), wired to a
 * fake record-DO stub that runs the real engine on an in-memory store under a
 * lock (like blockConcurrencyWhile). Only the email integration is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionHandler } from 'deepspace/worker'
import { runOp } from '../game/engine'
import { CALLER_HEADER, QUIZ_OP_PATH } from '../game/protocol'
import { MemoryStore, serialized } from '../game/test-store'
import { actions } from './index'
import { FROM_ADDRESS, hostEmailFromClaims } from './results-email'

const HOST = 'user-host'
const P1 = 'user-p1'
const P2 = 'user-p2'
const HOST_EMAIL = 'host@school.example'

let store: MemoryStore
let clock: number
let lock: ReturnType<typeof serialized>
let send: ReturnType<typeof vi.fn>
let env: Record<string, unknown>

function makeEnv() {
  return {
    DEEPSPACE_APP_ID: 'app_test',
    RECORD_ROOMS: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          const op = new URL(req.url).pathname.slice(QUIZ_OP_PATH.length)
          const callerId = req.headers.get(CALLER_HEADER) ?? ''
          const params = (await req.json()) as Record<string, unknown>
          const r = await lock(() => runOp(op, { callerId, params, store, now: () => clock, newId: () => `g${Math.random()}` }))
          return Response.json(r)
        },
      }),
    },
  }
}

/** Call a real action as `userId`, with the verified claims the route passes. */
function act(name: string, userId: string, params: Record<string, unknown>, claims: Record<string, unknown> = {}) {
  const handler = actions[name] as ActionHandler<never>
  return handler({
    userId,
    params,
    env: env as never,
    callerJwt: 'jwt',
    tools: { integration: send } as never,
    claims: { sub: userId, ...claims },
  } as never) as Promise<{ success: boolean; data?: Record<string, unknown>; error?: string; serverNow?: number }>
}

const game = (id: string) => store.all('games').find((g) => g.recordId === id)!.data

async function playedGame() {
  const q = await act('createQuiz', HOST, { title: 'Bio <week 3>' })
  const quizId = q.data!.quizId as string
  for (const [prompt, correctIndex] of [
    ['Powerhouse?', 0],
    ['Golgi?', 1],
  ] as const) {
    await act('saveQuestion', HOST, { quizId, prompt, choices: ['a', 'b', 'c'], timeLimitSec: 20, correctIndex })
  }
  const g = await act('createGame', HOST, { quizId })
  const gameId = g.data!.gameId as string
  await act('joinGame', P1, { code: g.data!.code, nickname: 'Ada' })
  await act('joinGame', P2, { code: g.data!.code, nickname: 'Linus' })
  await act('startQuestion', HOST, { gameId })
  clock += 2_000
  await act('submitAnswer', P1, { gameId, choice: 0 }) // right
  await act('submitAnswer', P2, { gameId, choice: 0 }) // right
  await act('reveal', HOST, { gameId })
  await act('nextQuestion', HOST, { gameId })
  clock += 2_000
  await act('submitAnswer', P1, { gameId, choice: 2 }) // wrong; Linus doesn't answer
  await act('reveal', HOST, { gameId })
  return gameId
}

beforeEach(() => {
  store = new MemoryStore()
  clock = Date.UTC(2026, 10, 21, 23, 0)
  lock = serialized()
  send = vi.fn(async () => ({ success: true, data: { id: 'email_1' } }))
  env = makeEnv()
})

describe('results email on ending a game', () => {
  it('endGame emails the host ONCE, to the verified account email, with the summary', async () => {
    const gameId = await playedGame()
    const r = await act('endGame', HOST, { gameId, timeZone: 'America/New_York' }, { email: HOST_EMAIL })
    expect(r).toMatchObject({ success: true, data: { ended: true } })
    expect(r.data).not.toHaveProperty('emailClaimed') // internal flag never reaches the client
    expect(game(gameId)).toMatchObject({ state: 'ended', resultsEmail: 'sent' })

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toBe('email/send')
    const body = send.mock.calls[0][1]
    expect(body).toMatchObject({ to: HOST_EMAIL, from: FROM_ADDRESS, subject: 'QuizLive results: Bio <week 3>' })
    expect(body.text).toContain('1. Ada:')
    expect(body.text).toContain('Q1. 100% (2/2): Powerhouse?')
    expect(body.text).toContain('Q2. 0% (0/2)  ⚠ under 50%: Golgi?')
    expect(body.html).toContain('Bio &lt;week 3&gt;')
  })

  it('a retried endGame does not send again', async () => {
    const gameId = await playedGame()
    await act('endGame', HOST, { gameId }, { email: HOST_EMAIL })
    const again = await act('endGame', HOST, { gameId }, { email: HOST_EMAIL })
    expect(again).toMatchObject({ success: true, data: { ended: true } })
    expect(send).toHaveBeenCalledOnce()
  })

  it('simultaneous endGame calls send exactly one email', async () => {
    const gameId = await playedGame()
    const rs = await Promise.all([1, 2, 3].map(() => act('endGame', HOST, { gameId }, { email: HOST_EMAIL })))
    expect(rs.every((r) => r.success)).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it('nextQuestion past the last question ends the game and sends; a later endGame does not', async () => {
    const gameId = await playedGame()
    const r = await act('nextQuestion', HOST, { gameId }, { email: HOST_EMAIL })
    expect(r).toMatchObject({ success: true, data: { ended: true } })
    await act('endGame', HOST, { gameId }, { email: HOST_EMAIL })
    expect(send).toHaveBeenCalledOnce()
  })

  it('ignores any address in the request body; only the verified claim is used', async () => {
    const gameId = await playedGame()
    await act('endGame', HOST, { gameId, to: 'attacker@evil.example', email: 'attacker@evil.example', hostEmail: 'x@evil.example' }, { email: HOST_EMAIL })
    expect(send.mock.calls[0][1].to).toBe(HOST_EMAIL)
    expect(JSON.stringify(send.mock.calls[0][1])).not.toContain('evil.example')
  })

  it('a player cannot end the game, so nothing is sent to anyone', async () => {
    const gameId = await playedGame()
    const r = await act('endGame', P1, { gameId }, { email: 'player@school.example' })
    expect(r).toMatchObject({ success: false })
    expect(send).not.toHaveBeenCalled()
    expect(game(gameId).state).toBe('reveal')
  })
})

describe('email failure never breaks ending the game', () => {
  it.each([
    ['integration error', () => vi.fn(async () => ({ success: false, error: 'provider down', code: 'provider_error' }))],
    ['integration throws', () => vi.fn(async () => { throw new Error('socket hang up') })],
  ])('%s → game ended, status "failed"', async (_n, make) => {
    send = make()
    const gameId = await playedGame()
    const r = await act('endGame', HOST, { gameId }, { email: HOST_EMAIL })
    expect(r).toMatchObject({ success: true, data: { ended: true } })
    expect(game(gameId)).toMatchObject({ state: 'ended', resultsEmail: 'failed' })
  })

  it('a hung send times out → game ended, status "failed"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      send = vi.fn(() => new Promise(() => {}))
      const gameId = await vi.waitFor(async () => {
        vi.useRealTimers()
        const id = await playedGame()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        return id
      })
      const pending = act('endGame', HOST, { gameId }, { email: HOST_EMAIL })
      await vi.advanceTimersByTimeAsync(9_000)
      vi.useRealTimers()
      expect(await pending).toMatchObject({ success: true, data: { ended: true } })
      expect(game(gameId)).toMatchObject({ state: 'ended', resultsEmail: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['no email claim', {}],
    ['a malformed email claim', { email: 'not-an-email' }],
    ['a test account', { email: 'quizlive-p1@deepspace.test' }],
  ])('%s → skipped, nothing sent, game ended', async (_n, claims) => {
    const gameId = await playedGame()
    const r = await act('endGame', HOST, { gameId }, claims)
    expect(r).toMatchObject({ success: true, data: { ended: true } })
    expect(send).not.toHaveBeenCalled()
    expect(game(gameId)).toMatchObject({ state: 'ended', resultsEmail: 'skipped' })
  })
})

describe('internal ops stay internal', () => {
  it('gameResults and markResultsEmail are not public actions', () => {
    expect(Object.keys(actions)).not.toContain('gameResults')
    expect(Object.keys(actions)).not.toContain('markResultsEmail')
  })

  it('markResultsEmail only moves on from "sending" (a late "failed" cannot overwrite "sent")', async () => {
    const gameId = await playedGame()
    await act('endGame', HOST, { gameId }, { email: HOST_EMAIL })
    const r = await lock(() => runOp('markResultsEmail', { callerId: HOST, params: { gameId, status: 'failed' }, store, now: () => clock, newId: () => 'x' }))
    expect(r).toMatchObject({ success: true, data: { updated: false, resultsEmail: 'sent' } })
    expect(game(gameId).resultsEmail).toBe('sent')
  })

  it('hostEmailFromClaims accepts only a well-formed string', () => {
    expect(hostEmailFromClaims({ email: ' a@b.co ' })).toBe('a@b.co')
    expect(hostEmailFromClaims({ email: 'a@b' })).toBeNull()
    expect(hostEmailFromClaims({ email: 'a@b.co, c@d.co' })).toBeNull()
    expect(hostEmailFromClaims({ email: ['a@b.co'] })).toBeNull()
    expect(hostEmailFromClaims(null)).toBeNull()
  })
})

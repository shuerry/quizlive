import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runOp } from '../game/engine'
import { DRAFTS_PER_HOUR } from '../game/drafts'
import { MemoryStore, serialized } from '../game/test-store'
import { runDraftQuestions, type DraftDeps } from './draft'

const HOST = 'user-host'
const OTHER = 'user-other'
const q = (n: number) => ({ prompt: `Q${n}?`, choices: ['a', 'b', 'c', 'd'], correctIndex: n % 4 })
const anthropic = (text: string) => ({ content: [{ type: 'text', text }] })

let store: MemoryStore
let clock: number
let quizId: string
const lock = serialized()

function op(name: string, callerId: string, params: Record<string, unknown>) {
  return lock(() => runOp(name, { callerId, params, store, now: () => clock, newId: () => 'id' }))
}

/** Deps wired like the real action: reserve goes through the engine; the model is mocked. */
function deps(callerId: string, callModel: DraftDeps['callModel'], timeoutMs?: number): DraftDeps {
  return {
    reserve: (id) => op('reserveDraft', callerId, { quizId: id }) as ReturnType<DraftDeps['reserve']>,
    callModel,
    timeoutMs,
  }
}
const ok = (text: string): DraftDeps['callModel'] => async () => ({ success: true, data: anthropic(text) })

beforeEach(async () => {
  store = new MemoryStore()
  clock = 10_000_000
  const r = await op('createQuiz', HOST, { title: 'Bio' })
  if (!r.success) throw new Error(r.error)
  quizId = r.data.quizId as string
})

describe('draftQuestions (mocked integration)', () => {
  it('returns validated drafts and saves nothing', async () => {
    const model = vi.fn(ok(JSON.stringify([q(1), q(2), q(3)])))
    const r = await runDraftQuestions({ quizId, notes: 'Mitochondria make ATP.', count: 3 }, deps(HOST, model))
    expect(r).toMatchObject({ success: true, data: { drafts: [q(1), q(2), q(3)], dropped: 0, remaining: DRAFTS_PER_HOUR - 1 } })
    expect(model).toHaveBeenCalledOnce()
    expect(model.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5' })
    expect(store.all('questions')).toHaveLength(0)
    expect(store.all('answerKeys')).toHaveLength(0)
  })

  it('drops invalid items and reports how many', async () => {
    const text = '```json\n' + JSON.stringify([q(1), { ...q(2), correctIndex: 9 }, { ...q(3), choices: ['a', 'a', 'b', 'c'] }]) + '\n```'
    const r = await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, ok(text)))
    expect(r).toMatchObject({ success: true, data: { drafts: [q(1)], dropped: 2 } })
  })

  it('malformed output → friendly error, nothing saved', async () => {
    const r = await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, ok('Sorry, I cannot do that.')))
    expect(r).toMatchObject({ success: false, code: 'ai_unusable' })
    expect(store.all('questions')).toHaveLength(0)
  })

  it('integration error → friendly error', async () => {
    const r = await runDraftQuestions(
      { quizId, notes: 'n', count: 3 },
      deps(HOST, async () => ({ success: false, error: 'upstream 529', code: 'provider_error' })),
    )
    expect(r).toMatchObject({ success: false, code: 'ai_failed' })
    expect((r as { error: string }).error).toMatch(/by hand/)
  })

  it('integration throwing → friendly error, no crash', async () => {
    const r = await runDraftQuestions(
      { quizId, notes: 'n', count: 3 },
      deps(HOST, async () => {
        throw new Error('socket hang up')
      }),
    )
    expect(r).toMatchObject({ success: false, code: 'ai_failed' })
  })

  it('times out', async () => {
    const r = await runDraftQuestions(
      { quizId, notes: 'n', count: 3 },
      deps(HOST, () => new Promise(() => {}), 30),
    )
    expect(r).toMatchObject({ success: false, code: 'ai_timeout' })
  })

  it('only the quiz host can draft; the model is never called otherwise', async () => {
    const model = vi.fn(ok('[]'))
    const r = await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(OTHER, model))
    expect(r).toMatchObject({ success: false, code: 'forbidden' })
    expect(model).not.toHaveBeenCalled()
  })

  it('rejects bad input before reserving or calling the model', async () => {
    const model = vi.fn(ok('[]'))
    for (const p of [
      { quizId, notes: 'x'.repeat(8001), count: 3 },
      { quizId, notes: 'n', count: 11 },
      { quizId, notes: 'n', count: 2 },
      { notes: 'n', count: 3 },
    ]) {
      expect((await runDraftQuestions(p, deps(HOST, model))).success).toBe(false)
    }
    expect(model).not.toHaveBeenCalled()
    expect(store.all('aiDraftLog')).toHaveLength(0)
  })
})

describe('rate limit: 10 drafts per user per hour', () => {
  it('the 11th request in an hour is refused without calling the model; it frees up after an hour', async () => {
    const model = vi.fn(ok(JSON.stringify([q(1), q(2), q(3)])))
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) {
      clock += 60_000
      expect((await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, model))).success).toBe(true)
    }
    const blocked = await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, model))
    expect(blocked).toMatchObject({ success: false, code: 'rate_limited' })
    expect((blocked as { error: string }).error).toMatch(/Try again in \d+ min/)
    expect(model).toHaveBeenCalledTimes(DRAFTS_PER_HOUR)

    clock += 60 * 60_000 // an hour later
    expect((await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, model))).success).toBe(true)
    // Expired rows were pruned.
    expect(store.all('aiDraftLog').length).toBeLessThanOrEqual(DRAFTS_PER_HOUR)
  })

  it('failed AI calls still count (no free retries loop on the owner bill)', async () => {
    const failing = vi.fn(async () => ({ success: false as const, error: 'x' }))
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, failing))
    const r = await runDraftQuestions({ quizId, notes: 'n', count: 3 }, deps(HOST, failing))
    expect(r).toMatchObject({ code: 'rate_limited' })
  })

  it('reserveDraft is not exposed as a public action', async () => {
    const { actions } = await import('./index')
    expect(Object.keys(actions)).not.toContain('reserveDraft')
    expect(Object.keys(actions)).toContain('draftQuestions')
  })
})

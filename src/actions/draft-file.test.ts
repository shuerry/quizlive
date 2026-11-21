import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runOp } from '../game/engine'
import { DRAFTS_PER_HOUR } from '../game/drafts'
import { makePdf } from '../game/pdf-fixture'
import { MemoryStore, serialized } from '../game/test-store'
import type { DraftDeps } from './draft'
import { runDraftFromFile } from './draft-file'

const HOST = 'user-host'
const OTHER = 'user-other'
const item = (n: number) => {
  const choices = [`a${n}`, `b${n}`, `c${n}`, `d${n}`]
  return { prompt: `Q${n}?`, choices, correctIndex: n % 4, answer: choices[n % 4] }
}
const modelOk = (n = 3) =>
  vi.fn<DraftDeps['callModel']>(async () => ({
    success: true,
    data: { content: [{ type: 'text', text: JSON.stringify(Array.from({ length: n }, (_, i) => item(i + 1))) }] },
  }))
const txt = (s: string) => new TextEncoder().encode(s)

let store: MemoryStore
let quizId: string
const lock = serialized()
const op = (name: string, callerId: string, params: Record<string, unknown>) =>
  lock(() => runOp(name, { callerId, params, store, now: () => 1_000_000, newId: () => 'id' }))

function deps(callerId: string, callModel: DraftDeps['callModel']): DraftDeps {
  return { reserve: (id) => op('reserveDraft', callerId, { quizId: id }) as ReturnType<DraftDeps['reserve']>, callModel }
}
const drafts = () => store.all('aiDraftLog').length

beforeEach(async () => {
  store = new MemoryStore()
  const r = await op('createQuiz', HOST, { title: 'Bio' })
  if (!r.success) throw new Error(r.error)
  quizId = r.data.quizId as string
})

describe('draft from file: happy paths', () => {
  it('a text PDF → drafts with a source label; the extracted text is what the model sees', async () => {
    const model = modelOk()
    const pdf = makePdf([['Mitochondria are the site of aerobic respiration.'], ['Ribosomes translate mRNA.']])
    const r = await runDraftFromFile({ quizId, count: '3', fileName: 'C:\\fakepath\\lecture3.pdf', bytes: pdf }, deps(HOST, model))
    expect(r).toMatchObject({
      success: true,
      data: { source: { name: 'lecture3.pdf', kind: 'pdf', truncated: false, pages: 2, pagesRead: 2 } },
    })
    expect((r as { data: { drafts: unknown[] } }).data.drafts).toHaveLength(3)
    const userMsg = model.mock.calls[0][0].messages[0].content
    expect(userMsg).toContain('<notes>\nMitochondria are the site of aerobic respiration.')
    expect(userMsg).toContain('Ribosomes translate mRNA.')
    expect(store.all('questions')).toHaveLength(0) // drafts only, nothing saved
  })

  it('a .txt file works the same way', async () => {
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'notes.txt', bytes: txt('Chloroplasts contain chlorophyll.') }, deps(HOST, modelOk()))
    expect(r).toMatchObject({ success: true, data: { source: { name: 'notes.txt', kind: 'txt', truncated: false } } })
  })

  it('long files are cut to 8000 characters before the model, and the label says so', async () => {
    const model = modelOk()
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'long.txt', bytes: txt('lysosome '.repeat(2000)) }, deps(HOST, model))
    expect(r).toMatchObject({ success: true, data: { source: { truncated: true } } })
    const notes = model.mock.calls[0][0].messages[0].content.match(/<notes>\n([\s\S]*)\n<\/notes>/)![1]
    expect(notes.length).toBeLessThanOrEqual(8000)
  })

  it('the file type comes from the bytes: a PDF named .txt is read as a PDF', async () => {
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'notes.txt', bytes: makePdf([['Golgi packages proteins.']]) }, deps(HOST, modelOk()))
    expect(r).toMatchObject({ success: true, data: { source: { kind: 'pdf' } } })
  })
})

describe('draft from file: friendly failures, and none of them use a draft slot', () => {
  it.each([
    ['scanned PDF', () => makePdf([null, null]), 'file_scanned', /no selectable text/],
    ['empty file', () => new Uint8Array(), 'unsupported_type', /empty/],
    ['blank text file', () => txt('   \n  '), 'file_empty', /empty/],
    ['corrupt PDF', () => makePdf([['x']]).slice(0, 50), 'file_', /PDF/],
    ['DOCX', () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...txt('word/document.xml')]), 'unsupported_type', /Export it as a PDF/],
    ['PNG renamed .pdf', () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'unsupported_type', /Images/],
  ])('%s', async (_name, make, code, message) => {
    const model = modelOk()
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'lecture.pdf', bytes: make() }, deps(HOST, model))
    expect(r.success).toBe(false)
    expect((r as { code: string }).code).toContain(code)
    expect((r as { error: string }).error).toMatch(message)
    expect(model).not.toHaveBeenCalled()
    expect(drafts()).toBe(0)
  })

  it('over 10 MB is refused before reading', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(txt('%PDF-1.4'))
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'big.pdf', bytes: big }, deps(HOST, modelOk()))
    expect(r).toMatchObject({ success: false, code: 'too_large' })
    expect(drafts()).toBe(0)
  })

  it('bad count or missing file/quiz are refused', async () => {
    const pdf = makePdf([['x']])
    for (const input of [
      { quizId, count: 11, fileName: 'a.pdf', bytes: pdf },
      { quizId, count: 'abc', fileName: 'a.pdf', bytes: pdf },
      { quizId, count: 3, fileName: 'a.pdf', bytes: null },
      { quizId: '', count: 3, fileName: 'a.pdf', bytes: pdf },
    ]) {
      expect((await runDraftFromFile(input, deps(HOST, modelOk()))).success).toBe(false)
    }
    expect(drafts()).toBe(0)
  })

  it('a model failure after a good extraction gives the AI error (and that attempt counts)', async () => {
    const failing = vi.fn<DraftDeps['callModel']>(async () => ({ success: false, error: 'upstream' }))
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'n.txt', bytes: txt('Notes') }, deps(HOST, failing))
    expect(r).toMatchObject({ success: false, code: 'ai_failed' })
    expect(drafts()).toBe(1)
  })
})

describe('draft from file: same ownership and rate limit as pasted notes', () => {
  it('only the quiz host; the model is never called for anyone else', async () => {
    const model = modelOk()
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'n.txt', bytes: txt('Notes') }, deps(OTHER, model))
    expect(r).toMatchObject({ success: false, code: 'forbidden' })
    expect(model).not.toHaveBeenCalled()
  })

  it('file and pasted-notes drafts share the 10-per-hour limit', async () => {
    const model = modelOk()
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) {
      expect((await runDraftFromFile({ quizId, count: 3, fileName: 'n.txt', bytes: txt('Notes') }, deps(HOST, model))).success).toBe(true)
    }
    const r = await runDraftFromFile({ quizId, count: 3, fileName: 'n.txt', bytes: txt('Notes') }, deps(HOST, model))
    expect(r).toMatchObject({ success: false, code: 'rate_limited' })
    expect(model).toHaveBeenCalledTimes(DRAFTS_PER_HOUR)
  })
})

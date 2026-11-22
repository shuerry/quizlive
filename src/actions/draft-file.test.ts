import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runOp } from '../game/engine'
import { DRAFTS_PER_HOUR } from '../game/drafts'
import { makePdf } from '../game/pdf-fixture'
import { MemoryStore, serialized } from '../game/test-store'
import { runDraftQuestions, type DraftDeps } from './draft'
import { runDraftFromFiles, type UploadedFile } from './draft-file'

const HOST = 'user-host'
const OTHER = 'user-other'
const txt = (s: string) => new TextEncoder().encode(s)
const file = (name: string, bytes: Uint8Array): UploadedFile => ({ name, bytes })

/** A model that returns one valid item per given source name (or plain items). */
function model(sources: (string | undefined)[] = [undefined, undefined, undefined]) {
  return vi.fn<DraftDeps['callModel']>(async () => ({
    success: true,
    data: {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            sources.map((source, i) => {
              const choices = [`a${i}`, `b${i}`, `c${i}`, `d${i}`]
              return { prompt: `Q${i}?`, choices, correctIndex: i % 4, answer: choices[i % 4], ...(source ? { source } : {}) }
            }),
          ),
        },
      ],
    },
  }))
}

let store: MemoryStore
let quizId: string
const lock = serialized()
const op = (name: string, callerId: string, params: Record<string, unknown>) =>
  lock(() => runOp(name, { callerId, params, store, now: () => 1_000_000, newId: () => 'id' }))
function deps(callerId: string, callModel: DraftDeps['callModel']): DraftDeps {
  return { reserve: (id) => op('reserveDraft', callerId, { quizId: id }) as ReturnType<DraftDeps['reserve']>, callModel }
}
const slotsUsed = () => store.all('aiDraftLog').length
const sentNotes = (m: ReturnType<typeof model>) => m.mock.calls[0][0].messages[0].content as string
const sectionOf = (notes: string, name: string) => notes.match(new RegExp(`<file name="${name.replace(/[.()]/g, '\\$&')}">\\n([\\s\\S]*?)\\n</file>`))?.[1]

beforeEach(async () => {
  store = new MemoryStore()
  const r = await op('createQuiz', HOST, { title: 'Bio' })
  if (!r.success) throw new Error(r.error)
  quizId = r.data.quizId as string
})

describe('three files at once', () => {
  const three = () => [
    file('C:\\fakepath\\week1.pdf', makePdf([['Mitochondria are the site of aerobic respiration.']])),
    file('week2.pdf', makePdf([['Ribosomes translate mRNA into proteins.']])),
    file('week3.txt', txt('Chloroplasts contain the pigment chlorophyll.')),
  ]

  it('one AI call, one rate-limit slot, labelled sections, and a source on every draft', async () => {
    const m = model(['week1.pdf', 'week2.pdf', 'week3.txt'])
    const r = await runDraftFromFiles({ quizId, count: '3', files: three() }, deps(HOST, m))
    expect(r.success).toBe(true)
    expect(m).toHaveBeenCalledOnce()
    expect(slotsUsed()).toBe(1)

    const notes = sentNotes(m)
    expect(sectionOf(notes, 'week1.pdf')).toContain('Mitochondria')
    expect(sectionOf(notes, 'week2.pdf')).toContain('Ribosomes')
    expect(sectionOf(notes, 'week3.txt')).toContain('Chloroplasts')
    const system = m.mock.calls[0][0].system
    expect(system).toContain('"source"')
    expect(system).toContain('"week1.pdf", "week2.pdf", "week3.txt"')

    const data = (r as { data: { drafts: { source?: string }[]; sources: { name: string; kind: string; truncated: boolean }[] } }).data
    expect(data.drafts.map((d) => d.source)).toEqual(['week1.pdf', 'week2.pdf', 'week3.txt'])
    expect(data.sources.map((s) => [s.name, s.kind, s.truncated])).toEqual([
      ['week1.pdf', 'pdf', false],
      ['week2.pdf', 'pdf', false],
      ['week3.txt', 'txt', false],
    ])
    expect(store.all('questions')).toHaveLength(0) // drafts only
  })

  it('a source the model made up is dropped (the draft is kept, marked unknown)', async () => {
    const r = await runDraftFromFiles({ quizId, count: 3, files: three() }, deps(HOST, model(['week1.pdf', 'secret.pdf', undefined])))
    const drafts = (r as { data: { drafts: { source?: string }[] } }).data.drafts
    expect(drafts.map((d) => d.source)).toEqual(['week1.pdf', undefined, undefined])
  })

  it('a single file is always its own source, whatever the model says', async () => {
    const r = await runDraftFromFiles({ quizId, count: 3, files: [file('only.txt', txt('Golgi packages proteins.'))] }, deps(HOST, model()))
    expect((r as { data: { drafts: { source?: string }[] } }).data.drafts.every((d) => d.source === 'only.txt')).toBe(true)
  })

  it('duplicate filenames are told apart', async () => {
    const m = model()
    const r = await runDraftFromFiles(
      { quizId, count: 3, files: [file('notes.txt', txt('First set.')), file('notes.txt', txt('Second set.'))] },
      deps(HOST, m),
    )
    expect((r as { data: { sources: { name: string }[] } }).data.sources.map((s) => s.name)).toEqual(['notes.txt', 'notes.txt (2)'])
    expect(sectionOf(sentNotes(m), 'notes.txt (2)')).toBe('Second set.')
  })
})

describe('one bad file rejects the whole request, naming it', () => {
  const good = () => [file('week1.pdf', makePdf([['Real text.']])), file('week3.txt', txt('More text.'))]

  it.each([
    ['a scanned PDF', () => makePdf([null, null]), 'file_scanned', /"scan\.pdf": This PDF has no selectable text/],
    ['a Word file', () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...txt('word/document.xml')]), 'unsupported_type', /"scan\.pdf": Word and PowerPoint/],
    ['an empty file', () => new Uint8Array(), 'unsupported_type', /"scan\.pdf": This file is empty/],
    ['a damaged PDF', () => makePdf([['x']]).slice(0, 50), 'file_', /"scan\.pdf":/],
  ])('%s among good ones', async (_n, bytes, code, message) => {
    const m = model()
    const r = await runDraftFromFiles({ quizId, count: 3, files: [...good(), file('scan.pdf', bytes())] }, deps(HOST, m))
    expect(r).toMatchObject({ success: false, file: 'scan.pdf' })
    expect((r as { code: string }).code).toContain(code)
    expect((r as { error: string }).error).toMatch(message)
    expect(m).not.toHaveBeenCalled()
    expect(slotsUsed()).toBe(0)
  })

  it('a single bad file gets the plain message, without the name prefix', async () => {
    const r = await runDraftFromFiles({ quizId, count: 3, files: [file('scan.pdf', makePdf([null]))] }, deps(HOST, model()))
    expect((r as { error: string }).error).toMatch(/^This PDF has no selectable text/)
  })
})

describe('caps', () => {
  it('more than 3 files is refused before anything is read', async () => {
    const m = model()
    const files = [1, 2, 3, 4].map((i) => file(`f${i}.txt`, txt(`File ${i}`)))
    const r = await runDraftFromFiles({ quizId, count: 3, files }, deps(HOST, m))
    expect(r).toMatchObject({ success: false, code: 'too_many_files', error: expect.stringMatching(/at most 3 files at a time \(you chose 4\)/) })
    expect(m).not.toHaveBeenCalled()
    expect(slotsUsed()).toBe(0)
  })

  it('over 10 MB in total is refused, even when each file is under 10 MB', async () => {
    const big = () => {
      const b = new Uint8Array(4 * 1024 * 1024)
      b.set(txt('%PDF-1.4'))
      return b
    }
    const r = await runDraftFromFiles({ quizId, count: 3, files: [file('a.pdf', big()), file('b.pdf', big()), file('c.pdf', big())] }, deps(HOST, model()))
    expect(r).toMatchObject({ success: false, code: 'too_large', error: expect.stringMatching(/add up to 12\.0 MB, over the 10 MB limit/) })
    expect(slotsUsed()).toBe(0)
  })

  it('no files, a bad count, or a missing quiz are refused', async () => {
    for (const input of [
      { quizId, count: 3, files: [] },
      { quizId, count: 11, files: [file('a.txt', txt('x'))] },
      { quizId: '', count: 3, files: [file('a.txt', txt('x'))] },
    ]) {
      expect((await runDraftFromFiles(input, deps(HOST, model()))).success).toBe(false)
    }
  })
})

describe('the 8000-character budget is shared', () => {
  const words = (n: number, w: string) => txt(`${w} `.repeat(Math.ceil(n / (w.length + 1))).slice(0, n))

  it('a short file keeps all its text; the two long ones split the rest evenly', async () => {
    const m = model()
    const r = await runDraftFromFiles(
      {
        quizId,
        count: 3,
        files: [file('short.txt', words(1000, 'golgi')), file('long-a.txt', words(9000, 'ribosome')), file('long-b.txt', words(9000, 'nucleus'))],
      },
      deps(HOST, m),
    )
    const sources = (r as { data: { sources: { name: string; chars: number; truncated: boolean }[] } }).data.sources
    const byName = Object.fromEntries(sources.map((s) => [s.name, s]))
    expect(byName['short.txt']).toMatchObject({ truncated: false })
    expect(byName['short.txt'].chars).toBeGreaterThan(990)
    for (const n of ['long-a.txt', 'long-b.txt']) {
      expect(byName[n].truncated).toBe(true)
      expect(byName[n].chars).toBeGreaterThan(3400) // ~ (8000 − 1000) / 2, minus a word boundary
      expect(byName[n].chars).toBeLessThanOrEqual(3500)
    }
    expect(sources.reduce((t, s) => t + s.chars, 0)).toBeLessThanOrEqual(8000)
    // Every file is in the prompt: none silently dropped.
    const notes = sentNotes(m)
    for (const n of ['short.txt', 'long-a.txt', 'long-b.txt']) expect(sectionOf(notes, n)?.length).toBeGreaterThan(0)
  })

  it('three long files get a third each', async () => {
    const r = await runDraftFromFiles(
      { quizId, count: 3, files: ['a', 'b', 'c'].map((n) => file(`${n}.txt`, words(10_000, n.repeat(4)))) },
      deps(HOST, model()),
    )
    const sources = (r as { data: { sources: { chars: number; truncated: boolean }[] } }).data.sources
    for (const s of sources) {
      expect(s.truncated).toBe(true)
      expect(s.chars).toBeGreaterThan(2600)
      expect(s.chars).toBeLessThanOrEqual(2666)
    }
  })

  it('files that fit are not truncated at all', async () => {
    const r = await runDraftFromFiles(
      { quizId, count: 3, files: [file('a.txt', words(2000, 'aa')), file('b.pdf', makePdf([['Short PDF text.']]))] },
      deps(HOST, model()),
    )
    expect((r as { data: { sources: { truncated: boolean }[] } }).data.sources.every((s) => !s.truncated)).toBe(true)
  })
})

describe('same ownership and rate limit as pasted notes', () => {
  it('only the quiz host; the model is never called for anyone else', async () => {
    const m = model()
    const r = await runDraftFromFiles({ quizId, count: 3, files: [file('n.txt', txt('Notes'))] }, deps(OTHER, m))
    expect(r).toMatchObject({ success: false, code: 'forbidden' })
    expect(m).not.toHaveBeenCalled()
  })

  it('a 3-file request uses ONE of the 10 hourly slots, shared with pasted notes', async () => {
    const m = model()
    const files = () => [file('a.txt', txt('A')), file('b.txt', txt('B')), file('c.txt', txt('C'))]
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) {
      expect((await runDraftFromFiles({ quizId, count: 3, files: files() }, deps(HOST, m))).success).toBe(true)
    }
    expect(slotsUsed()).toBe(DRAFTS_PER_HOUR)
    const r = await runDraftFromFiles({ quizId, count: 3, files: files() }, deps(HOST, m))
    expect(r).toMatchObject({ success: false, code: 'rate_limited' })
  })

  it('a model failure after good extraction gives the AI error (and that attempt counts)', async () => {
    const failing = vi.fn<DraftDeps['callModel']>(async () => ({ success: false, error: 'upstream' }))
    const r = await runDraftFromFiles({ quizId, count: 3, files: [file('n.txt', txt('Notes'))] }, deps(HOST, failing))
    expect(r).toMatchObject({ success: false, code: 'ai_failed' })
    expect(slotsUsed()).toBe(1)
  })

  it('pasted notes cannot smuggle in sources or a bigger limit through request params', async () => {
    const m = model()
    await runDraftQuestions({ quizId, notes: 'Notes', count: 3, sources: ['evil.pdf'], notesMax: 1e9 }, deps(HOST, m))
    expect(m.mock.calls[0][0].system).not.toContain('evil.pdf')
    const r = await runDraftQuestions({ quizId, notes: 'x'.repeat(8001), count: 3, notesMax: 1e9 }, deps(HOST, m))
    expect(r).toMatchObject({ success: false, code: 'invalid' })
  })
})

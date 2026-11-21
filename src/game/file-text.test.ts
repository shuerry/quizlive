import { describe, expect, it } from 'vitest'
import {
  displayName,
  extractPdf,
  extractTxt,
  ExtractError,
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
  sniffFileType,
} from './file-text'
import { makePdf } from './pdf-fixture'

const bytes = (...xs: number[]) => new Uint8Array(xs)
const text = (s: string) => new TextEncoder().encode(s)
const withHead = (head: number[] | string, rest = 'payload') =>
  new Uint8Array([...(typeof head === 'string' ? text(head) : head), ...text(rest)])

describe('sniffFileType: decided by bytes, not by name', () => {
  it('recognises PDFs, including a header after a little junk', () => {
    expect(sniffFileType(makePdf([['hi']]))).toEqual({ kind: 'pdf' })
    expect(sniffFileType(withHead('\n\n%PDF-1.7\n'))).toEqual({ kind: 'pdf' })
  })

  it('recognises UTF-8 text, with or without a BOM, accents and emoji', () => {
    expect(sniffFileType(text('Mitochondria make ATP.'))).toEqual({ kind: 'txt' })
    expect(sniffFileType(new Uint8Array([0xef, 0xbb, 0xbf, ...text('Café 🧬')]))).toEqual({ kind: 'txt' })
  })

  it('accepts a large text file whose sample window splits a multi-byte character', () => {
    const big = text('é'.repeat(200_000)) // 400 KB; the 256 KB sample ends mid-character half the time
    expect(sniffFileType(big)).toEqual({ kind: 'txt' })
    expect(sniffFileType(text('a' + 'é'.repeat(200_000)))).toEqual({ kind: 'txt' })
  })

  it.each([
    ['DOCX (zip with word/)', withHead([0x50, 0x4b, 0x03, 0x04], '....[Content_Types].xml....word/document.xml'), /Export it as a PDF/],
    ['PPTX (zip with ppt/)', withHead([0x50, 0x4b, 0x03, 0x04], '....ppt/presentation.xml'), /Export it as a PDF/],
    ['legacy .doc/.ppt (OLE2)', withHead([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), /Export it as a PDF/],
    ['a plain zip', withHead([0x50, 0x4b, 0x03, 0x04], 'notes.txt'), /ZIP files are not supported/],
    ['PNG', withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), /Images are not supported/],
    ['JPEG', withHead([0xff, 0xd8, 0xff, 0xe0]), /Images are not supported/],
    ['HEIC', withHead([0, 0, 0, 0x18, ...text('ftypheic')]), /Images are not supported/],
    ['binary with NUL bytes', bytes(1, 2, 0, 3, 4), /not supported/],
    ['invalid UTF-8', bytes(0x66, 0x6f, 0xff, 0xfe, 0x6f), /not supported/],
    ['an empty file', bytes(), /empty/],
  ])('rejects %s', (_name, b, message) => {
    const r = sniffFileType(b)
    expect(r.kind).toBe('unsupported')
    expect((r as { reason: string }).reason).toMatch(message)
  })

  it('a PNG renamed to .pdf is still a PNG (the name is never consulted)', () => {
    // sniffFileType takes bytes only; there is no way to pass the name.
    expect(sniffFileType.length).toBe(1)
    expect(sniffFileType(withHead([0x89, 0x50, 0x4e, 0x47]))).toMatchObject({ kind: 'unsupported' })
  })
})

describe('extractTxt', () => {
  it('decodes, strips a BOM and tidies whitespace', () => {
    const r = extractTxt(new Uint8Array([0xef, 0xbb, 0xbf, ...text('Line one\r\n\r\n\r\n\r\nLine\t\ttwo   end  ')]))
    expect(r).toEqual({ text: 'Line one\n\nLine two end', truncated: false })
  })

  it('truncates to 8000 characters, on a word boundary when possible', () => {
    const r = extractTxt(text('word '.repeat(3000)))
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(r.text.endsWith('word')).toBe(true)
  })

  it('an all-whitespace file is "empty"', () => {
    expect(() => extractTxt(text(' \n\t \n'))).toThrow(ExtractError)
    try {
      extractTxt(text('   '))
    } catch (e) {
      expect((e as ExtractError).code).toBe('empty')
    }
  })
})

describe('extractPdf (real unpdf, generated PDFs)', () => {
  it('reads the text of every page in order', async () => {
    const r = await extractPdf(makePdf([['Page one: mitochondria make ATP.'], ['Page two: ribosomes make proteins.']]))
    expect(r.text).toContain('Page one: mitochondria make ATP.')
    expect(r.text.indexOf('Page one')).toBeLessThan(r.text.indexOf('Page two'))
    expect(r).toMatchObject({ truncated: false, pages: 2, pagesRead: 2 })
  })

  it('stops reading pages once it has 8000 characters, and truncates', async () => {
    const line = 'The nucleus stores DNA inside a double membrane called the nuclear envelope.'
    const page = Array.from({ length: 50 }, () => line) // ~3,800 chars per page
    const r = await extractPdf(makePdf(Array.from({ length: 20 }, () => page)))
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(r.pages).toBe(20)
    expect(r.pagesRead).toBe(3)
  })

  it('a scanned (image-only) PDF gets the friendly "no selectable text" error', async () => {
    await expect(extractPdf(makePdf([null, null, null]))).rejects.toMatchObject({
      code: 'scanned',
      message: expect.stringMatching(/no selectable text/),
    })
  })

  it('never walks more than 60 pages looking for text', async () => {
    const pages: (string[] | null)[] = Array.from({ length: MAX_PDF_PAGES + 5 }, () => null)
    pages[MAX_PDF_PAGES + 2] = ['Text that sits past the page limit']
    await expect(extractPdf(makePdf(pages))).rejects.toMatchObject({ code: 'scanned' })
  })

  it('finds text after some image-only pages (e.g. a scanned cover page)', async () => {
    const r = await extractPdf(makePdf([null, ['Real notes on page two.']]))
    expect(r.text).toBe('Real notes on page two.')
  })

  it.each([
    ['a header and nothing else', text('%PDF-1.4\n')],
    ['a truncated file', makePdf([['hello']]).slice(0, 60)],
    ['random bytes after the header', withHead('%PDF-1.7\n', '\u0001\u0002garbage'.repeat(50))],
  ])('a damaged PDF (%s) gets the friendly "corrupt" error, never a crash', async (_name, b) => {
    await expect(extractPdf(b)).rejects.toMatchObject({ code: expect.stringMatching(/corrupt|scanned|empty/) })
    await expect(extractPdf(b)).rejects.toBeInstanceOf(ExtractError)
  })
})

describe('displayName', () => {
  it('strips paths and control characters and shortens long names', () => {
    expect(displayName('C:\\Users\\me\\lecture 3.pdf')).toBe('lecture 3.pdf')
    expect(displayName('../../etc/passwd')).toBe('passwd')
    expect(displayName('a\u0000b.pdf')).toBe('ab.pdf')
    expect(displayName('x'.repeat(200) + '.pdf').length).toBeLessThanOrEqual(80)
    expect(displayName(undefined)).toBe('uploaded file')
  })
})

/**
 * Uploaded file → plain text, in the worker, in memory. Nothing is stored.
 *
 * The type comes from the file's BYTES (magic numbers), never from the
 * extension or the browser's declared type. Tonight: PDF and UTF-8 text.
 * Office files get a clear "export as PDF" message.
 */

import { getDocumentProxy } from 'unpdf'

/** Per request, across all files. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 3
export const MAX_TEXT_CHARS = 8000
/** Never walk more pages than this, even if they hold no text (image-only PDFs). */
export const MAX_PDF_PAGES = 60

export type SniffResult =
  | { kind: 'pdf' }
  | { kind: 'txt' }
  | { kind: 'unsupported'; reason: string }

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)

function asciiWindow(b: Uint8Array, n: number): string {
  let s = ''
  for (let i = 0; i < Math.min(n, b.length); i++) s += String.fromCharCode(b[i])
  return s
}

const EXPORT_AS_PDF = 'Word and PowerPoint files are not supported yet. Export it as a PDF (File → Save as PDF) and upload that.'

export function sniffFileType(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { kind: 'unsupported', reason: 'This file is empty.' }

  // PDF: the spec allows the %PDF- header anywhere in the first 1024 bytes.
  if (asciiWindow(bytes, 1024).includes('%PDF-')) return { kind: 'pdf' }

  // ZIP containers: modern Office files.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const head = asciiWindow(bytes, 64 * 1024)
    if (/word\/|ppt\/|xl\//.test(head) || head.includes('[Content_Types].xml')) {
      return { kind: 'unsupported', reason: EXPORT_AS_PDF }
    }
    return { kind: 'unsupported', reason: 'ZIP files are not supported. Upload a PDF or a .txt file.' }
  }
  // OLE2: legacy .doc / .ppt / .xls.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { kind: 'unsupported', reason: EXPORT_AS_PDF }
  }
  // Images (a phone photo of notes is a common mistake).
  if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) || // GIF
    asciiWindow(bytes, 16).slice(4, 8) === 'ftyp' || // HEIC/MP4
    (asciiWindow(bytes, 4) === 'RIFF' && asciiWindow(bytes, 12).slice(8) === 'WEBP')
  ) {
    return { kind: 'unsupported', reason: 'Images are not supported. Upload a PDF or a .txt file, or paste the text.' }
  }

  // Plain text: valid UTF-8 with no NUL bytes.
  const sample = bytes.subarray(0, 256 * 1024)
  if (sample.includes(0)) return { kind: 'unsupported', reason: 'This file type is not supported. Upload a PDF or a .txt file.' }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < bytes.length ? trimPartialUtf8(sample) : sample)
    return { kind: 'txt' }
  } catch {
    return { kind: 'unsupported', reason: 'This file type is not supported. Upload a PDF or a .txt file.' }
  }
}

/** Drop a UTF-8 sequence cut in half at the end of a sample. */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let end = b.length
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]
    if ((c & 0xc0) !== 0x80) {
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1
      if (need > i) end -= i
      break
    }
  }
  return b.subarray(0, end)
}

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface Extracted {
  text: string
  /** True when the text was cut to MAX_TEXT_CHARS. */
  truncated: boolean
  /** PDFs: total pages in the document, and how many were read. */
  pages?: number
  pagesRead?: number
}

export class ExtractError extends Error {
  constructor(
    public code: 'empty' | 'scanned' | 'corrupt' | 'encrypted',
    message: string,
  ) {
    super(message)
  }
}

export function cutText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  // Prefer ending on a word boundary.
  const slice = text.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  return { text: (lastSpace > max * 0.9 ? slice.slice(0, lastSpace) : slice).trim(), truncated: true }
}

export function extractTxt(bytes: Uint8Array, maxChars = MAX_TEXT_CHARS): Extracted {
  const raw = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  const text = normalizeText(raw)
  if (!text) throw new ExtractError('empty', 'This text file is empty.')
  return cutText(text, maxChars)
}

/**
 * Text of a PDF's pages in order, stopping as soon as there is enough
 * (maxChars), and never reading more than maxPages pages.
 */
export async function extractPdf(bytes: Uint8Array, maxChars = MAX_TEXT_CHARS, maxPages = MAX_PDF_PAGES): Promise<Extracted> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // PDF.js takes ownership of the buffer, so give it a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes))
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
    if (name === 'PasswordException') {
      throw new ExtractError('encrypted', 'This PDF is password-protected. Remove the password and upload it again.')
    }
    throw new ExtractError('corrupt', "Couldn't read this PDF. It may be damaged. Try exporting it again.")
  }

  const parts: string[] = []
  let chars = 0
  let pagesRead = 0
  try {
    const last = Math.min(pdf.numPages, maxPages)
    for (let i = 1; i <= last && chars < maxChars; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if ('str' in item) pageText += item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ')
      }
      const norm = normalizeText(pageText)
      if (norm) {
        parts.push(norm)
        chars += norm.length + 2
      }
      pagesRead = i
    }
  } catch {
    if (parts.length === 0) {
      throw new ExtractError('corrupt', "Couldn't read this PDF. It may be damaged. Try exporting it again.")
    }
    // Keep what was read before the damaged page.
  }

  const text = parts.join('\n\n')
  if (!text) {
    throw new ExtractError(
      pdf.numPages === 0 ? 'empty' : 'scanned',
      pdf.numPages === 0
        ? 'This PDF has no pages.'
        : 'This PDF has no selectable text (it looks scanned or made of images). Paste the text instead, or upload a PDF exported from the original document.',
    )
  }
  return { ...cutText(text, maxChars), pages: pdf.numPages, pagesRead }
}

/** Strip any path, keep it short, for display only. */
export function displayName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  const base = s.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!clean) return 'uploaded file'
  return clean.length > 80 ? `${clean.slice(0, 60)}…${clean.slice(-15)}` : clean
}

/**
 * Share `total` characters across files whose texts have these lengths, as
 * evenly as possible: a file shorter than its equal share keeps all of its
 * text, and what it doesn't use is shared among the others ("water-filling").
 * Every file with text gets something, so none is silently dropped.
 */
export function allocateBudget(lengths: number[], total = MAX_TEXT_CHARS): number[] {
  const out = new Array<number>(lengths.length).fill(0)
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len)
  let remaining = total
  order.forEach(({ len, i }, k) => {
    const share = Math.floor(remaining / (order.length - k))
    out[i] = Math.min(len, share)
    remaining -= out[i]
  })
  return out
}

/** Make display names unique: "notes.pdf", "notes.pdf (2)". */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = n.toLowerCase()
    const c = (seen.get(k) ?? 0) + 1
    seen.set(k, c)
    return c === 1 ? n : `${n} (${c})`
  })
}

/**
 * Draft questions from an uploaded PDF or .txt file.
 *
 * Order matters:
 *   1. size + real type (magic bytes) checks,
 *   2. text extraction in memory (free; nothing stored),
 *   3. truncate to 8000 characters,
 *   4. the SAME runDraftQuestions pipeline as pasted notes: reserveDraft
 *      (ownership + rate limit, inside the DO lock), the AI call outside the
 *      lock, validation and the answer check.
 * Extracting before reserving means an unreadable file never uses up one of
 * the host's 10 hourly drafts. The bytes are dropped when the request ends.
 */

import { COUNT_MAX, COUNT_MIN } from '../game/drafts'
import {
  displayName,
  extractPdf,
  extractTxt,
  ExtractError,
  MAX_UPLOAD_BYTES,
  sniffFileType,
  type Extracted,
} from '../game/file-text'
import { runDraftQuestions, type DraftDeps, type DraftResult } from './draft'

export interface DraftSource {
  name: string
  kind: 'pdf' | 'txt'
  chars: number
  truncated: boolean
  pages?: number
  pagesRead?: number
}

export type DraftFromFileResult =
  | (Extract<DraftResult, { success: true }> & { data: Extract<DraftResult, { success: true }>['data'] & { source: DraftSource } })
  | { success: false; error: string; code: string; serverNow?: number }

export async function runDraftFromFile(
  input: { quizId: unknown; count: unknown; fileName: unknown; bytes: Uint8Array | null },
  deps: DraftDeps,
): Promise<DraftFromFileResult> {
  if (typeof input.quizId !== 'string' || !input.quizId) return { success: false, code: 'bad_request', error: 'Missing quizId' }
  const count = typeof input.count === 'string' ? Number(input.count) : input.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < COUNT_MIN || count > COUNT_MAX) {
    return { success: false, code: 'invalid', error: `Ask for ${COUNT_MIN}–${COUNT_MAX} questions` }
  }
  const bytes = input.bytes
  if (!bytes) return { success: false, code: 'invalid', error: 'Choose a file to upload' }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { success: false, code: 'too_large', error: `That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Upload a smaller PDF or paste the text.` }
  }

  const name = displayName(input.fileName)
  const sniff = sniffFileType(bytes)
  if (sniff.kind === 'unsupported') return { success: false, code: 'unsupported_type', error: sniff.reason }

  let extracted: Extracted
  try {
    extracted = sniff.kind === 'pdf' ? await extractPdf(bytes) : extractTxt(bytes)
  } catch (err) {
    if (err instanceof ExtractError) return { success: false, code: `file_${err.code}`, error: err.message }
    deps.log?.(`[draft-file] extraction failed: ${err instanceof Error ? err.message : String(err)}`)
    return { success: false, code: 'file_corrupt', error: "Couldn't read this file. Try exporting it again, or paste the text." }
  }

  const r = await runDraftQuestions({ quizId: input.quizId, notes: extracted.text, count }, deps)
  if (!r.success) return r
  return {
    ...r,
    data: {
      ...r.data,
      source: {
        name,
        kind: sniff.kind,
        chars: extracted.text.length,
        truncated: extracted.truncated,
        pages: extracted.pages,
        pagesRead: extracted.pagesRead,
      },
    },
  }
}

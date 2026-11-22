/**
 * Draft questions from up to 3 uploaded PDF / .txt files.
 *
 * Order matters:
 *   1. count (≤ 3) and total size (≤ 10 MB) checks,
 *   2. per file: real type from magic bytes, then text extraction in memory.
 *      Any bad file (wrong type, scanned, empty, corrupt) rejects the WHOLE
 *      request with a message naming that file, so no file is silently left out,
 *   3. the 8000-character budget shared across the files (allocateBudget):
 *      a short file keeps all its text, and the rest is split among the others,
 *   4. ONE call to the same runDraftQuestions pipeline: one reserveDraft
 *      (ownership + one rate-limit slot, inside the DO lock), one AI call
 *      outside the lock, validation, answer check, plus a per-question source.
 * Extracting before reserving means unreadable files never use up a draft.
 * The bytes are dropped when the request ends; nothing is stored.
 */

import { buildFileNotes, COUNT_MAX, COUNT_MIN, FILE_NOTES_OVERHEAD } from '../game/drafts'
import {
  allocateBudget,
  cutText,
  displayName,
  extractPdf,
  extractTxt,
  ExtractError,
  MAX_FILES,
  MAX_TEXT_CHARS,
  MAX_UPLOAD_BYTES,
  sniffFileType,
  uniqueNames,
  type Extracted,
} from '../game/file-text'
import { runDraftQuestions, type DraftDeps, type DraftResult } from './draft'

export interface DraftSource {
  name: string
  kind: 'pdf' | 'txt'
  /** Characters of this file sent to the model. */
  chars: number
  /** True when this file had more text than its share of the budget. */
  truncated: boolean
  pages?: number
  pagesRead?: number
}

type Success = Extract<DraftResult, { success: true }>
export type DraftFromFilesResult =
  | (Success & { data: Success['data'] & { sources: DraftSource[] } })
  | { success: false; error: string; code: string; file?: string; serverNow?: number }

export interface UploadedFile {
  name: unknown
  bytes: Uint8Array
}

const MB = 1024 * 1024
const fmtMB = (b: number) => `${(b / MB).toFixed(1)} MB`

export async function runDraftFromFiles(
  input: { quizId: unknown; count: unknown; files: UploadedFile[] },
  deps: DraftDeps,
): Promise<DraftFromFilesResult> {
  if (typeof input.quizId !== 'string' || !input.quizId) return { success: false, code: 'bad_request', error: 'Missing quizId' }
  const count = typeof input.count === 'string' ? Number(input.count) : input.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < COUNT_MIN || count > COUNT_MAX) {
    return { success: false, code: 'invalid', error: `Ask for ${COUNT_MIN}–${COUNT_MAX} questions` }
  }

  const files = input.files
  if (files.length === 0) return { success: false, code: 'invalid', error: 'Choose a file to upload' }
  if (files.length > MAX_FILES) {
    return { success: false, code: 'too_many_files', error: `Upload at most ${MAX_FILES} files at a time (you chose ${files.length}).` }
  }
  const total = files.reduce((n, f) => n + f.bytes.byteLength, 0)
  if (total > MAX_UPLOAD_BYTES) {
    return {
      success: false,
      code: 'too_large',
      error:
        files.length === 1
          ? `That file is over ${MAX_UPLOAD_BYTES / MB} MB. Upload a smaller PDF or paste the text.`
          : `These files add up to ${fmtMB(total)}, over the ${MAX_UPLOAD_BYTES / MB} MB limit. Upload fewer or smaller files.`,
    }
  }

  const names = uniqueNames(files.map((f) => displayName(f.name)))
  const bad = (name: string, code: string, reason: string) => ({
    success: false as const,
    code,
    file: name,
    error: files.length === 1 ? reason : `"${name}": ${reason}`,
  })

  // Sniff every file first, so a wrong type is reported before any slow PDF parsing.
  const kinds: ('pdf' | 'txt')[] = []
  for (const [i, f] of files.entries()) {
    const s = sniffFileType(f.bytes)
    if (s.kind === 'unsupported') return bad(names[i], 'unsupported_type', s.reason)
    kinds.push(s.kind)
  }

  // Extract each up to the whole budget: one file may end up needing all of it.
  const extracted: Extracted[] = []
  for (const [i, f] of files.entries()) {
    try {
      extracted.push(kinds[i] === 'pdf' ? await extractPdf(f.bytes, MAX_TEXT_CHARS) : extractTxt(f.bytes, MAX_TEXT_CHARS))
    } catch (err) {
      if (err instanceof ExtractError) return bad(names[i], `file_${err.code}`, err.message)
      deps.log?.(`[draft-file] extraction failed for ${names[i]}: ${err instanceof Error ? err.message : String(err)}`)
      return bad(names[i], 'file_corrupt', "Couldn't read this file. Try exporting it again, or paste the text.")
    }
  }

  // Share the 8000 characters: short files keep everything, the rest is split.
  const shares = allocateBudget(extracted.map((e) => e.text.length), MAX_TEXT_CHARS)
  const sections = extracted.map((e, i) => {
    const c = cutText(e.text, shares[i])
    return { name: names[i], text: c.text, truncated: c.truncated || e.truncated }
  })

  const r = await runDraftQuestions(
    { quizId: input.quizId, notes: buildFileNotes(sections), count },
    deps,
    { sources: names, notesMax: MAX_TEXT_CHARS + FILE_NOTES_OVERHEAD },
  )
  if (!r.success) return r
  return {
    ...r,
    data: {
      ...r.data,
      sources: sections.map((s, i) => ({
        name: s.name,
        kind: kinds[i],
        chars: s.text.length,
        truncated: s.truncated,
        pages: extracted[i].pages,
        pagesRead: extracted[i].pagesRead,
      })),
    },
  }
}

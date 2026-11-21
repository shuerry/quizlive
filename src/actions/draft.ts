/**
 * draftQuestions: AI-drafted questions from pasted notes.
 *
 * Runs in the WORKER, outside the record DO's blockConcurrencyWhile lock
 * (see src/game/lock-guard.ts):
 *   1. validate input (notes ≤ 8000 chars, count 3–10),
 *   2. reserveDraft inside the DO: quiz ownership + hourly rate limit,
 *      atomically (fast, no network),
 *   3. call the model here, with a 20 s timeout,
 *   4. parse + validate the output and RETURN the drafts. Nothing is saved;
 *      the host reviews each draft and saves it with saveQuestion.
 */

import {
  buildDraftRequest,
  DRAFT_TIMEOUT_MS,
  extractText,
  parseDrafts,
  validateDraftRequest,
  type DraftQuestion,
} from '../game/drafts'

type Fail = { success: false; error: string; code: string; serverNow?: number }
export type DraftResult =
  | { success: true; data: { drafts: DraftQuestion[]; dropped: number; remaining: number }; serverNow: number }
  | Fail

export interface DraftDeps {
  /** Forwards to the engine's reserveDraft op (runs as the verified caller). */
  reserve: (quizId: string) => Promise<
    { success: true; data: { remaining: number }; serverNow: number } | Fail
  >
  /** tools.integration('anthropic/chat-completion', body) */
  callModel: (body: ReturnType<typeof buildDraftRequest>) => Promise<
    { success: true; data: unknown } | { success: false; error: string; code?: string }
  >
  timeoutMs?: number
  log?: (msg: string) => void
}

const TIMEOUT = Symbol('timeout')

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

const FRIENDLY_AI_ERROR = "The AI couldn't draft questions right now. Try again, or add questions by hand."

export async function runDraftQuestions(params: Record<string, unknown>, deps: DraftDeps): Promise<DraftResult> {
  const log = deps.log ?? (() => {})
  const quizId = typeof params.quizId === 'string' ? params.quizId : ''
  if (!quizId) return { success: false, code: 'bad_request', error: 'Missing quizId' }

  const input = validateDraftRequest(params)
  if (!input.ok) return { success: false, code: 'invalid', error: input.error }

  // Ownership + rate limit (inside the DO lock, fast).
  const reserved = await deps.reserve(quizId)
  if (!reserved.success) return reserved

  // The slow part, outside the lock.
  let result: Awaited<ReturnType<DraftDeps['callModel']>> | typeof TIMEOUT
  try {
    result = await withTimeout(deps.callModel(buildDraftRequest(input.notes, input.count)), deps.timeoutMs ?? DRAFT_TIMEOUT_MS)
  } catch (err) {
    log(`[draft] model call threw: ${err instanceof Error ? err.message : String(err)}`)
    return { success: false, code: 'ai_failed', error: FRIENDLY_AI_ERROR, serverNow: reserved.serverNow }
  }
  if (result === TIMEOUT) {
    log('[draft] model call timed out')
    return {
      success: false,
      code: 'ai_timeout',
      error: 'The AI took too long. Try again with shorter notes, or add questions by hand.',
      serverNow: reserved.serverNow,
    }
  }
  if (!result.success) {
    log(`[draft] model call failed: ${result.code ?? ''} ${result.error}`)
    const error =
      result.code === 'insufficient_credits'
        ? "AI drafting is unavailable: the app's AI credits have run out. You can still add questions by hand."
        : FRIENDLY_AI_ERROR
    return { success: false, code: 'ai_failed', error, serverNow: reserved.serverNow }
  }

  const parsed = parseDrafts(extractText(result.data), input.count)
  if (parsed.dropped.length) log(`[draft] dropped ${parsed.dropped.length}: ${JSON.stringify(parsed.dropped)}`)
  if (parsed.drafts.length === 0) {
    return {
      success: false,
      code: 'ai_unusable',
      error: "The AI's answer couldn't be used. Try again, or add questions by hand.",
      serverNow: reserved.serverNow,
    }
  }
  return {
    success: true,
    data: { drafts: parsed.drafts, dropped: parsed.dropped.length, remaining: reserved.data.remaining },
    serverNow: reserved.serverNow,
  }
}

/**
 * Results email to the host, sent from the WORKER after the game has ended
 * (never inside the DO lock; see src/game/lock-guard.ts).
 *
 * - Recipient: ONLY the host's own email from their verified JWT claims,
 *   passed in by the action route. Nothing from the request body is used.
 * - Once per game: the engine claims the email when the game ends
 *   (games.resultsEmail = "sending") and only that one call gets here.
 *   Retried endGame calls see it already claimed and never send again.
 *   If the worker dies mid-send the status stays "sending" and the email is
 *   not retried: at most once, never twice.
 * - Never throws: the game has already ended before this runs, and an email
 *   problem only changes games.resultsEmail to "failed" or "skipped".
 */

import { buildResultsEmail, type GameResultsSummary } from '../game/results-email'

export const EMAIL_TIMEOUT_MS = 8_000
export const FROM_ADDRESS = 'QuizLive <quizlive@app.space>'
const TEST_ACCOUNT_SUFFIX = '@deepspace.test'

type OpReply<T> = { success: true; data: T } | { success: false; error: string; code?: string }

export interface ResultsEmailDeps {
  getResults: () => Promise<OpReply<GameResultsSummary>>
  send: (body: Record<string, unknown>) => Promise<{ success: boolean; error?: string; code?: string }>
  mark: (status: 'sent' | 'failed' | 'skipped') => Promise<unknown>
  log?: (msg: string) => void
  timeoutMs?: number
}

export type ResultsEmailOutcome = { status: 'sent' | 'failed' | 'skipped'; reason?: string }

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/

export function hostEmailFromClaims(claims: unknown): string | null {
  const email = claims && typeof claims === 'object' ? (claims as { email?: unknown }).email : undefined
  if (typeof email !== 'string') return null
  const e = email.trim()
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null
}

export async function sendResultsEmail(
  input: { hostEmail: string | null; timeZone?: unknown },
  deps: ResultsEmailDeps,
): Promise<ResultsEmailOutcome> {
  const log = deps.log ?? (() => {})
  const finish = async (outcome: ResultsEmailOutcome) => {
    try {
      await deps.mark(outcome.status)
    } catch (err) {
      log(`[results-email] could not record status ${outcome.status}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (outcome.status !== 'sent') log(`[results-email] ${outcome.status}: ${outcome.reason ?? ''}`)
    return outcome
  }

  try {
    if (!input.hostEmail) return await finish({ status: 'skipped', reason: 'no verified email on the host account' })
    if (input.hostEmail.toLowerCase().endsWith(TEST_ACCOUNT_SUFFIX)) {
      return await finish({ status: 'skipped', reason: 'test account (no real inbox)' })
    }

    const results = await deps.getResults()
    if (!results.success) return await finish({ status: 'failed', reason: `results unavailable: ${results.error}` })

    const email = buildResultsEmail(results.data, typeof input.timeZone === 'string' ? input.timeZone : 'UTC')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), deps.timeoutMs ?? EMAIL_TIMEOUT_MS)
    })
    const sent = await Promise.race([
      deps.send({ from: FROM_ADDRESS, to: input.hostEmail, subject: email.subject, text: email.text, html: email.html }),
      timeout,
    ]).finally(() => clearTimeout(timer))

    if (sent === 'timeout') return await finish({ status: 'failed', reason: 'email send timed out' })
    if (!sent.success) return await finish({ status: 'failed', reason: `${sent.code ?? ''} ${sent.error ?? ''}`.trim() })
    return await finish({ status: 'sent' })
  } catch (err) {
    return await finish({ status: 'failed', reason: err instanceof Error ? err.message : String(err) })
  }
}

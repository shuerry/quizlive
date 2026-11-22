/**
 * Client side of the game protocol: calling server actions, the server-clock
 * offset, and the countdown.
 *
 * The client NEVER decides a deadline. It only draws a countdown from the
 * server's `endsAt`, corrected by the offset between this device's clock and
 * the server's. Whether an answer was in time is decided by the server.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { getAuthToken, useAuth, useMutations } from 'deepspace'
import type { OpName } from '../game/engine'

export type ActionResponse<T = Record<string, unknown>> =
  | { success: true; data: T; serverNow: number }
  | { success: false; error: string; code: string; serverNow?: number }

// ── Server clock ────────────────────────────────────────────────────────────
// offset = serverNow − (local time at the middle of the round trip).
// The sample with the smallest round trip is the most accurate, so keep it
// (it ages out after a minute so a drifting device clock gets re-measured).

let offsetMs = 0
let bestRtt = Number.POSITIVE_INFINITY
let bestAt = 0
let sampled = false
const listeners = new Set<() => void>()

function recordClockSample(serverNow: number, sentAt: number, receivedAt: number) {
  const rtt = receivedAt - sentAt
  const stale = receivedAt - bestAt > 60_000
  if (!sampled || stale || rtt <= bestRtt) {
    offsetMs = serverNow - (sentAt + rtt / 2)
    bestRtt = rtt
    bestAt = receivedAt
    sampled = true
    listeners.forEach((l) => l())
  }
}

/** Best estimate of the server's clock right now. */
export function serverNow(): number {
  return Date.now() + offsetMs
}

export function useClockOffset(): { offsetMs: number; sampled: boolean } {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (sampled ? offsetMs : Number.NaN),
  )
  return { offsetMs: Number.isNaN(value) ? 0 : value, sampled: !Number.isNaN(value) }
}

// ── Actions ─────────────────────────────────────────────────────────────────

export async function callQuizAction<T = Record<string, unknown>>(
  op: OpName | 'draftQuestions',
  params: Record<string, unknown> = {},
): Promise<ActionResponse<T>> {
  const token = await getAuthToken()
  if (!token) return { success: false, code: 'unauthorized', error: 'Sign in first' }
  const sentAt = Date.now()
  try {
    const res = await fetch(`/api/actions/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
    const receivedAt = Date.now()
    const body = (await res.json().catch(() => null)) as ActionResponse<T> | { error?: string } | null
    if (body && 'serverNow' in body && typeof body.serverNow === 'number') {
      recordClockSample(body.serverNow, sentAt, receivedAt)
    }
    if (body && 'success' in body) return body
    return { success: false, code: `http_${res.status}`, error: body?.error ?? `Request failed (${res.status})` }
  } catch {
    return { success: false, code: 'network', error: 'Network error. Check your connection.' }
  }
}

/** Upload up to 3 PDF/.txt files and get AI drafts back. The server keeps nothing. */
export async function draftFromFiles<T = Record<string, unknown>>(
  files: File[],
  quizId: string,
  count: number,
): Promise<ActionResponse<T>> {
  const token = await getAuthToken()
  if (!token) return { success: false, code: 'unauthorized', error: 'Sign in first' }
  const form = new FormData()
  form.append('quizId', quizId)
  form.append('count', String(count))
  for (const file of files) form.append('file', file, file.name)
  const sentAt = Date.now()
  try {
    const res = await fetch('/api/quiz/draft-from-file', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const receivedAt = Date.now()
    const body = (await res.json().catch(() => null)) as ActionResponse<T> | { error?: string } | null
    if (body && 'serverNow' in body && typeof body.serverNow === 'number') {
      // The upload time inflates this round trip; recordClockSample keeps the best sample.
      recordClockSample(body.serverNow, sentAt, receivedAt)
    }
    if (body && 'success' in body) return body
    return { success: false, code: `http_${res.status}`, error: body?.error ?? `Upload failed (${res.status})` }
  } catch {
    return { success: false, code: 'network', error: 'Upload failed. Check your connection and try again.' }
  }
}

/**
 * Actions are usable once the user is signed in AND the records room is
 * connected (results of an action arrive through the room's live queries).
 */
export function useActionsReady(): boolean {
  const { isSignedIn } = useAuth()
  const { ready } = useMutations('quizzes')
  return isSignedIn && ready
}

/** Measure the clock offset once if nothing has yet (e.g. after a page reload). */
export function useServerClockSync(enabled = true) {
  const { sampled } = useClockOffset()
  useEffect(() => {
    if (enabled && !sampled) void callQuizAction('serverTime')
  }, [enabled, sampled])
}

/** Milliseconds left until `endsAt` on the server's clock (never negative). */
export function useCountdown(endsAt: number | undefined, running: boolean): number {
  const { offsetMs: offset } = useClockOffset()
  const compute = () => (endsAt ? Math.max(0, endsAt - (Date.now() + offset)) : 0)
  const [left, setLeft] = useState(compute)
  useEffect(() => {
    setLeft(compute())
    if (!running || !endsAt) return
    const id = window.setInterval(() => setLeft(compute()), 100)
    return () => window.clearInterval(id)
     
  }, [endsAt, running, offset])
  return left
}

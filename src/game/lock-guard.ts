/**
 * NOTHING SLOW RUNS INSIDE blockConcurrencyWhile.
 *
 * Game ops run inside the record DO under state.blockConcurrencyWhile (see
 * AppRecordRoom in worker.ts). While an op holds the lock, the DO serves no
 * other request: no WebSocket message, no other player's answer. So an op may
 * only touch the DO's own records, in-process. Never:
 *   - network calls (fetch, integrations, other workers or DOs),
 *   - AI calls (AI question drafting runs in the WORKER action, before the
 *     lock; only the final saveQuestion goes through runOp),
 *   - timers or waits.
 *
 * Enforced three ways:
 *   1. The engine only gets a Store. It has no env, no tools.integration and no fetch.
 *   2. assertInProcessToolCall: the Store's only route out is the DO's own
 *      /api/tools/execute handler, called directly. Anything else throws, and
 *      runOp turns that into an error response (a throw inside
 *      blockConcurrencyWhile would reset the DO, which runOp prevents).
 *   3. lock-guard.test.ts scans the engine's source for imports and for
 *      fetch / integration / timer calls.
 * Plus a runtime alarm (checkLockDuration) if an op ever holds the lock too long.
 */

export const TOOLS_PATH = '/api/tools/execute'
export const SLOW_OP_MS = 250

export function assertInProcessToolCall(req: Request): void {
  const url = new URL(req.url)
  if (url.hostname !== 'internal' || url.pathname !== TOOLS_PATH || req.method !== 'POST') {
    throw new Error(
      `lock-guard: ${req.method} ${req.url} attempted inside blockConcurrencyWhile; ` +
        `only in-process ${TOOLS_PATH} calls are allowed there`,
    )
  }
}

/** Logs loudly when an op held the DO lock for too long. Returns true when OK. */
export function checkLockDuration(op: string, ms: number): boolean {
  if (ms <= SLOW_OP_MS) return true
  console.error(`[quiz] lock-guard: op ${JSON.stringify(op)} held blockConcurrencyWhile for ${ms} ms (limit ${SLOW_OP_MS})`)
  return false
}

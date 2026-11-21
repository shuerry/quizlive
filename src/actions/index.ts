/**
 * Server actions, exposed at POST /api/actions/<name>.
 *
 * src/server/action-routes.ts has already verified the caller's JWT and hands
 * us `userId` from it. Each QuizLive action forwards to the record Durable
 * Object, where the game engine runs atomically (see AppRecordRoom in
 * worker.ts). The verified id travels in a header the engine trusts; any
 * userId/hostId in the request body is ignored, because the engine never reads
 * identity from `params`.
 */

import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { OP_NAMES } from '../game/engine'
import { CALLER_HEADER, QUIZ_OP_PATH } from '../game/protocol'

function forward(op: string): ActionHandler<Env> {
  return async ({ userId, params, env }) => {
    const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
    const res = await stub.fetch(
      new Request(`https://internal${QUIZ_OP_PATH}${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CALLER_HEADER]: userId },
        body: JSON.stringify(params ?? {}),
      }),
    )
    // { success, data | error, code, serverNow }
    return (await res.json()) as ActionResult
  }
}

export const actions: Record<string, ActionHandler<Env>> = Object.fromEntries(
  OP_NAMES.map((op) => [op, forward(op)]),
)

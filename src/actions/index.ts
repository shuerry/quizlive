/**
 * Server actions, exposed at POST /api/actions/<name>.
 *
 * src/server/action-routes.ts has already verified the caller's JWT and hands
 * us `userId` from it. Each QuizLive action forwards to the record Durable
 * Object, where the game engine runs atomically (see AppRecordRoom in
 * worker.ts). The verified id travels in a header the engine trusts; any
 * userId/hostId in the request body is ignored, because the engine never reads
 * identity from `params`.
 *
 * Slow work goes HERE, never in the engine: the engine runs inside the DO's
 * blockConcurrencyWhile lock (see src/game/lock-guard.ts). draftQuestions is
 * the example: the AI call happens in this worker action, and only the host's
 * later saveQuestion goes through the lock.
 */

import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { PUBLIC_OP_NAMES, type OpName } from '../game/engine'
import { CALLER_HEADER, QUIZ_OP_PATH } from '../game/protocol'
import { runDraftQuestions, type DraftDeps } from './draft'

export async function callOp(env: Env, userId: string, op: OpName, params: Record<string, unknown>) {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
  const res = await stub.fetch(
    new Request(`https://internal${QUIZ_OP_PATH}${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CALLER_HEADER]: userId },
      body: JSON.stringify(params ?? {}),
    }),
  )
  // { success, data | error, code, serverNow }
  return (await res.json()) as ActionResult & { serverNow: number }
}

function forward(op: OpName): ActionHandler<Env> {
  return ({ userId, params, env }) => callOp(env, userId, op, params)
}

/** Dependencies for the AI drafting pipeline, shared by draftQuestions and the file-upload route. */
export function draftDeps(env: Env, userId: string, tools: ActionTools): DraftDeps {
  return {
    reserve: (quizId) => callOp(env, userId, 'reserveDraft', { quizId }) as ReturnType<DraftDeps['reserve']>,
    callModel: (body) => tools.integration('anthropic/chat-completion', body),
    log: (m) => console.warn(m),
  }
}

const draftQuestions: ActionHandler<Env> = async ({ userId, params, env, tools }) =>
  (await runDraftQuestions(params, draftDeps(env, userId, tools))) as ActionResult

export const actions: Record<string, ActionHandler<Env>> = {
  ...Object.fromEntries(PUBLIC_OP_NAMES.map((op) => [op, forward(op)])),
  draftQuestions,
}

/**
 * QuizLive collections. See DESIGN.md, "Data".
 *
 * Rules that hold for every collection below:
 *
 * - Identity columns (hostId, userId) are `userBound` + `immutable`. On create
 *   the Durable Object overwrites them with the caller's verified user id
 *   (from the JWT checked in src/server/realtime-routes.ts and
 *   src/server/action-routes.ts); on update it keeps the stored value. A client
 *   can never choose whose row it is.
 * - Every row is created by the user it belongs to (the host creates quizzes,
 *   questions, answer keys and games; a player creates their own player,
 *   membership and answer rows through server actions that run as them), so
 *   the userBound stamp is always the right id.
 * - `admin` gets exactly the `member` rules. The app owner is pinned to admin,
 *   so any extra admin read would let the owner see answer keys of games they
 *   play in. "Host only, ever" includes the owner.
 * - Anonymous (`*`) and `viewer` get nothing.
 * - Only `quizzes` accepts client writes. Every other collection is written by
 *   server actions only (create/update/delete: false for all client roles),
 *   because those writes need checks the schema cannot express: quiz
 *   ownership, game state, the server clock and scoring.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const NONE: RolePermissions = { read: false, create: false, update: false, delete: false }

/** Same rule for every signed-in user (member and admin); nothing for anyone else. */
function signedIn(rule: RolePermissions): CollectionSchema['permissions'] {
  return { '*': NONE, viewer: NONE, member: rule, admin: rule }
}

/** Read-only to clients under `read`; all writes go through server actions. */
const serverWritten = (read: RolePermissions['read']): RolePermissions => ({
  read,
  create: false,
  update: false,
  delete: false,
})

const identity = (name: string) =>
  ({ name, storage: 'text', interpretation: 'plain', userBound: true, immutable: true }) as const

// ── quizzes: host only ────────────────────────────────────────────────────────
export const quizzesSchema: CollectionSchema = {
  name: 'quizzes',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    identity('hostId'),
  ],
  ownerField: 'hostId',
  permissions: signedIn({
    read: 'own',
    create: true,
    update: 'own',
    delete: 'own',
    writableFields: ['title'],
  }),
}

// ── questions: host only (players get the live question via games) ───────────
export const questionsSchema: CollectionSchema = {
  name: 'questions',
  columns: [
    { name: 'quizId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'order', storage: 'number', interpretation: 'plain', required: true },
    { name: 'prompt', storage: 'text', interpretation: 'plain', required: true },
    /** 2–4 strings; validated by the server action that writes it. */
    { name: 'choices', storage: 'text', interpretation: 'json', required: true },
    { name: 'timeLimitSec', storage: 'number', interpretation: 'plain', required: true },
    identity('hostId'),
  ],
  ownerField: 'hostId',
  permissions: signedIn(serverWritten('own')),
}

// ── answerKeys: HOST ONLY, EVER ───────────────────────────────────────────────
export const answerKeysSchema: CollectionSchema = {
  name: 'answerKeys',
  columns: [
    { name: 'questionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'correctIndex', storage: 'number', interpretation: 'plain', required: true },
    identity('hostId'),
  ],
  uniqueOn: ['questionId'],
  ownerField: 'hostId',
  permissions: signedIn(serverWritten('own')),
}

// ── team_members: who is in which game ───────────────────────────────────────
// The SDK's 'team' permission level looks membership up in a collection that
// must be named exactly `team_members` with teamId/userId/status columns.
// teamId is a game id. The host gets a row when the game is created; a player
// gets one when the join action accepts their code.
export const teamMembersSchema: CollectionSchema = {
  name: 'team_members',
  columns: [
    { name: 'teamId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    identity('userId'),
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['active', 'removed'] },
      default: 'active',
    },
  ],
  uniqueOn: ['teamId', 'userId'],
  ownerField: 'userId',
  permissions: signedIn(serverWritten('own')),
}

// ── games: everyone in the game ──────────────────────────────────────────────
export const gamesSchema: CollectionSchema = {
  name: 'games',
  columns: [
    { name: 'quizId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    identity('hostId'),
    { name: 'code', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    {
      name: 'state',
      storage: 'text',
      interpretation: { kind: 'select', options: ['lobby', 'question', 'reveal', 'ended'] },
      default: 'lobby',
    },
    { name: 'currentIndex', storage: 'number', interpretation: 'plain', default: -1 },
    /** Epoch ms, set from the worker's clock only. */
    { name: 'startedAt', storage: 'number', interpretation: 'plain' },
    { name: 'endsAt', storage: 'number', interpretation: 'plain' },
    /**
     * The correct choice of the current question. -1 until the host reveals
     * it; reset to -1 when the next question starts. This is the ONLY place a
     * player can ever read a correct answer.
     */
    { name: 'revealedIndex', storage: 'number', interpretation: 'plain', default: -1 },
    /**
     * Equal to this game's own record id; the `teamField` that ties the row to
     * its team_members rows. Set once by the create-game action.
     */
    { name: 'teamId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    /**
     * The live question as players see it: { questionId, prompt, choices,
     * timeLimitSec }. Copied here by the worker when a question starts, so
     * players never read the `questions` collection. Built from an explicit
     * field list and NEVER holds correctIndex (see src/game/engine.ts).
     */
    { name: 'currentQuestion', storage: 'text', interpretation: 'json' },
    /** "12/15 answered": a count only, kept by the answer action. */
    { name: 'answeredCount', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  uniqueOn: ['code'],
  ownerField: 'hostId',
  teamField: 'teamId',
  permissions: signedIn(serverWritten('team')),
}

// ── players: everyone in the game ────────────────────────────────────────────
export const playersSchema: CollectionSchema = {
  name: 'players',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    identity('userId'),
    { name: 'nickname', storage: 'text', interpretation: 'plain', required: true },
    { name: 'score', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  uniqueOn: ['gameId', 'userId'],
  ownerField: 'userId',
  teamField: 'gameId',
  permissions: signedIn(serverWritten('team')),
}

// ── answers: own answer only ─────────────────────────────────────────────────
export const answersSchema: CollectionSchema = {
  name: 'answers',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'questionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    identity('userId'),
    { name: 'choice', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    /** Epoch ms from the worker's clock, never the client's. */
    { name: 'receivedAt', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    /** Filled in at reveal. */
    { name: 'points', storage: 'number', interpretation: 'plain' },
  ],
  // One answer per player per question, enforced by the Durable Object.
  uniqueOn: ['gameId', 'questionId', 'userId'],
  ownerField: 'userId',
  permissions: signedIn(serverWritten('own')),
}

// ── aiDraftLog: one row per AI drafting request, for the hourly rate limit ──
// Server-only: no client role can read or write it.
export const aiDraftLogSchema: CollectionSchema = {
  name: 'aiDraftLog',
  columns: [
    identity('userId'),
    { name: 'quizId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    /** Epoch ms, server clock. */
    { name: 'at', storage: 'number', interpretation: 'plain', required: true, immutable: true },
  ],
  ownerField: 'userId',
  permissions: signedIn(serverWritten(false)),
}

export const quizSchemas: CollectionSchema[] = [
  quizzesSchema,
  questionsSchema,
  answerKeysSchema,
  teamMembersSchema,
  gamesSchema,
  playersSchema,
  answersSchema,
  aiDraftLogSchema,
]

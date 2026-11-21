/**
 * Worker → Durable Object protocol for game ops.
 *
 * The worker's /api/actions/:name route verifies the caller's JWT, then posts
 * the op to the record DO at QUIZ_OP_PATH + name, carrying the verified user id
 * in CALLER_HEADER. No public route forwards this path to the DO (the only
 * client-reachable DO entry is the /ws/* WebSocket upgrade), so the header
 * can only come from the worker.
 */
export const QUIZ_OP_PATH = '/quiz-op/'
export const CALLER_HEADER = 'X-Quiz-Caller'

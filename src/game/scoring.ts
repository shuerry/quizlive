/**
 * Pure game rules: scoring, join codes, input validation. No I/O, no clock —
 * callers pass server time in. Unit-tested in scoring.test.ts.
 */

export const MAX_POINTS_BASE = 500
export const MAX_POINTS_SPEED = 500

/**
 * correct ? 500 + round(500 × timeLeft / limit) : 0
 *
 * timeLeft = endsAt − receivedAt, clamped to [0, limit]. Both timestamps are
 * server time (ms). An answer received at or after endsAt is never accepted,
 * but if one reaches here it scores as timeLeft = 0, never negative.
 */
export function scoreAnswer(args: {
  correct: boolean
  receivedAt: number
  endsAt: number
  timeLimitSec: number
}): number {
  if (!args.correct) return 0
  const limitMs = args.timeLimitSec * 1000
  if (!(limitMs > 0)) return MAX_POINTS_BASE
  const leftMs = Math.min(Math.max(args.endsAt - args.receivedAt, 0), limitMs)
  return MAX_POINTS_BASE + Math.round(MAX_POINTS_SPEED * (leftMs / limitMs))
}

/** No 0/O, 1/I/L: easy to read off a projector and type on a phone. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const JOIN_CODE_LENGTH = 6

/** Cryptographically random 6-character join code. */
export function makeJoinCode(random: (n: number) => Uint8Array = cryptoBytes): string {
  // Rejection sampling keeps every character equally likely.
  const n = JOIN_CODE_ALPHABET.length
  const limit = 256 - (256 % n)
  let out = ''
  while (out.length < JOIN_CODE_LENGTH) {
    for (const b of random(JOIN_CODE_LENGTH * 2)) {
      if (b < limit && out.length < JOIN_CODE_LENGTH) out += JOIN_CODE_ALPHABET[b % n]
    }
  }
  return out
}

function cryptoBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function normalizeJoinCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  if (code.length !== JOIN_CODE_LENGTH) return null
  for (const ch of code) if (!JOIN_CODE_ALPHABET.includes(ch)) return null
  return code
}

export const LIMITS = {
  titleMax: 120,
  promptMax: 500,
  choiceMax: 200,
  nicknameMax: 24,
  minChoices: 2,
  maxChoices: 4,
  minTimeSec: 5,
  maxTimeSec: 120,
} as const

type Ok<T> = { ok: true; value: T }
type Bad = { ok: false; error: string }

function nonEmpty(raw: unknown, max: number, label: string): Ok<string> | Bad {
  if (typeof raw !== 'string') return { ok: false, error: `${label} is required` }
  const v = raw.trim()
  if (!v) return { ok: false, error: `${label} is required` }
  if (v.length > max) return { ok: false, error: `${label} is longer than ${max} characters` }
  return { ok: true, value: v }
}

export const validateTitle = (raw: unknown) => nonEmpty(raw, LIMITS.titleMax, 'Title')
export const validateNickname = (raw: unknown) => nonEmpty(raw, LIMITS.nicknameMax, 'Nickname')

export interface QuestionInput {
  prompt: string
  choices: string[]
  timeLimitSec: number
  correctIndex: number
}

export function validateQuestion(p: Record<string, unknown>): Ok<QuestionInput> | Bad {
  const prompt = nonEmpty(p.prompt, LIMITS.promptMax, 'Question')
  if (!prompt.ok) return prompt

  if (!Array.isArray(p.choices)) return { ok: false, error: 'Choices must be a list' }
  if (p.choices.length < LIMITS.minChoices || p.choices.length > LIMITS.maxChoices) {
    return { ok: false, error: `Use ${LIMITS.minChoices}–${LIMITS.maxChoices} choices` }
  }
  const choices: string[] = []
  for (const [i, c] of p.choices.entries()) {
    const v = nonEmpty(c, LIMITS.choiceMax, `Choice ${i + 1}`)
    if (!v.ok) return v
    choices.push(v.value)
  }
  if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) {
    return { ok: false, error: 'Choices must be different from each other' }
  }

  const t = p.timeLimitSec
  if (typeof t !== 'number' || !Number.isInteger(t) || t < LIMITS.minTimeSec || t > LIMITS.maxTimeSec) {
    return { ok: false, error: `Time limit must be ${LIMITS.minTimeSec}–${LIMITS.maxTimeSec} seconds` }
  }

  const ci = p.correctIndex
  if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0 || ci >= choices.length) {
    return { ok: false, error: 'Pick which choice is correct' }
  }

  return { ok: true, value: { prompt: prompt.value, choices, timeLimitSec: t, correctIndex: ci } }
}

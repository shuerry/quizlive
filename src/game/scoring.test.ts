import { describe, expect, it } from 'vitest'
import {
  JOIN_CODE_ALPHABET,
  makeJoinCode,
  normalizeJoinCode,
  scoreAnswer,
  validateQuestion,
} from './scoring'

const base = { endsAt: 20_000, timeLimitSec: 20 }

describe('scoreAnswer: correct ? 500 + round(500 × timeLeft / limit) : 0', () => {
  it('wrong answers score 0 no matter how fast', () => {
    expect(scoreAnswer({ ...base, correct: false, receivedAt: 0 })).toBe(0)
  })

  it('an instant correct answer scores 1000', () => {
    expect(scoreAnswer({ ...base, correct: true, receivedAt: 0 })).toBe(1000)
  })

  it('a correct answer with half the time left scores 750', () => {
    expect(scoreAnswer({ ...base, correct: true, receivedAt: 10_000 })).toBe(750)
  })

  it('rounds the speed bonus', () => {
    // 1/3 of the time left → 500 × 0.333… = 166.67 → 167
    expect(scoreAnswer({ endsAt: 3000, timeLimitSec: 3, correct: true, receivedAt: 2000 })).toBe(667)
  })

  it('a correct answer right at the buzzer scores the 500 base', () => {
    expect(scoreAnswer({ ...base, correct: true, receivedAt: 20_000 })).toBe(500)
  })

  it('never goes negative or above 1000 with odd timestamps', () => {
    expect(scoreAnswer({ ...base, correct: true, receivedAt: 99_999 })).toBe(500)
    expect(scoreAnswer({ ...base, correct: true, receivedAt: -50_000 })).toBe(1000)
  })
})

describe('join codes', () => {
  it('are 6 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = makeJoinCode()
      expect(c).toHaveLength(6)
      for (const ch of c) expect(JOIN_CODE_ALPHABET).toContain(ch)
    }
  })

  it('reject biased bytes instead of wrapping them (uniform)', () => {
    // 248 is ≥ the largest multiple of 31 below 256, so it must be skipped.
    let calls = 0
    const code = makeJoinCode(() => (calls++ === 0 ? new Uint8Array(12).fill(248) : new Uint8Array(12).fill(0)))
    expect(code).toBe('AAAAAA')
  })

  it('normalize lower case and reject bad input', () => {
    expect(normalizeJoinCode(' abc234 ')).toBe('ABC234')
    expect(normalizeJoinCode('ABC1O0')).toBeNull()
    expect(normalizeJoinCode('ABC')).toBeNull()
    expect(normalizeJoinCode(42)).toBeNull()
  })
})

describe('validateQuestion', () => {
  const good = { prompt: 'What is 2+2?', choices: ['3', '4'], timeLimitSec: 20, correctIndex: 1 }

  it('accepts a valid question and trims text', () => {
    const r = validateQuestion({ ...good, prompt: '  What is 2+2? ', choices: [' 3', '4 '] })
    expect(r).toEqual({ ok: true, value: { ...good } })
  })

  it.each([
    ['empty prompt', { prompt: '  ' }],
    ['one choice', { choices: ['a'] }],
    ['five choices', { choices: ['a', 'b', 'c', 'd', 'e'] }],
    ['blank choice', { choices: ['a', ' '] }],
    ['duplicate choices', { choices: ['Yes', 'yes'] }],
    ['index out of range', { correctIndex: 2 }],
    ['negative index', { correctIndex: -1 }],
    ['fractional index', { correctIndex: 0.5 }],
    ['time too short', { timeLimitSec: 1 }],
    ['time not a number', { timeLimitSec: '20' }],
  ])('rejects %s', (_name, patch) => {
    expect(validateQuestion({ ...good, ...patch }).ok).toBe(false)
  })
})

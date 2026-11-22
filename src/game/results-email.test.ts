import { describe, expect, it } from 'vitest'
import { buildResultsEmail, safeTimeZone, type GameResultsSummary } from './results-email'

const base: GameResultsSummary = {
  title: 'Cell biology, week 3',
  code: 'K7QM3P',
  endedAt: Date.UTC(2026, 10, 21, 23, 45),
  totalQuestions: 3,
  ranking: [
    { nickname: 'Ada', score: 1983 },
    { nickname: 'Grace', score: 950 },
    { nickname: 'Linus', score: 950 },
    { nickname: 'Tim', score: 0 },
  ],
  questions: [
    { index: 0, prompt: 'Powerhouse of the cell?', answered: 4, correct: 4, players: 4 },
    { index: 1, prompt: 'What does the Golgi do?', answered: 3, correct: 1, players: 4 }, // 25% → flagged
    { index: 2, prompt: 'Chloroplast pigment?', answered: 4, correct: 2, players: 4 }, // exactly 50% → not flagged
  ],
}

describe('buildResultsEmail', () => {
  const e = buildResultsEmail(base, 'America/New_York')

  it('has the quiz title in the subject', () => {
    expect(e.subject).toBe('QuizLive results: Cell biology, week 3')
  })

  it('dates the game in the host time zone', () => {
    expect(e.text).toContain('November 21, 2026 at 6:45 PM EST')
  })

  it('lists the final ranking with nicknames and scores, ties sharing a rank', () => {
    expect(e.text).toContain('1. Ada: 1983\n2. Grace: 950\n2. Linus: 950\n4. Tim: 0')
  })

  it('gives % correct per question (of all players, so no-answers count as wrong)', () => {
    expect(e.text).toContain('Q1. 100% (4/4): Powerhouse of the cell?')
    expect(e.text).toContain('Q2. 25% (1/4)  ⚠ under 50%: What does the Golgi do?')
    expect(e.text).toContain('Q3. 50% (2/4): Chloroplast pigment?')
  })

  it('flags only questions under 50%, in text and HTML', () => {
    expect(e.text).toContain('Worth revisiting: Q2.')
    expect(e.text).not.toMatch(/Q3\.[^\n]*under 50%/)
    expect(e.html.match(/under 50%/g)).toHaveLength(1)
    expect(e.html).toContain('Worth revisiting: <strong>Q2</strong>')
  })

  it('escapes nicknames and prompts in the HTML and keeps the subject on one line', () => {
    const evil = buildResultsEmail({
      ...base,
      title: 'Quiz\r\nBcc: victim@example.com',
      ranking: [{ nickname: '<img src=x onerror=alert(1)>', score: 5 }],
      questions: [{ index: 0, prompt: 'a < b & "c"?', answered: 1, correct: 1, players: 1 }],
    })
    expect(evil.subject).toBe('QuizLive results: Quiz Bcc: victim@example.com')
    expect(evil.subject).not.toMatch(/[\r\n]/)
    expect(evil.html).not.toContain('<img src=x')
    expect(evil.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(evil.html).toContain('a &lt; b &amp; &quot;c&quot;?')
  })

  it('handles no players, no questions played, and a game ended early', () => {
    const empty = buildResultsEmail({ ...base, ranking: [], questions: [] })
    expect(empty.text).toContain('No players joined.')
    expect(empty.text).toContain('No questions were played.')
    expect(empty.text).toContain('ended early: 0 of 3 questions played')
    const zeroPlayers = buildResultsEmail({ ...base, ranking: [], questions: [{ index: 0, prompt: 'Q', answered: 0, correct: 0, players: 0 }] })
    expect(zeroPlayers.text).toContain('Q1. n/a (0/0): Q')
    expect(zeroPlayers.text).not.toContain('Worth revisiting')
  })

  it('falls back to UTC for a missing or bogus time zone', () => {
    expect(safeTimeZone('Not/AZone')).toBe('UTC')
    expect(safeTimeZone(42)).toBe('UTC')
    expect(safeTimeZone('Europe/London')).toBe('Europe/London')
    expect(buildResultsEmail(base, 'Not/AZone').text).toContain('11:45 PM UTC')
  })
})

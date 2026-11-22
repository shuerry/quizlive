/**
 * Builds the end-of-game results email. Pure: no I/O.
 *
 * Nicknames and the quiz title are user input, so every value is
 * HTML-escaped and the subject is stripped of line breaks.
 */

export const FLAG_BELOW = 0.5

export interface GameResultsSummary {
  title: string
  code: string
  endedAt: number
  totalQuestions: number
  ranking: { nickname: string; score: number }[]
  questions: { index: number; prompt: string; answered: number; correct: number; players: number }[]
}

export interface ResultsEmail {
  subject: string
  text: string
  html: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const oneLine = (s: string) => s.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Accept an IANA zone only if this runtime knows it; otherwise UTC. */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

export function formatWhen(epochMs: number, timeZone: string): string {
  // dateStyle/timeStyle can't be combined with timeZoneName, so spell it out.
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date(epochMs))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('month')} ${get('day')}, ${get('year')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} ${get('timeZoneName')}`
}

/** Standard competition ranking: ties share a rank (1, 2, 2, 4). */
function ranks(scores: number[]): number[] {
  return scores.map((s) => scores.findIndex((x) => x === s) + 1)
}

export function pctCorrect(q: { correct: number; players: number }): number | null {
  return q.players > 0 ? q.correct / q.players : null
}

const pctText = (p: number | null) => (p === null ? 'n/a' : `${Math.round(p * 100)}%`)

export function buildResultsEmail(s: GameResultsSummary, timeZone = 'UTC'): ResultsEmail {
  const title = oneLine(s.title) || 'Quiz'
  const when = formatWhen(s.endedAt, safeTimeZone(timeZone))
  const r = ranks(s.ranking.map((p) => p.score))
  const flagged = s.questions.filter((q) => {
    const p = pctCorrect(q)
    return p !== null && p < FLAG_BELOW
  })
  const playedNote =
    s.questions.length < s.totalQuestions ? ` (ended early: ${s.questions.length} of ${s.totalQuestions} questions played)` : ''

  const subject = `QuizLive results: ${title}`.slice(0, 150)

  // ── Plain text ──
  const t: string[] = [
    `QuizLive results: ${title}`,
    `${when} · game ${s.code} · ${s.ranking.length} player${s.ranking.length === 1 ? '' : 's'}${playedNote}`,
    '',
    'FINAL RANKING',
  ]
  if (s.ranking.length === 0) t.push('No players joined.')
  s.ranking.forEach((p, i) => t.push(`${r[i]}. ${oneLine(p.nickname)}: ${p.score}`))
  t.push('', 'QUESTIONS (% of players who answered correctly)')
  if (s.questions.length === 0) t.push('No questions were played.')
  for (const q of s.questions) {
    const p = pctCorrect(q)
    const flag = p !== null && p < FLAG_BELOW ? '  ⚠ under 50%' : ''
    t.push(`Q${q.index + 1}. ${pctText(p)} (${q.correct}/${q.players})${flag}: ${oneLine(q.prompt)}`)
  }
  if (flagged.length) {
    t.push('', `Worth revisiting: ${flagged.map((q) => `Q${q.index + 1}`).join(', ')}. Fewer than half the class got these right.`)
  }
  t.push('', 'Sent to you because you hosted this game on QuizLive.')

  // ── HTML ──
  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:left;'
  const rankingRows = s.ranking.length
    ? s.ranking
        .map((p, i) => `<tr><td style="${cell}">${r[i]}</td><td style="${cell}">${esc(oneLine(p.nickname))}</td><td style="${cell}text-align:right;">${p.score}</td></tr>`)
        .join('')
    : `<tr><td style="${cell}" colspan="3">No players joined.</td></tr>`
  const questionRows = s.questions.length
    ? s.questions
        .map((q) => {
          const p = pctCorrect(q)
          const low = p !== null && p < FLAG_BELOW
          return `<tr${low ? ' style="background:#fff4e5;"' : ''}><td style="${cell}">Q${q.index + 1}</td><td style="${cell}">${esc(oneLine(q.prompt))}${low ? ' <strong style="color:#b45309;">⚠ under 50%</strong>' : ''}</td><td style="${cell}text-align:right;white-space:nowrap;">${pctText(p)} <span style="color:#737373;">(${q.correct}/${q.players})</span></td></tr>`
        })
        .join('')
    : `<tr><td style="${cell}" colspan="3">No questions were played.</td></tr>`

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:24px;">
<p style="margin:0;color:#737373;font-size:13px;">QuizLive results</p>
<h1 style="margin:4px 0 4px;font-size:22px;">${esc(title)}</h1>
<p style="margin:0 0 20px;color:#525252;font-size:14px;">${esc(when)} · game ${esc(s.code)} · ${s.ranking.length} player${s.ranking.length === 1 ? '' : 's'}${esc(playedNote)}</p>
<h2 style="font-size:16px;margin:0 0 8px;">Final ranking</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">${rankingRows}</table>
<h2 style="font-size:16px;margin:0 0 8px;">Questions <span style="font-weight:normal;color:#737373;font-size:13px;">% of players who answered correctly</span></h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;">${questionRows}</table>
${flagged.length ? `<p style="margin:16px 0 0;padding:12px;background:#fff4e5;border-radius:8px;font-size:14px;">Worth revisiting: <strong>${flagged.map((q) => `Q${q.index + 1}`).join(', ')}</strong>. Fewer than half the class got ${flagged.length === 1 ? 'this' : 'these'} right.</p>` : ''}
<p style="margin:24px 0 0;color:#a3a3a3;font-size:12px;">Sent to you because you hosted this game on QuizLive.</p>
</div></body></html>`

  return { subject, text: t.join('\n'), html }
}

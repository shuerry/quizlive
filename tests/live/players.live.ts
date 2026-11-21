/**
 * Two scripted players for a game a human hosts. See playwright.live.config.ts.
 *
 * Player One answers A immediately on every question (double-tapping on Q1).
 * Player Two answers B after ~2 s, except Q2, which it lets run out to test
 * "time's up" + "no answer". Both record every WebSocket frame they receive so
 * we can check the network for any answer key leaking.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect, type MultiplayerUser } from 'deepspace/testing'
import type { Page } from '@playwright/test'

const CODE = process.env.QUIZ_CODE ?? ''
const OUT = 'test-results/live'
const WAIT = 15 * 60_000

test.skip(!CODE, 'Set QUIZ_CODE to the join code shown on the host screen')

interface Frames {
  all: number
  leaks: string[]
  revealedBeforeReveal: string[]
}

function watchFrames(page: Page, f: Frames, phase: () => string) {
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8')
      f.all++
      // records.list_schemas is schema metadata (collection/column names) the
      // SDK sends every client on connect; it carries no record data. Any
      // OTHER frame naming the answer key is a data leak.
      const isSchemaList = text.startsWith('{"type":"records.list_schemas"')
      if (!isSchemaList && /correctIndex|answerKeys/.test(text)) f.leaks.push(`[${phase()}] ${text.slice(0, 300)}`)
      // A games record whose state is still "question" must have revealedIndex -1.
      // (Judged from the frame itself, not the script's phase, which lags.)
      if (/"state":"question"/.test(text) && /"revealedIndex":(?!-1\b)-?\d+/.test(text)) {
        f.revealedBeforeReveal.push(`[${phase()}] ${text.slice(0, 300)}`)
      }
    })
  })
}

test('two players play a hosted game', async ({ users }) => {
  mkdirSync(OUT, { recursive: true })
  const log: string[] = []
  const say = (s: string) => {
    log.push(`${new Date().toISOString().slice(11, 19)} ${s}`)
    console.log(s)
  }

  const [p1, p2] = await users(['Player One', 'Player Two'])
  const nick = new Map<MultiplayerUser, string>([
    [p1, 'Ada'],
    [p2, 'Linus'],
  ])
  const phase = { p1: 'lobby', p2: 'lobby' }
  const frames = { p1: { all: 0, leaks: [], revealedBeforeReveal: [] } as Frames, p2: { all: 0, leaks: [], revealedBeforeReveal: [] } as Frames }
  watchFrames(p1.page, frames.p1, () => phase.p1)
  watchFrames(p2.page, frames.p2, () => phase.p2)
  const shot = (u: MultiplayerUser, name: string) => u.page.screenshot({ path: `${OUT}/${nick.get(u)}-${name}.png`, fullPage: true })

  // ── Join ──
  for (const u of [p1, p2]) {
    await u.page.goto(`/play?code=${CODE}`)
    await u.page.getByTestId('nickname-input').fill(nick.get(u)!)
    await expect(u.page.getByTestId('join-submit')).toBeEnabled({ timeout: 30_000 })
    await u.page.getByTestId('join-submit').click()
    await expect(u.page.getByTestId('player-waiting')).toBeVisible({ timeout: 30_000 })
    await shot(u, '0-lobby')
  }
  say('Both players joined and see the lobby.')

  let q = 0
  let lastPrompt = ''
  for (;;) {
    // Wait for the next question, or the end.
    // Exact comparison: a locator text filter matches substrings, so a prompt
    // that merely CONTAINS the previous one would be missed.
    const next = await Promise.race([
      p1.page
        .waitForFunction(
          (prev) => {
            const el = document.querySelector('[data-testid="player-prompt"]')
            return !!el && el.textContent !== prev
          },
          lastPrompt,
          { timeout: WAIT },
        )
        .then(() => 'question' as const),
      p1.page.getByTestId('final-rank').waitFor({ timeout: WAIT }).then(() => 'ended' as const),
    ])
    if (next === 'ended') break
    q++
    phase.p1 = phase.p2 = 'question'
    lastPrompt = (await p1.page.getByTestId('player-prompt').textContent()) ?? ''
    await expect(p2.page.getByTestId('player-prompt')).toHaveText(lastPrompt, { timeout: 10_000 })
    const cd1 = await p1.page.getByTestId('countdown').textContent()
    const cd2 = await p2.page.getByTestId('countdown').textContent()
    say(`Q${q} live on both phones: "${lastPrompt}" (countdowns ${cd1} / ${cd2})`)

    // Player One: A, immediately (double-tap on Q1).
    if (q === 1) await p1.page.getByTestId('choice-0').dblclick()
    else await p1.page.getByTestId('choice-0').click()
    await expect(p1.page.getByTestId('locked-in')).toBeVisible({ timeout: 10_000 })
    say(`  Ada tapped A${q === 1 ? ' (double-tap)' : ''} → "Answer locked in"`)

    // Player Two: B after 2 s, or let Q2 run out.
    if (q === 2) {
      await expect(p2.page.getByTestId('countdown')).toHaveText('0s', { timeout: 130_000 })
      const disabled = await p2.page.getByTestId('choice-0').isDisabled()
      say(`  Linus let the timer run out; buttons disabled at 0s: ${disabled}`)
      await shot(p2, `${q}-timeup`)
    } else {
      await p2.page.waitForTimeout(2_000)
      await p2.page.getByTestId('choice-1').click()
      await expect(p2.page.getByTestId('locked-in')).toBeVisible({ timeout: 10_000 })
      say('  Linus tapped B after ~2 s → "Answer locked in"')
    }
    await shot(p1, `${q}-question`)

    // Reveal (the host clicks it).
    for (const u of [p1, p2]) await expect(u.page.getByTestId('result')).toBeVisible({ timeout: WAIT })
    phase.p1 = phase.p2 = 'reveal'
    for (const u of [p1, p2]) {
      const r = u.page.getByTestId('result')
      say(`  ${nick.get(u)} result: ${await r.getAttribute('data-result')}: ${(await r.innerText()).replace(/\s+/g, ' ')}`)
      await shot(u, `${q}-reveal`)
    }
    const board = (await p1.page.getByTestId('leaderboard').innerText()).replace(/\s+/g, ' ')
    say(`  Leaderboard on Ada's phone: ${board}`)
  }

  phase.p1 = phase.p2 = 'ended'
  await expect(p2.page.getByTestId('final-rank')).toBeVisible({ timeout: 30_000 })
  for (const u of [p1, p2]) {
    say(`${nick.get(u)} final: ${(await u.page.getByTestId('final-rank').innerText()).trim()}`)
    await shot(u, 'final')
  }

  say(`WebSocket frames received: Ada ${frames.p1.all}, Linus ${frames.p2.all}`)
  say(`Frames mentioning correctIndex/answerKeys: Ada ${frames.p1.leaks.length}, Linus ${frames.p2.leaks.length}`)
  say(`Frames with revealedIndex ≠ -1 during a question: Ada ${frames.p1.revealedBeforeReveal.length}, Linus ${frames.p2.revealedBeforeReveal.length}`)
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ code: CODE, questions: q, log, frames }, null, 2))

  expect(frames.p1.leaks).toEqual([])
  expect(frames.p2.leaks).toEqual([])
  expect(frames.p1.revealedBeforeReveal).toEqual([])
  expect(frames.p2.revealedBeforeReveal).toEqual([])
})

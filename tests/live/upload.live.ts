/**
 * Real file upload through the UI. Makes ONE billed AI call (the text PDF);
 * the scanned PDF is refused before any AI call.
 *
 *   RUN_UPLOAD=1 npx playwright test -c tests/live/playwright.live.config.ts upload
 *   RUN_UPLOAD=1 LIVE_BASE_URL=https://quizlive.app.space npx playwright test -c tests/live/playwright.live.config.ts upload
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect } from 'deepspace/testing'
import { makePdf } from '../../src/game/pdf-fixture'

const OUT = 'test-results/live'
test.skip(!process.env.RUN_UPLOAD, 'Set RUN_UPLOAD=1 to make one real (billed) AI call')

const NOTES_PDF = makePdf([
  [
    'Cell biology, lecture 4: membranes and transport',
    'The cell membrane is a phospholipid bilayer with embedded proteins.',
    'Diffusion moves molecules from high to low concentration without energy.',
    'Osmosis is the diffusion of water across a selectively permeable membrane.',
  ],
  [
    'Active transport uses ATP to move substances against their concentration gradient.',
    'The sodium-potassium pump moves 3 sodium ions out and 2 potassium ions in per ATP.',
    'Endocytosis brings large particles into the cell by engulfing them in membrane.',
  ],
])
const SCANNED_PDF = makePdf([null, null])

test('host uploads a PDF and drafts questions from it', async ({ users, baseURL }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const tag = baseURL?.includes('localhost') ? 'local' : 'deployed'
  const [host] = await users(['Player One'])
  const page = host.page

  await page.goto('/quizzes')
  await page.getByLabel('New quiz title').fill(`Upload test (${tag}) ${new Date().toISOString().slice(11, 19)}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/quizzes\/.+/)
  await page.getByTestId('ai-open').click()
  await page.getByTestId('ai-mode-file').click()
  await page.getByTestId('ai-count').selectOption('3')

  // 1. Scanned PDF → friendly error, no AI call.
  await page.getByTestId('ai-file').setInputFiles({ name: 'scanned-handout.pdf', mimeType: 'application/pdf', buffer: Buffer.from(SCANNED_PDF) })
  await page.getByTestId('ai-submit').click()
  const scannedMsg = await page.getByRole('alert').first().innerText({ timeout: 30_000 })
  console.log(`[${tag}] scanned PDF → "${scannedMsg}"`)
  expect(scannedMsg).toMatch(/no selectable text/)

  // 2. Text PDF → real drafts.
  await page.getByTestId('ai-file').setInputFiles({ name: 'lecture4-membranes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(NOTES_PDF) })
  await expect(page.getByTestId('ai-file-name')).toContainText('lecture4-membranes.pdf')
  const t0 = Date.now()
  await page.getByTestId('ai-submit').click()
  const outcome = await Promise.race([
    page.getByTestId('ai-draft').first().waitFor({ timeout: 45_000 }).then(() => 'drafts'),
    page.getByRole('alert').filter({ hasNotText: 'no selectable text' }).first().waitFor({ timeout: 45_000 }).then(() => 'error'),
  ])
  const ms = Date.now() - t0
  await page.screenshot({ path: `${OUT}/upload-${tag}.png`, fullPage: true })
  const info = await page.getByText(/ready to review/).first().innerText().catch(() => '')
  console.log(`[${tag}] text PDF → ${outcome} in ${ms} ms. ${info}`)
  expect(outcome).toBe('drafts')

  const sources = await page.getByTestId('ai-draft-source').allInnerTexts()
  console.log(`[${tag}] source labels: ${JSON.stringify(sources)}`)
  expect(sources.length).toBeGreaterThan(0)
  for (const s of sources) expect(s).toBe('Source: lecture4-membranes.pdf')

  const cards = page.getByTestId('ai-draft')
  const drafts = []
  for (let i = 0; i < (await cards.count()); i++) {
    const card = cards.nth(i)
    drafts.push({
      prompt: await card.getByLabel('Question').inputValue(),
      choices: await Promise.all(['A', 'B', 'C', 'D'].map((l) => card.getByLabel(`Choice ${l}`, { exact: true }).inputValue())),
      correct: await Promise.all(['A', 'B', 'C', 'D'].map((l) => card.getByLabel(`Choice ${l} is correct`).isChecked())),
    })
  }
  for (const [i, d] of drafts.entries()) {
    const c = d.correct.indexOf(true)
    console.log(`[${tag}] ${i + 1}. ${d.prompt} → ${'ABCD'[c]}: ${d.choices[c]}`)
  }

  await cards.first().getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByRole('heading', { name: 'Questions (1)' })).toBeVisible({ timeout: 10_000 })
  console.log(`[${tag}] accepted draft 1 → quiz has 1 question`)
  writeFileSync(`${OUT}/upload-${tag}.json`, JSON.stringify({ tag, ms, info, scannedMsg, sources, drafts }, null, 2))
})

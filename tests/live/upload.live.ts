/**
 * Real multi-file upload through the UI. Makes ONE billed AI call (three good
 * files together); the request with a scanned PDF is refused before any call.
 *
 *   RUN_UPLOAD=1 npx playwright test -c tests/live/playwright.live.config.ts upload
 *   RUN_UPLOAD=1 LIVE_BASE_URL=https://quizlive.app.space npx playwright test -c tests/live/playwright.live.config.ts upload
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect } from 'deepspace/testing'
import { makePdf } from '../../src/game/pdf-fixture'

const OUT = 'test-results/live'
test.skip(!process.env.RUN_UPLOAD, 'Set RUN_UPLOAD=1 to make one real (billed) AI call')

const pdf = (name: string, lines: (string[] | null)[]) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(makePdf(lines)) })
const MEMBRANES = pdf('week4-membranes.pdf', [
  [
    'Cell biology, week 4: membranes and transport',
    'Diffusion moves molecules from high to low concentration without using energy.',
    'Osmosis is the diffusion of water across a selectively permeable membrane.',
  ],
  ['Active transport uses ATP to move substances against their concentration gradient.'],
])
const ENZYMES = pdf('week5-enzymes.pdf', [
  [
    'Week 5: enzymes',
    'Enzymes are proteins that speed up reactions by lowering the activation energy.',
    'The substrate binds at the active site of the enzyme.',
    'High temperatures denature enzymes, changing the shape of the active site.',
  ],
])
const GENETICS = {
  name: 'week6-genetics.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from(
    'Week 6: genetics\nA gene is a section of DNA that codes for a protein.\n' +
      'Alleles are different versions of the same gene.\nA dominant allele is expressed even when only one copy is present.\n',
  ),
}
const SCANNED = pdf('scanned-handout.pdf', [null, null]) // image-only pages: no text layer

test('host uploads three files and drafts questions from all of them', async ({ users, baseURL }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const tag = baseURL?.includes('localhost') ? 'local' : 'deployed'
  const [host] = await users(['Player One'])
  const page = host.page

  await page.goto('/quizzes')
  await page.getByLabel('New quiz title').fill(`Multi-upload (${tag}) ${new Date().toISOString().slice(11, 19)}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/quizzes\/.+/)
  await page.getByTestId('ai-open').click()
  await page.getByTestId('ai-mode-file').click()
  await page.getByTestId('ai-count').selectOption('4')

  // 1. A scanned PDF among good files → the whole request is refused, naming it. No AI call.
  await page.getByTestId('ai-file').setInputFiles([MEMBRANES, SCANNED, GENETICS])
  await expect(page.getByTestId('ai-file-name')).toHaveCount(3)
  await page.getByTestId('ai-submit').click()
  const scannedMsg = await page.getByRole('alert').first().innerText({ timeout: 30_000 })
  console.log(`[${tag}] with a scanned PDF → "${scannedMsg}"`)
  expect(scannedMsg).toMatch(/"scanned-handout\.pdf": This PDF has no selectable text/)

  // 2. Three good files → one real AI call.
  await page.getByTestId('ai-file').setInputFiles([MEMBRANES, ENZYMES, GENETICS])
  await expect(page.getByTestId('ai-file-name')).toHaveCount(3)
  const t0 = Date.now()
  await page.getByTestId('ai-submit').click()
  await page.getByTestId('ai-draft').first().waitFor({ timeout: 45_000 })
  const ms = Date.now() - t0
  await page.screenshot({ path: `${OUT}/multi-upload-${tag}.png`, fullPage: true })
  const info = await page.getByText(/ready to review/).first().innerText()
  console.log(`[${tag}] three files → drafts in ${ms} ms. ${info}`)

  const sources = await page.getByTestId('ai-draft-source').allInnerTexts()
  const cards = page.getByTestId('ai-draft')
  const n = await cards.count()
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i)
    const prompt = await card.getByLabel('Question').inputValue()
    const correct = await Promise.all(['A', 'B', 'C', 'D'].map((l) => card.getByLabel(`Choice ${l} is correct`).isChecked()))
    const c = correct.indexOf(true)
    const answer = await card.getByLabel(`Choice ${'ABCD'[c]}`, { exact: true }).inputValue()
    console.log(`[${tag}] ${i + 1}. [${sources[i]}] ${prompt} → ${'ABCD'[c]}: ${answer}`)
  }
  expect(sources).toHaveLength(n)
  for (const s of sources) expect(s).toMatch(/^Source: (week4-membranes\.pdf|week5-enzymes\.pdf|week6-genetics\.txt)$/)
  const used = new Set(sources.map((s) => s.replace('Source: ', '')))
  console.log(`[${tag}] files used as sources: ${[...used].join(', ')}`)

  await cards.first().getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByRole('heading', { name: 'Questions (1)' })).toBeVisible({ timeout: 10_000 })
  console.log(`[${tag}] accepted draft 1 → quiz has 1 question`)
  writeFileSync(`${OUT}/multi-upload-${tag}.json`, JSON.stringify({ tag, ms, info, scannedMsg, sources }, null, 2))
})

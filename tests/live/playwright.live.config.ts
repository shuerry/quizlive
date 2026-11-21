/**
 * Manual end-to-end run against the ALREADY RUNNING dev server (npx deepspace
 * dev start on :5173), so a human host in their own browser and these scripted
 * players share one game. Not part of `deepspace test run`.
 *
 *   QUIZ_CODE=ABC234 npx playwright test -c tests/live/playwright.live.config.ts --headed
 */
import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

export default defineConfig({
  testDir: '.',
  testMatch: '*.live.ts',
  timeout: 30 * 60_000,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/live',
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? 'http://localhost:5173',
    headless: true,
    viewport: { width: 390, height: 844 },
    launchOptions: chromiumLaunchOptions(),
  },
})

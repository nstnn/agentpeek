import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.mjs',
  timeout: 60000,
  expect: { timeout: 5000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/e2e',
  use: { trace: 'off', screenshot: 'off', video: 'off' }
})

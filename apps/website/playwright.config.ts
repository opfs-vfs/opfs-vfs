import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'test-results/results.json' }]] : undefined,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    browserName: (process.env.PLAYWRIGHT_BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit',
    baseURL: `http://localhost:${process.env.WEBSITE_TEST_PORT ?? 4325}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node scripts/static-preview.mjs --host localhost --port ${process.env.WEBSITE_TEST_PORT ?? 4325}`,
    env: { ASTRO_PREVIEW_BACKGROUND: '1' },
    url: `http://localhost:${process.env.WEBSITE_TEST_PORT ?? 4325}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

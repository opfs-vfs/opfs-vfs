import { defineConfig } from '@playwright/test';

const development = process.env.EDGEJS_DEV === '1';

export default defineConfig({
  testDir: './tests',
  testMatch: 'edgejs.browser.ts',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: { browserName: 'chromium', baseURL: 'http://localhost:4339', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: development
      ? 'node_modules/.bin/astro dev --host localhost --port 4339'
      : 'node scripts/static-preview.mjs --host localhost --port 4339',
    env: { ASTRO_PREVIEW_BACKGROUND: '1', ASTRO_DEV_BACKGROUND: '1' },
    url: 'http://localhost:4339',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

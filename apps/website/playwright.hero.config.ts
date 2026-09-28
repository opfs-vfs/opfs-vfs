import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Geometry inspection is development-only; keep it out of the production bundle.
export default defineConfig({
  ...base,
  testMatch: '**/hero.browser.ts',
  use: { ...base.use, baseURL: 'http://localhost:4325' },
  webServer: {
    command: 'pnpm exec astro dev --host localhost --port 4325',
    env: { ASTRO_DEV_BACKGROUND: '1' },
    url: 'http://localhost:4325',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

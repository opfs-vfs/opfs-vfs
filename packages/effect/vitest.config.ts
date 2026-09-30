import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  optimizeDeps: {
    include: ['effect', '@opfs-vfs/opfs-vfs', '@opfs-vfs/opfs-vfs/plugins'],
  },
  server: {
    host: 'localhost',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  test: {
    fileParallelism: false,
    include: ['src/**/*.test.ts'],
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
  },
});

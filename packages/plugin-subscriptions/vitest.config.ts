import { configDefaults, defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';

const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default defineConfig({
  resolve: {
    alias: {
      '@opfs-vfs/plugin-subscriptions/client': fileURLToPath(new URL('./src/client.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['@opfs-vfs/plugin-subscriptions'],
    include: ['@opfs-vfs/opfs-vfs', '@opfs-vfs/opfs-vfs/worker', '@opfs-vfs/opfs-vfs/worker-runtime'],
  },
  server: { host: 'localhost', headers },
  test: {
    exclude: [...configDefaults.exclude, 'tests/packed-*.test.ts'],
    fileParallelism: false,
    browser: { enabled: true, headless: true, headers, provider: playwright(), instances: [{ browser: 'chromium' }] },
  },
});

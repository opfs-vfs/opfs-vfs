import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// The extracted examples resolve public packages from .packed/node_modules.
export default defineConfig({
  ...(base as object),
  resolve: { alias: {} },
  test: {
    ...((base as { test?: object }).test ?? {}),
    include: ['src/volume-real.test.ts', 'tests/packed-worker-session.test.ts', 'tests/packed-subscriptions.test.ts'],
  },
  optimizeDeps: {
    noDiscovery: true,
    exclude: ['effect', '@opfs-vfs/effect', '@opfs-vfs/opfs-vfs', '@opfs-vfs/plugin-subscriptions'],
  },
});

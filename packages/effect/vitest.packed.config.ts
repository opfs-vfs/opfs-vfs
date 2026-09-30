import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// The extracted examples resolve public packages from .packed/node_modules.
export default defineConfig({
  ...(base as object),
  resolve: { alias: {} },
  test: {
    ...((base as { test?: object }).test ?? {}),
    include: [
      'src/volume-real.test.ts',
      'src/watch-real.test.ts',
      'tests/packed-worker-session.test.ts',
      'tests/packed-subscriptions.test.ts',
      'tests/packed-reconciled-view.test.ts',
      ...(process.env.VITE_PACKED_EFFECT_ENCRYPTED_SESSION ? ['tests/packed-encrypted-session.test.ts'] : []),
    ],
  },
  optimizeDeps: {
    noDiscovery: true,
    exclude: [
      'effect',
      '@opfs-vfs/effect',
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
      '@opfs-vfs/plugin-encryption',
    ],
  },
});

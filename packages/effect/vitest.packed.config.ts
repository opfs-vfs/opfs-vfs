import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// The extracted example resolves public packages from .packed/node_modules.
export default defineConfig({
  ...(base as object),
  resolve: { alias: {} },
  optimizeDeps: {
    noDiscovery: true,
    exclude: ['effect', '@opfs-vfs/effect', '@opfs-vfs/opfs-vfs', '@opfs-vfs/plugin-subscriptions'],
  },
});

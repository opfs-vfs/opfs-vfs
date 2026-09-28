import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...(base as object),
  resolve: { alias: {} },
  optimizeDeps: {
    noDiscovery: true,
    exclude: [
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/opfs-vfs/plugins',
      '@opfs-vfs/opfs-vfs/worker',
      '@opfs-vfs/opfs-vfs/worker-client',
      '@opfs-vfs/opfs-vfs/worker-runtime',
      '@opfs-vfs/plugin-subscriptions',
      '@opfs-vfs/plugin-subscriptions/config',
      '@opfs-vfs/plugin-subscriptions/client',
    ],
  },
  test: {
    ...(base as { test?: object }).test,
    include: ['tests/mixed-build.test.ts'],
    exclude: configDefaults.exclude,
  },
});

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const legacy = process.env.OPFS_VFS_LEGACY_ROOT;
export default defineConfig({
  resolve: {
    alias: {
      '@opfs-vfs/opfs-vfs/worker-runtime': resolve(legacy, '@opfs-vfs/opfs-vfs/dist/worker-runtime.js'),
      '@opfs-vfs/plugin-subscriptions': resolve(legacy, '@opfs-vfs/plugin-subscriptions/dist/index.js'),
    },
  },
  build: {
    lib: { entry: 'src/legacy-worker.ts', formats: ['es'], fileName: 'legacy-worker' },
    outDir: 'dist-legacy',
    emptyOutDir: true,
  },
});

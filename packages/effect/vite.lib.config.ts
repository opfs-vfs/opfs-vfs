import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es', rollupOptions: { output: { codeSplitting: false } } },
  build: {
    lib: { entry: { index: 'src/index.ts', volume: 'src/volume.ts', errors: 'src/errors.ts' }, formats: ['es'] },
    rollupOptions: {
      external: (id) => id === 'effect' || id.startsWith('effect/') || id.startsWith('@opfs-vfs/'),
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});

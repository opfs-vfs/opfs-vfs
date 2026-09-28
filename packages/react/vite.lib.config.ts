import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    lib: { entry: { index: 'src/index.ts' }, formats: ['es'] },
    rollupOptions: { external: (id) => id === 'react' || id.startsWith('react/') || id.startsWith('@opfs-vfs/') },
    outDir: 'dist',
    emptyOutDir: true,
  },
});

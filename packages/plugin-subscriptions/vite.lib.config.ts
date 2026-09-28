import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: { index: 'src/index.ts', config: 'src/config.ts', client: 'src/client.ts' }, formats: ['es'] },
    rollupOptions: { external: (id) => id === '@opfs-vfs/opfs-vfs' || id.startsWith('@opfs-vfs/opfs-vfs/') },
    outDir: 'dist',
    emptyOutDir: true,
  },
});

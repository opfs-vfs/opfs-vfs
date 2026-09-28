import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index', cssFileName: 'styles' },
    rollupOptions: { external: (id) => id === 'react' || id.startsWith('react/') },
  },
});

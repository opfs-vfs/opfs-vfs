import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: 'index', cssFileName: 'styles' },
    rollupOptions: {
      external: (id) =>
        id.startsWith('@opfs-vfs/') ||
        id.startsWith('@base-ui/react/') ||
        id === 'react' ||
        id.startsWith('react/') ||
        id === 'react-dom' ||
        id.startsWith('react-dom/'),
    },
  },
});

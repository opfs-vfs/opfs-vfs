import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default defineConfig({
  plugins: [react()],
  define: {
    __OPFS_VFS_CORE_ARTIFACT__: JSON.stringify(process.env.OPFS_VFS_CORE_ARTIFACT),
    __OPFS_VFS_SUBSCRIPTIONS_ARTIFACT__: JSON.stringify(process.env.OPFS_VFS_SUBSCRIPTIONS_ARTIFACT),
    __OPFS_VFS_REACT_ARTIFACT__: JSON.stringify(process.env.OPFS_VFS_REACT_ARTIFACT),
  },
  server: { headers },
  preview: { headers },
  build: { sourcemap: true },
});

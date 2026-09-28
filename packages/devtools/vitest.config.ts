import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'lucide-react',
      '@base-ui/react/context-menu',
      '@base-ui/react/menu',
      '@base-ui/react/select',
      '@base-ui/react/tabs',
    ],
  },
  server: {
    host: 'localhost',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  test: {
    include: ['src/**/*.browser.spec.ts'],
    fileParallelism: false,
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
  },
});

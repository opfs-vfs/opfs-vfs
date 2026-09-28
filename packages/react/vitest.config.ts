import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const browser = process.env.OPFS_VFS_TEST_BROWSER ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browser))
  throw new Error('OPFS_VFS_TEST_BROWSER must be chromium, firefox, or webkit');
const browserName = browser as 'chromium' | 'firefox' | 'webkit';
const webkitUserDataDir = browser === 'webkit' ? mkdtempSync(join(tmpdir(), 'opfs-vfs-react-webkit-')) : undefined;
if (webkitUserDataDir) process.on('exit', () => rmSync(webkitUserDataDir, { force: true, recursive: true }));
const tlsKey = process.env.VITEST_TLS_KEY;
const tlsCert = process.env.VITEST_TLS_CERT;
if ((tlsKey === undefined) !== (tlsCert === undefined))
  throw new Error('VITEST_TLS_KEY and VITEST_TLS_CERT must be set together');
const https = tlsKey && tlsCert ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) } : undefined;

export default defineConfig({
  define: {
    __OPFS_VFS_REACT_VERSION__: JSON.stringify(process.env.VITE_OPFS_VFS_REACT_VERSION ?? '19.2.4'),
    __OPFS_VFS_REQUIRE_HTTPS__: JSON.stringify(process.env.OPFS_VFS_REQUIRE_HTTPS === 'true'),
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'react-dom/server',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/opfs-vfs/worker',
      '@opfs-vfs/opfs-vfs/worker-runtime',
      '@opfs-vfs/plugin-subscriptions',
      '@opfs-vfs/plugin-subscriptions/client',
      '@opfs-vfs/plugin-subscriptions/config',
    ],
  },
  server: { host: 'localhost', https, headers },
  test: {
    fileParallelism: false,
    include: ['src/**/*.test.{ts,tsx}'],
    browser: {
      enabled: true,
      headless: true,
      headers,
      provider: playwright(webkitUserDataDir ? { persistentContext: webkitUserDataDir } : undefined),
      instances: [{ browser: browserName }],
    },
  },
});

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browser = process.env.OPFS_VFS_TEST_BROWSER ?? 'chromium';
if (browser !== 'chromium' && browser !== 'webkit') throw new Error('OPFS_VFS_TEST_BROWSER must be chromium or webkit');
const webkitUserDataDir = browser === 'webkit' ? mkdtempSync(join(tmpdir(), 'opfs-vfs-effect-webkit-')) : undefined;
if (webkitUserDataDir) process.on('exit', () => rmSync(webkitUserDataDir, { force: true, recursive: true }));

export default defineConfig({
  optimizeDeps: {
    include: ['effect', '@opfs-vfs/opfs-vfs', '@opfs-vfs/opfs-vfs/plugins'],
  },
  server: {
    host: 'localhost',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  test: {
    fileParallelism: false,
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(
        webkitUserDataDir
          ? { persistentContext: webkitUserDataDir }
          : {
              launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
                ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
                : undefined,
            },
      ),
      instances: [{ browser: browser as 'chromium' | 'webkit' }],
    },
  },
});

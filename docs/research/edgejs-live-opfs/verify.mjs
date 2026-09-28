import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../../..');
const sdk = process.env.WASMER_SDK_DIR;
assert(sdk, 'Set WASMER_SDK_DIR to the patched wasmer-sdk checkout');
const require = createRequire(resolve(repo, 'packages/opfs-vfs/package.json'));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = require('playwright');
const server = await createServer({
  configFile: false,
  root,
  publicDir: resolve(sdk, 'js'),
  resolve: { alias: { '/@opfs-source': resolve(repo, 'packages/opfs-vfs/src') } },
  server: {
    host: '127.0.0.1',
    port: 4337,
    strictPort: true,
    fs: { allow: [repo, sdk] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  optimizeDeps: { noDiscovery: true },
  worker: { format: 'es' },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => console.log(m.type(), m.text()));
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:4337');
  await page.waitForFunction(() => window.results.some((r) => r.stage === 'closed'), {}, { timeout: 240000 });
  const results = await page.evaluate(() => window.results);
  const evidence = { browser: browser.version(), pageErrors, results };
  await writeFile(resolve(root, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert(
    results.some((r) => r.stage === 'PASS'),
    'missing PASS',
  );
  assert(!results.some((r) => r.stage === 'FAIL' || r.error), 'probe failed');
  assert.deepEqual(pageErrors, []);
  console.log('Verified live OPFS and fresh-runtime persistence.');
} finally {
  await browser?.close();
  await server.close();
}

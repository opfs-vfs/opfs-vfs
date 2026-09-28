// A separate cold dev server is required: production previews never optimize dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'opfs-benchmark-dev-'));
const config = join(temporary, 'astro.config.mjs');
await writeFile(
  config,
  `import base from ${JSON.stringify(new URL('astro.config.mjs', root).href)};\nexport default {...base, vite: {...base.vite, cacheDir: ${JSON.stringify(join(temporary, 'cache'))}}};\n`,
);
const server = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('node_modules/astro/bin/astro.mjs', root)),
    'dev',
    '--ignore-lock',
    '--config',
    relative(fileURLToPath(root), config),
    '--host',
    '127.0.0.1',
    '--port',
    '4337',
  ],
  {
    cwd: root,
    env: { ...process.env, ASTRO_DEV_BACKGROUND: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
server.stdout.on('data', (chunk) => {
  output += chunk;
});
server.stderr.on('data', (chunk) => {
  output += chunk;
});
let browser;
try {
  for (let attempt = 0; !output.includes('watching for file changes'); attempt++) {
    assert.ok(server.exitCode === null && attempt < 120, `Dev server did not start:\n${output}`);
    await delay(250);
  }
  assert.ok(output.includes('http://127.0.0.1:4337/'), 'Regression port 4337 is already in use');
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4337/benchmarks/run/');
  await page.waitForLoadState('networkidle');
  let reloads = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) reloads++;
  });
  for (const [label, option] of [
    ['Rows', '100'],
    ['Runs', '1'],
  ]) {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  }
  await page.getByRole('switch', { name: 'Persistent storage only' }).click();
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect
    .poll(async () => (reloads ? 'RELOADED' : await page.getByRole('status').innerText()), { timeout: 90_000 })
    .toMatch(/Complete|RELOADED/);
  assert.equal(reloads, 0, `First benchmark run reloaded the page:\n${output}`);
  await expect(page.getByText('Failed, unavailable, or cancelled samples')).toHaveCount(0);
  await expect(
    page.getByRole('table', { name: 'Median timings from successful samples.' }).getByRole('row'),
  ).toHaveCount(5);
  console.log('Cold dev server: all four benchmark backends completed without a page reload.');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const closed = once(server, 'exit');
    server.kill('SIGTERM');
    await closed;
  }
  await rm(temporary, { recursive: true, force: true });
}

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

test('EdgeJS demo persists, recovers normal errors, previews files and confines reset', async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sdkResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/vendor/edgejs/') && new URL(response.url()).pathname.endsWith('/sdk/dist/index.js'),
  );
  await page.goto('/demos/edgejs/');
  expect((await sdkResponse).status(), 'The worker must load the prebuilt SDK as a static asset').toBe(200);
  const run = page.getByRole('button', { name: 'Run program' });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  const code = page.getByLabel('Program', { exact: true });
  const initial = await code.inputValue();
  await page.getByRole('button', { name: 'Reset demo files' }).click();
  await expect(page.getByRole('status')).toContainText('Demo files reset');
  await run.click();
  await expect(page.locator('.edgejs-output pre')).toContainText('Counter: 1');
  await page.getByRole('button', { name: 'counter.txt 1 B' }).click();
  await expect(page.locator('.edgejs-files pre')).toHaveText('1');
  await page.reload();
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await run.click();
  await expect(page.locator('.edgejs-output pre')).toContainText('Counter: 2');

  const second = await context.newPage();
  await second.goto('/demos/edgejs/');
  await expect(second.getByRole('alert')).toContainText('another tab');
  await expect(second.getByRole('button', { name: 'Run program' })).toBeDisabled();
  await second.close();

  await code.fill("throw new Error('intentional demo error');");
  await run.click();
  await expect(page.getByRole('status')).toContainText('exited with code');
  await expect(page.locator('.edgejs-output pre')).toContainText('intentional demo error');
  await code.fill(initial);
  await run.click();
  await expect(page.locator('.edgejs-output pre')).toContainText('Counter: 3');
  await page.screenshot({ path: info.outputPath('edgejs-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('edgejs-mobile.png'), fullPage: true });

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('edgejs-unrelated-sentinel', { create: true });
    const writable = await file.createWritable();
    await writable.write('untouched');
    await writable.close();
  });
  await code.fill(
    "const fs=require('node:fs');fs.mkdirSync('/data/nested');fs.writeFileSync('/data/nested/note','hello');console.log('x'.repeat(100000));",
  );
  await run.click();
  await expect(page.getByRole('status')).toContainText('Program finished');
  await expect(page.locator('.edgejs-output pre')).toContainText('Output limited');
  expect((await page.locator('.edgejs-output pre').innerText()).length).toBeLessThan(66_000);
  await page.getByRole('button', { name: 'Reset demo files' }).click();
  await expect(page.getByText('No saved files yet.')).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const content = await (await (await root.getFileHandle('edgejs-unrelated-sentinel')).getFile()).text();
      await root.removeEntry('edgejs-unrelated-sentinel');
      return content;
    }),
  ).toBe('untouched');

  await code.fill('setInterval(() => {}, 100);');
  await run.click();
  await expect(page.getByRole('alert')).toContainText('Reload this page', { timeout: 45_000 });
  await expect(run).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset demo files' })).toBeDisabled();
  await page.reload();
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByRole('alert')).toContainText('restored');
  await expect(run).toBeDisabled();
  expect(errors).toEqual([]);
});

test('host downloads match checksums and serve a compilable Wasm module', async ({ page, request }) => {
  await page.goto('/docs/integrations/edgejs/');
  const prefix = '/vendor/edgejs/0.2.0-opfs-vfs.1/';
  const manifest = await (await request.get(`${prefix}build.json`)).json();
  for (const [name, expected] of Object.entries(manifest.assets) as [string, { sha256: string; bytes: number }][]) {
    const response = await request.get(prefix + name);
    expect(response.ok(), name).toBe(true);
    const bytes = await response.body();
    expect(bytes.length, name).toBe(expected.bytes);
    expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(expected.sha256);
  }
  expect((await request.get(`${prefix}sdk/pkg/wasmer_sdk_js_bg.wasm`)).headers()['content-type']).toContain(
    'application/wasm',
  );
  expect(
    await page.evaluate(async (root) => {
      const sdk = await import(/* @vite-ignore */ `${root}sdk/dist/index.js`);
      await WebAssembly.compileStreaming(fetch(`${root}sdk/pkg/wasmer_sdk_js_bg.wasm`));
      return sdk.SYNC_FILESYSTEM_ABI;
    }, prefix),
  ).toBe(1);
});

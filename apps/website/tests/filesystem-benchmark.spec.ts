import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { choose } from './ui';

for (const buffer of ['memory', 'disk'])
  test(`native filesystem benchmark verifies and cleans ${buffer} buffers`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/benchmarks/filesystem/');
    await choose(page, 'Runs', '1');
    await choose(page, 'Buffer', buffer);
    await page.getByRole('button', { name: 'Run filesystem benchmark' }).click();
    await expect(page.getByRole('status')).toHaveText('Complete', { timeout: 60000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const download = await downloadPromise;
    const report = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(report.config.bufferMode).toBe(buffer);
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0].status).toBe('ok');
    expect(report.samples[0].verifiedFiles).toBe(50);
    expect(Object.keys(report.samples[0].timings)).toHaveLength(7);
    expect(
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
          if (name.startsWith('website-fs-bench-')) names.push(name);
        return names;
      }),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });

test('native filesystem cancellation finishes cleanup and permits rerun', async ({ page }) => {
  await page.goto('/benchmarks/filesystem/');
  await choose(page, 'Files', '1000');
  await choose(page, 'Buffer', 'disk');
  await page.getByRole('button', { name: 'Run filesystem benchmark' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Complete', { timeout: 60000 });
  await expect(page.getByText(/Questionable run:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run filesystem benchmark' })).toBeEnabled();
});

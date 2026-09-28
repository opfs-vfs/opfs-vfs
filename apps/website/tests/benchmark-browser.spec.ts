import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { choose } from './ui';

test('four PGlite backends run the bounded workload and retain raw results', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/benchmarks/run/');
  await page.getByRole('switch', { name: 'Persistent storage only' }).click();
  await choose(page, 'Rows', '100');
  await choose(page, 'Runs', '1');
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page.getByRole('status')).toHaveText('Complete', { timeout: 210_000 });
  const table = page.getByRole('table', { name: 'Median timings from successful samples.' });
  for (const backend of ['OPFS VFS', 'PGlite OPFS AHP', 'PGlite IndexedDB', 'PGlite memory']) {
    const row = table.getByRole('row').filter({ hasText: backend });
    await expect(row).toContainText('1');
  }
  await expect(page.getByText('Failed, unavailable, or cancelled samples')).toHaveCount(0);
  for (const column of [3, 4, 5, 6]) {
    expect(await table.locator(`tbody td:nth-child(${column}).benchmark-fastest`).count()).toBeGreaterThan(0);
  }
  for (const column of [5, 6])
    await expect(
      table.getByRole('row').filter({ hasText: 'PGlite memory' }).locator(`td:nth-child(${column})`),
    ).not.toHaveClass(/benchmark-fastest/);
});

test('benchmark cancellation finishes cleanup and records interruption', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/benchmarks/run/');
  await page.getByRole('switch', { name: 'Persistent storage only' }).click();
  await choose(page, 'Rows', '10000');
  await choose(page, 'Runs', '5');
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled', { timeout: 100_000 });
  await expect(page.locator('.benchmark-ranked')).toHaveCount(0);
  await expect(page.getByText('Questionable run: the page was hidden or interrupted.')).toBeVisible();
});

test('canonical PGlite suite compares all backends and exports each case', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/benchmarks/run/');
  await page.getByRole('switch', { name: 'Persistent storage only' }).click();
  await choose(page, 'Workload', 'PGlite speed tests · 16 cases');
  await expect(page.getByRole('combobox', { name: 'Rows', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'VFS buffer', exact: true })).toContainText('disk');
  await choose(page, 'Runs', '1');
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page.getByRole('status')).toHaveText('Complete', { timeout: 270_000 });
  await expect(page.getByText('Failed, unavailable, or cancelled samples')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Per-case medians' }).getByRole('row')).toHaveCount(17);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  expect(report.schemaVersion).toBe(2);
  expect(report.config).toMatchObject({
    workload: 'pglite-speedtest',
    rows: null,
    bufferMode: 'disk',
    relaxedDurability: false,
  });
  expect(report.metadata.workloadRevision).toBe('pglite-speedtest16-ae182ff8-v1');
  expect(report.samples).toHaveLength(4);
  const caseRows = page.getByRole('table', { name: 'Per-case medians' }).locator('tbody tr');
  for (let index = 0; index < 16; index++) {
    const durations = report.samples.map(
      (sample: { stages: { durationMs: number }[] }) => sample.stages[index]!.durationMs,
    );
    const ordered = [...durations].sort((a, b) => a - b);
    for (let backend = 0; backend < durations.length; backend++) {
      const cell = caseRows.nth(index).getByRole('cell').nth(backend);
      const rank = ordered.indexOf(durations[backend]) + 1;
      if (rank <= 3) await expect(cell).toHaveAttribute('data-rank', String(rank));
      else await expect(cell).not.toHaveAttribute('data-rank');
    }
  }
  for (const sample of report.samples) {
    expect(sample.status).toBe('ok');
    expect(sample.stages.map((stage: { id: number }) => stage.id)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(sample.workloadMs).toBeCloseTo(
      sample.stages.reduce((sum: number, stage: { durationMs: number }) => sum + stage.durationMs, 0),
      6,
    );
    expect(sample.reopenMs === null).toBe(sample.backend === 'memory');
  }
});

test('memory speed suite receives cancellation between SQL cases', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/benchmarks/run/');
  await page.getByRole('switch', { name: 'Persistent storage only' }).click();
  await choose(page, 'Workload', 'PGlite speed tests · 16 cases');
  await choose(page, 'Runs', '1');
  for (const name of ['OPFS VFS', 'PGlite OPFS AHP', 'PGlite IndexedDB'])
    await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page.getByRole('status')).toContainText('/16 ·', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  expect(report.samples).toHaveLength(1);
  expect(report.samples[0].status).toBe('cancelled');
  expect(report.samples[0].stages.length).toBeGreaterThan(0);
  expect(report.samples[0].stages.length).toBeLessThan(16);
});

test('persistence comparison defaults to disk backends and preserves completed results when toggled', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/benchmarks/run/');
  const toggle = page.getByRole('switch', { name: 'Persistent storage only' });
  const memory = page.getByRole('checkbox', { name: 'PGlite memory', exact: true });
  await expect(toggle).toBeChecked();
  await expect(memory).not.toBeChecked();
  // Keyboard operation and checkbox selection must reflect the same backend selection.
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect(memory).toBeChecked();
  await expect(memory).toHaveAttribute('data-checked');
  for (const name of ['OPFS VFS', 'PGlite OPFS AHP', 'PGlite IndexedDB'])
    await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(memory).not.toHaveAttribute('data-checked');
  for (const name of ['OPFS VFS', 'PGlite OPFS AHP', 'PGlite IndexedDB'])
    await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await choose(page, 'Rows', '100');
  await choose(page, 'Runs', '1');
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(toggle).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Complete', { timeout: 90_000 });
  await expect(page.getByText('Failed, unavailable, or cancelled samples')).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Median timings from successful samples.' });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await memory.check();
  await expect(toggle).not.toBeChecked();
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(page.getByText('Results: Persistent storage only', { exact: false })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  expect(report.config.backends).toEqual(['opfs-vfs', 'opfs-ahp', 'idb']);
  expect(report.samples).toHaveLength(3);
});

for (const workload of ['Insert + query', 'PGlite speed tests · 16 cases']) {
  test(`IndexedDB closes both instances before deleting benchmark storage: ${workload}`, async ({ page }) => {
    await page.goto('/benchmarks/run/');
    await page.getByRole('checkbox', { name: 'OPFS VFS', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'PGlite OPFS AHP', exact: true }).uncheck();
    await choose(page, 'Workload', workload);
    if (workload === 'Insert + query') await choose(page, 'Rows', '100');
    await choose(page, 'Runs', '3');
    await page.getByRole('button', { name: 'Run benchmark' }).click();
    await expect(page.getByRole('status')).toHaveText('Complete', { timeout: 60000 });
    await expect(page.getByText('Failed, unavailable, or cancelled samples')).toHaveCount(0);
    await page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        (window as unknown as { benchmarkExport: Blob }).benchmarkExport = blob as Blob;
        return original(blob);
      };
      HTMLAnchorElement.prototype.click = () => {};
    });
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const report = JSON.parse(
      await page.evaluate(() => (window as unknown as { benchmarkExport: Blob }).benchmarkExport.text()),
    );
    expect(report.samples).toHaveLength(3);
    for (const sample of report.samples)
      expect(sample).toMatchObject({
        backend: 'idb',
        status: 'ok',
        actualRows: workload === 'Insert + query' ? 100 : 0,
      });
    expect(
      await page.evaluate(async () =>
        (await indexedDB.databases()).filter((db) => db.name?.includes('website-bench-')),
      ),
    ).toEqual([]);
  });
}

test('unhandled worker rejection stops the runner with an error', async ({ page }) => {
  await page.route('**/benchmark.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\nsetTimeout(() => Promise.reject(new Error('Invalid platform file handle test')), 0);`,
    });
  });
  await page.goto('/benchmarks/run/');
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await expect(page.locator('.benchmark-runner .error')).toContainText('Invalid platform file handle test');
  await expect(page.getByRole('status')).toHaveText('Failed');
  await expect(page.getByRole('button', { name: 'Run benchmark' })).toBeEnabled();
});

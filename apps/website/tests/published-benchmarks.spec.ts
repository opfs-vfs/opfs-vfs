import { expect, test } from '@playwright/test';

test('comparison filters synchronize charts, rows, memory reference and rankings', async ({ page }) => {
  await page.goto('/benchmarks/');
  const published = page.locator('.published');
  const table = page.getByRole('region', { name: '16-case SQL suite comparison table', exact: true });
  await expect(page.getByRole('heading', { name: 'Benchmark results' })).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(8);
  await expect(table.getByRole('columnheader', { name: 'Memory-only reference' })).toHaveCount(0);
  const chromeM5 = table.locator('tbody').first().locator('tr[data-machine="m5-pro"]');
  await expect(chromeM5.locator('td').first()).toContainText('2,026.98');
  await expect(chromeM5.locator('td').first().locator('.rank-persistent')).toHaveText('1st');
  await expect(chromeM5.locator('td').nth(2).locator('.rank-persistent')).toHaveText('2nd');
  await expect(chromeM5.locator('td').nth(3).locator('.rank-persistent')).toHaveText('3rd');
  await expect(table.locator('tbody').nth(1).locator('tr').first().locator('td').nth(2)).toHaveText(
    'File-handle issue',
  );
  const chart = published.locator('[data-workload-panel="pglite-speedtest"] .browser-chart').first();
  const width = await chart.locator('.bar.m5-pro').first().getAttribute('style');
  await page.getByRole('checkbox', { name: /Show memory-only reference/ }).check();
  await expect(table.getByRole('columnheader', { name: 'Memory-only reference' })).toBeVisible();
  await expect(chromeM5.locator('td').first().locator('.rank-all')).toHaveText('2nd');
  await expect(chromeM5.locator('td').last().locator('.rank-all')).toHaveText('1st');
  await page.getByRole('checkbox', { name: 'Mac Studio · M1 Max', exact: true }).uncheck();
  await expect(table.getByRole('row')).toHaveCount(5);
  await expect(chart.locator('[data-machine="m1-max"]:visible')).toHaveCount(0);
  await expect(chart.locator('.bar.m5-pro').first()).toHaveAttribute('style', width!);
  await page.getByRole('checkbox', { name: 'MacBook Pro · M5 Pro', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'iPhone 17 Pro', exact: true }).uncheck();
  await expect(page.getByRole('status')).toHaveText('Select a device to show results.');
  await expect(table).toBeHidden();
  await page.getByRole('checkbox', { name: 'Mac Studio · M1 Max', exact: true }).check();
  await page.getByRole('radio', { name: '10,000-row transaction batch' }).check();
  const transactions = page.getByRole('region', { name: '10,000-row transaction batch comparison table', exact: true });
  await expect(transactions).toBeVisible();
  await expect(transactions.locator('tbody').first().getByRole('row')).toContainText('33.84');
  await expect(table).toBeHidden();
  await page.getByRole('checkbox', { name: /Show memory-only reference/ }).uncheck();
  await page.getByText('Environment and detailed timings', { exact: true }).click();
  await expect(page.locator('#results-m5-pro')).toBeHidden();
  await page.locator('#results-m1-max summary').filter({ hasText: 'Firefox:' }).click();
  await expect(page.locator('#results-m1-max [data-reference]').first()).toBeHidden();
  await expect(published).not.toContainText('GiB');
  await expect(published.getByRole('link', { name: 'Chrome JSON', exact: true })).toHaveCount(0);
  await page.getByText('Data and methodology', { exact: true }).click();
  await expect(published.getByRole('link', { name: 'Chrome JSON', exact: true })).toHaveCount(2);
  const response = await page.request.get('/benchmarks/results/2026-09-23/m1-max/firefox.json');
  expect(response.ok()).toBe(true);
  expect((await response.json()).environment.browserVersion).toBe('156.0.1');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(transactions).toHaveAttribute('tabindex', '0');
});

test('iPhone shares charts, filters and rankings without inventing missing measurements', async ({ page }) => {
  await page.goto('/benchmarks/');
  const table = page.getByRole('region', { name: '16-case SQL suite comparison table', exact: true });
  const phone = table.locator('tr[data-machine="iphone"]');
  await expect(phone).toContainText('Safari');
  await expect(phone).toContainText('3 runs');
  await expect(phone.locator('td').nth(0)).toContainText('2,101.38');
  await expect(phone.locator('td').nth(0).locator('.rank-persistent')).toHaveText('2nd');
  await expect(phone.locator('td').nth(1)).toContainText('2,327.72');
  await expect(phone.locator('td').nth(2)).toContainText('2,075.8');
  await expect(phone.locator('td').nth(2).locator('.rank-persistent')).toHaveText('1st');
  await expect(phone.locator('td').nth(3)).toContainText('4,063.26');
  await page.getByRole('checkbox', { name: /Show memory-only reference/ }).check();
  await expect(phone.locator('td').last()).toContainText('1,960.38');
  await expect(phone.locator('td').last().locator('.rank-all')).toHaveText('1st');
  await page.getByRole('checkbox', { name: 'MacBook Pro · M5 Pro', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Mac Studio · M1 Max', exact: true }).uncheck();
  await expect(table.getByRole('row')).toHaveCount(2);
  const panel = page.locator('[data-workload-panel="pglite-speedtest"]');
  await expect(panel.locator('.browser-chart:visible')).toHaveCount(1);
  await expect(panel.locator('.bar.iphone:visible')).toHaveCount(5);
  await page.getByRole('radio', { name: '10,000-row transaction batch' }).check();
  const transactions = page.getByRole('region', { name: '10,000-row transaction batch comparison table', exact: true });
  await expect(transactions.locator('tr[data-machine="iphone"] td').nth(0)).toContainText('19.34');
  await expect(transactions.locator('tr[data-machine="iphone"] td').nth(1)).toContainText('28.72');
  await expect(transactions.locator('tr[data-machine="iphone"] td').nth(2)).toContainText('21.84');
  await expect(transactions.locator('tr[data-machine="iphone"] td').nth(3)).toContainText('155.64');
  await expect(transactions.locator('tr[data-machine="iphone"] td').nth(1)).toHaveAttribute(
    'data-rank-persistent',
    '3',
  );
  await expect(page.locator('[data-workload-panel="transactions"] .bar.iphone')).toHaveCount(5);
  await page.getByText('Environment and detailed timings', { exact: true }).click();
  await expect(page.locator('.iphone-results')).toContainText('carried over');
  await expect(page.locator('.iphone-results')).toContainText('100 files, compared with 1,000');
  await expect(page.locator('.iphone-results').getByRole('row').filter({ hasText: 'Mount' })).toContainText('8.58');
  await expect(page.locator('.iphone-results')).toContainText('exact source commit is unavailable');
  await page.getByRole('checkbox', { name: 'iPhone 17 Pro', exact: true }).uncheck();
  await expect(page.locator('.iphone-results')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('runner status wraps without moving controls at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ['/benchmarks/run/', '/benchmarks/filesystem/']) {
    await page.goto(url);
    const runner = page.locator('.benchmark-runner');
    const status = runner.getByRole('status');
    await expect(status).toHaveText('Ready');
    const before = await runner.locator('fieldset').first().boundingBox();
    await status.evaluate((element) => {
      element.textContent = 'PGlite OPFS AHP · run 12/12 · 16/16 · 100 SELECTs without an index '.repeat(4);
    });
    const after = await runner.locator('fieldset').first().boundingBox();
    expect(after!.y).toBe(before!.y);
    expect(await status.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await status.focus();
    await expect(status).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

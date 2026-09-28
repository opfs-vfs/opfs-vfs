import { expect, test } from '@playwright/test';

test('DuckDB runs SQL, persists tables, reopens safely and bounds displayed results', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sdkResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/duckdb.js'));
  await page.goto('/demos/duckdb/');
  expect((await sdkResponse).status()).toBe(200);
  const run = page.getByRole('button', { name: 'Run SQL', exact: true });
  await expect(run).toBeEnabled({ timeout: 90_000 });
  const sql = page.getByLabel('SQL', { exact: true });
  const results = page.getByRole('table', { name: 'SQL results', exact: true });
  async function query(value: string) {
    await sql.fill(value);
    await run.click();
    await expect(run).toBeEnabled();
  }
  const prepare = page.getByRole('button', { name: 'Prepare or reuse data', exact: true });
  await prepare.click();
  await expect(page.locator('.duckdb-preparation')).toContainText('1,000,000 rows');
  await run.click();
  await expect(results.getByRole('cell')).toHaveText('50099500000');
  await page.getByRole('button', { name: 'Group by region', exact: true }).click();
  await run.click();
  await expect(results.getByRole('row')).toHaveCount(9);
  await expect(results.getByRole('cell').nth(1)).toHaveText('6262875000');
  await query('SELECT count(*) AS rows FROM opfs_demo_sales_v1;');
  await expect(results.getByRole('cell')).toHaveText('1000000');
  await query('UPDATE opfs_demo_sales_v1 SET revenue_cents = revenue_cents + 1 WHERE event_id = 0;');
  await prepare.click();
  await expect(page.locator('.duckdb-preparation')).toContainText('1,000,000 rows');
  await query('SELECT sum(revenue_cents) FROM opfs_demo_sales_v1;');
  await expect(results.getByRole('cell')).toHaveText('50099500001');
  await query('SELECT 12.75::DECIMAL(10,2) AS price, -0.05::DECIMAL(10,2) AS refund;');
  await expect(results.getByRole('cell')).toHaveText(['12.75', '-0.05']);
  await query('CREATE TABLE kept (value BIGINT); INSERT INTO kept VALUES (9223372036854775807); SELECT * FROM kept;');
  await expect(results).toContainText('9223372036854775807');
  await page.reload();
  await expect(run).toBeEnabled({ timeout: 90_000 });
  await query('SELECT sum(revenue_cents) FROM opfs_demo_sales_v1;');
  await expect(results.getByRole('cell')).toHaveText('50099500001');
  await query('SELECT * FROM kept;');
  await expect(results).toContainText('9223372036854775807');
  const reopen = page.getByRole('button', { name: 'Save & reopen', exact: true });
  await reopen.click();
  await expect(page.getByRole('status')).toContainText('Database saved and reopened');
  await query('SELECT sum(revenue_cents) FROM opfs_demo_sales_v1;');
  await expect(results.getByRole('cell')).toHaveText('50099500001');
  await query('SELECT * FROM kept;');
  await expect(results).toContainText('9223372036854775807');

  await query('not valid sql;');
  await expect(page.getByRole('alert')).toContainText('Earlier statements may already have committed');
  await query('SELECT 42 AS answer;');
  await expect(results).toContainText('42');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await query('BEGIN; INSERT INTO kept VALUES (123);');
  await reopen.click();
  await expect(page.getByRole('alert')).toContainText('database was not reopened');
  await expect(run).toBeEnabled();
  await query('ROLLBACK; SELECT count(*) AS entries FROM kept;');
  await expect(results.getByRole('cell')).toHaveText('1');

  const second = await context.newPage();
  await second.goto('/demos/duckdb/');
  await expect(second.getByRole('alert')).toContainText('another tab');
  await expect(second.getByRole('button', { name: 'Run SQL', exact: true })).toBeDisabled();
  await second.close();
  await query("SELECT i, repeat('x', 800) AS long_text FROM range(250) t(i);");
  await expect(results.getByRole('row')).toHaveCount(201);
  await expect(page.getByText('Preview limited to', { exact: false })).toBeVisible();
  expect((await results.getByRole('cell').nth(1).innerText()).length).toBe(501);
  await query(`SELECT ${Array.from({ length: 40 }, (_, i) => `${i} AS column_${i}`).join(',')};`);
  await expect(results.getByRole('columnheader')).toHaveCount(32);
  await query('SELECT NULL AS empty;');
  await expect(results).toContainText('NULL');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/opfs-duckdb-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Sum one column' }).click();
  await run.click();
  await expect(results.getByRole('cell')).toHaveText('50099500001');
  await page.screenshot({ path: '/tmp/opfs-duckdb-desktop.png', fullPage: true });
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByRole('alert')).toContainText('restored');
  await expect(run).toBeDisabled();
  expect(errors).toEqual([]);
});

test('DuckDB reports a failed Wasm download and stops initialization', async ({ page, context }) => {
  await context.route('**/vendor/duckdb/**/duckdb.wasm', (route) => route.abort());
  await page.goto('/demos/duckdb/');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Run SQL', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reload database' })).toBeVisible();
});

test('DuckDB stops an overlong query and requires reopening before further writes', async ({ page }) => {
  await page.goto('/demos/duckdb/');
  const run = page.getByRole('button', { name: 'Run SQL', exact: true });
  await expect(run).toBeEnabled({ timeout: 90_000 });
  await page.clock.install();
  await page
    .getByLabel('SQL', { exact: true })
    .fill('SELECT sum(sin(a.i * b.i)) FROM range(1000000000) a(i), range(1000000000) b(i);');
  await run.click();
  await page.clock.fastForward(16_000);
  await expect(page.getByRole('alert')).toContainText('timed out');
  await expect(run).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reload database' })).toBeVisible();
});

test('DuckDB initialization has a deadline when the engine download stalls', async ({ page, context }) => {
  let release: (() => void) | undefined;
  let requested!: () => void;
  const wasmRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await context.route('**/vendor/duckdb/**/duckdb.wasm', async (route) => {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    requested();
    await held;
    await route.abort();
  });
  try {
    await page.clock.install();
    await page.goto('/demos/duckdb/');
    await wasmRequested;
    await page.clock.fastForward(91_000);
    await expect(page.getByRole('alert')).toContainText('timed out');
    await expect(page.getByRole('button', { name: 'Run SQL', exact: true })).toBeDisabled();
  } finally {
    release?.();
  }
});

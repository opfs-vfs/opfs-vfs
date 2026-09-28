import { expect, test, type Page } from '@playwright/test';
import { choose, continueDialog } from './ui';

async function query(page: Page, sql: string) {
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  const responses = page.locator('.PGliteRepl-output > div');
  const before = await responses.count();
  await editor.click();
  await page.keyboard.type(sql);
  await page.keyboard.press('Enter');
  await expect(responses).toHaveCount(before + 1, { timeout: 30_000 });
}

// Creating a database initializes two workers in sequence; each can take up to 30 seconds.
async function expectDatabaseReady(page: Page, expected: string | RegExp = /Leader|Connected/) {
  await expect(page.getByRole('status')).toContainText(expected, { timeout: 65_000 });
}

test('leader handoff cancels pending debug metadata without an unhandled rejection', async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto('/demos/pglite/');
  await expectDatabaseReady(page, 'Leader');
  const follower = await context.newPage();
  const errors: string[] = [];
  follower.on('pageerror', (error) => errors.push(error.message));
  await follower.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the original channel receiver.
    const postMessage = BroadcastChannel.prototype.postMessage;
    let requests = 0;
    BroadcastChannel.prototype.postMessage = function (message) {
      if (message.type === 'rpc-call' && message.method === 'getDebugLevel') {
        document.documentElement.dataset.debugRequests = String(++requests);
        // Keep the first real metadata RPC pending until the leader closes.
        if (requests === 1) return;
      }
      return postMessage.call(this, message);
    };
  });
  await follower.goto('/demos/pglite/');
  await expectDatabaseReady(follower, 'Connected');
  await query(follower, 'SELECT 42 AS before_handoff');
  await expect(follower.locator('html')).toHaveAttribute('data-debug-requests', '1');
  await page.close();
  await expect(follower.getByRole('status')).toContainText('Leader', { timeout: 20_000 });
  await expect(follower.locator('html')).toHaveAttribute('data-debug-requests', '2');
  await query(follower, 'SELECT 43 AS after_handoff');
  await expect(follower.getByRole('cell', { name: '43', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('official REPL persists through multi-tab handoff, archive import, and volume reset', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `db-${Date.now()}`;
  await page.goto('/demos/pglite/');
  await expectDatabaseReady(page);
  const second = await context.newPage();
  second.on('pageerror', (error) => errors.push(error.message));
  await second.goto('/demos/pglite/');
  await expectDatabaseReady(second);
  await page.getByLabel('New database').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expectDatabaseReady(page, new RegExp(`${name}.*(?:Leader|Connected)`));
  await query(page, `CREATE TABLE handoff(value TEXT); INSERT INTO handoff VALUES ('kept-${name}')`);
  await query(page, 'SELECT value FROM handoff');
  await expect(page.locator('.PGliteRepl-output')).toContainText(`kept-${name}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved to persistent storage');

  await choose(second, 'Database', name);
  await expectDatabaseReady(second, new RegExp(`${name}.*(?:Leader|Connected)`));
  await query(second, 'SELECT value FROM handoff');
  await expect(second.locator('.PGliteRepl-output')).toContainText(`kept-${name}`);
  await page.close();
  await expect(second.getByRole('status')).toContainText('Leader', { timeout: 20_000 });
  await query(second, 'SELECT COUNT(*)::int AS count_after_handoff FROM handoff');
  await expect(second.locator('.PGliteRepl-output')).toContainText('count_after_handoff');

  const downloadPromise = second.waitForEvent('download', { timeout: 30_000 });
  await second.getByRole('button', { name: 'Export PGlite archive' }).click();
  const archive = await downloadPromise;
  const archivePath = test.info().outputPath(archive.suggestedFilename());
  await archive.saveAs(archivePath);

  const imported = `${name}-copy`;
  await second.getByLabel('New database').fill(imported);
  await second.locator('input[type=file]').setInputFiles(archivePath!);
  await expectDatabaseReady(second, new RegExp(`${imported}.*(?:Leader|Connected)`));
  await query(second, 'SELECT value FROM handoff');
  await expect(second.locator('.PGliteRepl-output')).toContainText(`kept-${name}`);

  await second.getByRole('button', { name: 'Reset volume' }).click();
  await continueDialog(second);
  await expectDatabaseReady(second, new RegExp(`${imported}.*(?:Leader|Connected)`));
  await query(second, "SELECT to_regclass('public.handoff') IS NULL AS removed");
  await expect(second.locator('.PGliteRepl-output')).toContainText('true');
  expect(errors).toEqual([]);
});

test('temporary memory starts empty after reopen', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/demos/pglite/');
  await choose(page, 'Storage', 'Temporary memory');
  await expectDatabaseReady(page, 'Temporary memory');
  await query(page, 'CREATE TABLE temporary_rows(value INTEGER); INSERT INTO temporary_rows VALUES (1)');
  await query(page, 'SELECT COUNT(*)::int AS count FROM temporary_rows');
  await expect(page.locator('.PGliteRepl-output')).toContainText('1');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expectDatabaseReady(page, 'Temporary memory');
  await query(page, "SELECT to_regclass('public.temporary_rows') IS NULL AS removed");
  await expect(page.locator('.PGliteRepl-output')).toContainText('true');
});

test('malformed imports report an error and leave the current database usable', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/demos/pglite/');
  await expectDatabaseReady(page);
  await page.getByLabel('New database').fill(`bad-${Date.now()}`);
  await page.locator('input[type=file]').setInputFiles({
    name: 'malformed.pglite.tgz',
    mimeType: 'application/gzip',
    buffer: Buffer.from('not a gzip archive'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await query(page, 'SELECT 1 AS still_connected');
  await expect(page.locator('.PGliteRepl-output')).toContainText('still_connected');
});

test('default database recovers when its registry entry is missing', async ({ page }) => {
  await page.goto('/demos/pglite/');
  await expectDatabaseReady(page);
  await query(page, 'CREATE TABLE recovered(value INTEGER); INSERT INTO recovered VALUES (42)');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved to persistent storage');
  await page.evaluate(() => localStorage.removeItem('opfs-vfs:website:pglite-databases:v1'));
  await page.goto('/');
  await page.goto('/demos/pglite/');
  await expectDatabaseReady(page);
  await query(page, 'SELECT value FROM recovered');
  await expect(page.locator('.PGliteRepl-output')).toContainText('42');
});

import { expect, test } from '@playwright/test';
import { choose } from './ui';

test('persistence illustrations stay readable and work without motion', async ({ page }) => {
  await page.goto('/docs/guides/persistence/');
  await expect(page.getByRole('figure', { name: 'Two ways file data reaches the volume' })).toBeVisible();
  const summary = page.locator('.save-walkthrough summary');
  await summary.focus();
  await summary.press('Enter');
  await expect(page.locator('.save-walkthrough')).toHaveAttribute('open', '');
  await expect(page.locator('.save-walkthrough li')).toHaveCount(3);
  await expect(page.locator('.failure')).toContainText('Do not show the work as saved');
  for (const theme of ['Dark', 'Light']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await choose(page, 'Color theme', theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.buffer-diagram').screenshot({ path: `/tmp/opfs-persistence-${theme}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await summary.press('Enter');
  await summary.press('Enter');
  await expect(page.locator('.save-walkthrough li').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.save-walkthrough li').last()).toBeVisible();
});

test('Volume Explorer naming reaches the running tool', async ({ page }) => {
  await page.goto('/demos/');
  await page.getByRole('link', { name: /Demo Volume Explorer/ }).click();
  await expect(page.getByRole('heading', { name: 'Explore the files behind your app' })).toBeVisible();
  await page.getByRole('button', { name: 'Load Volume Explorer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' })).toBeVisible();
  await page.getByRole('button', { name: 'Close volume explorer', exact: true }).click();
  await page.getByRole('button', { name: 'Open OPFS VFS Volume Explorer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' })).toBeVisible();
});

test('docs embed creates a dedicated sample and connects read-only on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto('/docs/guides/devtools/');
  const embed = page.locator('iframe[title="Volume Explorer live example with a docs sample volume"]');
  await embed.scrollIntoViewIfNeeded();
  const example = page.frameLocator('iframe[title="Volume Explorer live example with a docs sample volume"]');
  await expect(example.getByRole('dialog')).toHaveCount(0);
  await example.getByRole('button', { name: 'Create demo volume', exact: true }).click();
  const notice = example.getByRole('status');
  await expect(notice).toContainText(/Created docs-volume-explorer-\d+\.bin/);
  const name = (await notice.textContent())!.match(/docs-volume-explorer-\d+\.bin/)![0];
  await example.getByRole('button', { name: 'Load Volume Explorer', exact: true }).click();
  await expect(example.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' })).toBeVisible();
  await example.getByRole('combobox', { name: 'Active volume' }).click();
  await example.getByRole('listbox').getByText(name, { exact: true }).click();
  await example.getByRole('button', { name: 'Connect to volume', exact: true }).click();
  await expect(example.getByRole('button', { name: 'Enable writes', exact: true })).toBeVisible();
  await expect(example.getByRole('button', { name: 'Enable writes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(example.getByText('README.md', { exact: true }).first()).toBeVisible();
  await example.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(example.getByRole('heading', { name: 'A real browser volume', exact: true })).toBeVisible();
  await embed.screenshot({ path: '/tmp/opfs-docs-explorer-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { expect, test } from '@playwright/test';
import { choose } from './ui';

test('select controls support keyboard choice and return focus when dismissed', async ({ page }) => {
  await page.goto('/demos/');
  const theme = page.getByRole('combobox', { name: 'Color theme', exact: true });
  await theme.focus();
  await theme.press('Enter');
  await expect(page.getByRole('option', { name: 'System', exact: true })).toBeFocused();
  await expect(theme).toHaveText('System');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Light', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(theme).toHaveText('Light');
  await theme.press('Enter');
  await page.keyboard.press('Escape');
  await expect(theme).toBeFocused();
});

test('theme follows the system, persists across docs, and syncs open tabs', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/demos/');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('combobox', { name: 'Color theme' })).toContainText('System');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await choose(page, 'Color theme', 'Dark');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.goto('/docs/getting-started/');
  await expect(page.getByRole('combobox', { name: 'Color theme' })).toContainText('Dark');
  const second = await context.newPage();
  await second.goto('/benchmarks/');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await choose(page, 'Color theme', 'Light');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(second.getByRole('combobox', { name: 'Color theme' })).toContainText('Light');
  await choose(page, 'Color theme', 'System');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('changing theme preserves workspace and unsaved editor content', async ({ page }) => {
  await page.goto('/demos/filesystem/');
  await expect(page.getByLabel('Shell command')).toBeVisible();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Edit README.md').fill('# Still editing');
  await page.getByLabel('Shell command').fill('echo theme-safe');
  for (const theme of ['Dark', 'Light']) {
    await choose(page, 'Color theme', theme);
    await expect(page.getByLabel('Edit README.md')).toHaveText('# Still editing');
    await expect(page.getByLabel('Shell command')).toHaveValue('echo theme-safe');
    await expect(page.getByRole('treeitem', { name: /README\.md/ })).toBeVisible();
  }
  await page.getByLabel('Shell command').press('Enter');
  await expect(page.locator('.shell-panel pre')).toContainText('theme-safe');
});

import { expect, test } from '@playwright/test';

test('SDK examples switch with clicks and keyboard navigation', async ({ page }) => {
  await page.goto('/#sdks');
  const tabs = page.getByRole('tablist', { name: 'Filesystem API examples' });
  const javascript = tabs.getByRole('tab', { name: 'TypeScript' });
  const effect = tabs.getByRole('tab', { name: 'Effect', exact: true });
  await expect(page.getByRole('tabpanel', { name: 'TypeScript' })).toBeVisible();
  await effect.click();
  await expect(page.getByRole('tabpanel', { name: 'Effect', exact: true })).toContainText('OpfsFileSystem.layer');
  await expect(page.locator('#example-javascript')).toBeHidden();
  await effect.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'React', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'React', exact: true })).toContainText('VolumeProvider');
  await page.keyboard.press('Home');
  await expect(javascript).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(effect).toBeFocused();
  await expect(effect).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
});

test('hero SDK links reveal the matching example', async ({ page }) => {
  await page.goto('/');
  for (const [name, id] of [
    ['TypeScript', 'javascript'],
    ['React', 'react'],
    ['Effect', 'effect'],
  ]) {
    await page.locator('.hero-sdks').getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#example-${id}$`));
  }
  await page.getByRole('tab', { name: 'TypeScript', exact: true }).click();
  await page.locator('.hero-sdks').getByRole('link', { name: 'Effect', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Effect', exact: true })).toBeVisible();
});

test('header keeps the GitHub icon visible and tablet navigation fits', async ({ page }) => {
  await page.goto('/');
  for (const width of [768, 820, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const github = page.locator('.site-header > .github');
    await expect(github).toBeVisible();
    await expect(github.locator('svg')).toBeVisible();
    const nav = page.locator('.site-header > .site-nav');
    if (width >= 768) await expect(nav).toBeVisible();
    else await expect(nav).toBeHidden();
    const bounds = await github.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.locator('.site-header').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(
      66,
    );
  }
  await page.screenshot({ path: '/tmp/opfs-header-mobile.jpg' });
  await page.setViewportSize({ width: 820, height: 844 });
  await page.screenshot({ path: '/tmp/opfs-header-tablet.jpg' });
});

test('homepage hydrates the theme picker and hero animation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-visual canvas')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Color theme' }).click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('combobox', { name: 'Color theme' }).click();
  await page.getByRole('option', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

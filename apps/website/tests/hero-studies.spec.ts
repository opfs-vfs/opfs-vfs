import { expect, test } from '@playwright/test';
import { choose } from './ui';

for (const name of ['Layers', 'Open fan', 'Ribbon', 'Arc']) {
  test(`${name} animates, pauses, and renders on mobile in both themes`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/design/hero/');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    const canvas = page.locator('.study-canvas canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const moving = await canvas.screenshot();
    await page.waitForTimeout(200);
    expect((await canvas.screenshot()).equals(moving)).toBe(false);
    await page.getByRole('button', { name: 'Pause motion' }).click();
    const paused = await canvas.screenshot();
    await page.waitForTimeout(200);
    expect((await canvas.screenshot()).equals(paused)).toBe(true);
    await page.getByRole('button', { name: 'Play motion' }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['Light', 'Dark']) {
      await choose(page, 'Color theme', theme);
      await expect(canvas).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      const still = await canvas.screenshot();
      await page.waitForTimeout(200);
      expect((await canvas.screenshot()).equals(still)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

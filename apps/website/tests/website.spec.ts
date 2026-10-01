import { expect, test } from '@playwright/test';

test('marketing, docs, demos and changelog routes load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const path of [
    '/',
    '/docs/getting-started/',
    '/docs/plugins/',
    '/docs/plugins/subscriptions/',
    '/changelog/',
    '/demos/',
    '/benchmarks/',
    '/benchmarks/methodology/',
    '/benchmarks/storage/',
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  expect(errors).toEqual([]);
});

test('homepage fits mobile and honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByRole('img', { name: 'Segmented storage rings representing an OPFS VFS volume' }),
  ).toBeVisible();
  await expect(page.locator('.hero-wordmark')).toHaveText('PFS');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeHidden();
  const canvas = page.locator('.hero-scene canvas');
  const still = await canvas.screenshot();
  await page.waitForTimeout(200);
  expect((await canvas.screenshot()).equals(still)).toBe(true);
});

test('AI setup gates the whole workspace without downloading on page load', async ({ page }) => {
  const modelRequests: string[] = [];
  page.on('request', (request) => {
    if (/huggingface|\.task(?:$|\?)/.test(request.url())) modelRequests.push(request.url());
  });
  await page.goto('/demos/ai/');
  await expect(page.getByRole('region', { name: 'Give your workspace a local model' })).toBeVisible();
  await expect(page.getByLabel('Message your local model')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Download.*2\.00 GB/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Give your workspace a local model' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(modelRequests).toEqual([]);
});

test('hero animation advances and pauses on request', async ({ page }) => {
  // Fit the full canvas so screenshots do not resize the viewport and redraw the scene.
  await page.setViewportSize({ width: 1280, height: 2000 });
  await page.goto('/');
  const canvas = page.locator('.hero-scene canvas');
  await expect(canvas).toBeVisible();
  const initial = await canvas.screenshot();
  await page.waitForTimeout(200);
  expect((await canvas.screenshot()).equals(initial)).toBe(false);
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toHaveAttribute('aria-pressed', 'true');
  const paused = await canvas.screenshot();
  await page.waitForTimeout(200);
  expect((await canvas.screenshot()).equals(paused)).toBe(true);
});

test('adapter directory keeps links accessible without animated borders', async ({ page }) => {
  await page.goto('/');
  const rows = page.locator('#adapters .integration');
  await expect(rows).toHaveCount(7);
  await expect(page.locator('[data-ray-tile]')).toHaveCount(0);
  const link = rows.first().getByRole('link').first();
  await link.focus();
  await expect(link).toBeFocused();
  expect(await link.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#adapters').screenshot({ path: `/tmp/opfs-adapters-${theme}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test('docs share the website brand and mobile header links stay centered', async ({ page }) => {
  await page.goto('/');
  const brand = page.locator('header .brand');
  const websiteMark = await brand.locator('svg').innerHTML();
  const websiteFont = await brand.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing];
  });
  for (const width of [320, 390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    const logo = await brand.boundingBox();
    for (const control of [
      page.getByRole('combobox', { name: 'Color theme' }),
      page.getByRole('button', { name: 'Menu', exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(Math.abs(logo!.y + logo!.height / 2 - box!.y - box!.height / 2), `${width}px header`).toBeLessThan(1);
    }
  }
  await page.goto('/docs/getting-started/');
  const docsBrand = page.locator('header .brand');
  await expect(docsBrand).toHaveText('OPFS VFS | DOCS');
  expect(await docsBrand.locator('svg').innerHTML()).toBe(websiteMark);
  expect(
    await docsBrand.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing];
    }),
  ).toEqual(websiteFont);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const logo = await docsBrand.boundingBox();
    const wrapper = await page.locator('.title-wrapper').boundingBox();
    expect(logo!.x + logo!.width, `${width}px docs title`).toBeLessThanOrEqual(wrapper!.x + wrapper!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('mobile menu keeps the header compact and supports keyboard and dismissal', async ({ page }) => {
  for (const width of [320, 390, 700, 767]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/demos/');
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    const menu = page.locator('.mobile-navigation');
    await expect(toggle).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeHidden();
    const theme = page.getByRole('combobox', { name: 'Color theme', exact: true });
    const box = await theme.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(40);
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveCount(8);
    await expect(nav.getByRole('link', { name: 'Plugins', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'SDKs & adapters', exact: true })).toHaveAttribute('href', '/#sdks');
    await expect(nav.getByRole('link', { name: 'GitHub' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.mouse.click(1, 200);
    await expect(menu).not.toHaveAttribute('open');
  }
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('link', { name: 'Why OPFS VFS' })
    .click();
  await expect(page).toHaveURL(/\/motivation\/$/);
  await expect(page.locator('.mobile-navigation')).not.toHaveAttribute('open');
  for (const width of [901, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
    await expect(page.locator('.site-header > .github')).toBeVisible();
    const rows = await page
      .locator('.site-nav a')
      .evaluateAll((links) => links.map((link) => link.getBoundingClientRect().top));
    expect(new Set(rows).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('plugins expose their availability and animations can be paused or reduced', async ({ page }) => {
  await page.goto('/#plugins');
  const plugins = page.locator('#plugins');
  await plugins.scrollIntoViewIfNeeded();
  await expect(plugins).toHaveAttribute('data-playing', 'true');
  await expect(plugins.getByRole('article').first()).toContainText('Available');
  await expect(plugins.getByRole('complementary', { name: 'Cloud sync' })).toContainText('Planned');
  const event = plugins.locator('.event-path');
  const position = await event.evaluate((element) => getComputedStyle(element).strokeDashoffset);
  await expect.poll(() => event.evaluate((element) => getComputedStyle(element).strokeDashoffset)).not.toBe(position);
  await plugins.getByRole('button', { name: 'Pause illustrations' }).click();
  await expect(event).toHaveCSS('animation-play-state', 'paused');
  // CSS can report paused before the browser has completed its pending pause task.
  await event.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.ready)));
  const paused = await event.evaluate((element) => getComputedStyle(element).strokeDashoffset);
  await page.waitForTimeout(100);
  expect(await event.evaluate((element) => getComputedStyle(element).strokeDashoffset)).toBe(paused);
  await plugins.getByRole('button', { name: 'Play illustrations' }).click();
  await page.locator('h1').scrollIntoViewIfNeeded();
  await expect(event).toHaveCSS('animation-play-state', 'paused');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await plugins.scrollIntoViewIfNeeded();
  await expect(plugins.getByRole('button', { name: 'Pause illustrations' })).toBeHidden();
  for (const motion of await plugins.locator('.plugin-motion').all()) {
    await expect(motion).toHaveCSS('animation-name', 'none');
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await plugins.screenshot({ path: `/tmp/opfs-plugins-${theme}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await plugins.getByRole('link', { name: 'Use subscriptions' }).click();
  await expect(page.getByRole('heading', { name: 'File subscriptions', exact: true }).first()).toBeVisible();
  await expect(page.locator('main')).toContainText('Register a custom worker');
  await expect(page.locator('main')).toContainText('Keep a current view');
});

test('floating navigation stays reachable and clears anchors on desktop and mobile', async ({ page }) => {
  for (const width of [320, 390, 768, 900, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const header = page.locator('.site-header');
    const initial = await header.boundingBox();
    await expect(header).toHaveCSS('box-shadow', 'none');
    await page.locator('.site-footer').scrollIntoViewIfNeeded();
    expect((await header.boundingBox())!.y).toBeCloseTo(initial!.y, 0);
    expect(initial!.y).toBeGreaterThan(0);
    await expect(header).not.toHaveCSS('box-shadow', 'none');
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    const anchor = (id: string) => page.locator(`${width <= 767 ? '.mobile-nav' : '.site-nav'} a[href="/#${id}"]`);
    if (width <= 767) await menu.click();
    const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
    const plugins = nav.getByRole('link', { name: 'Plugins', exact: true });
    await plugins.click();
    await expect
      .poll(async () => (await page.locator('#plugins').boundingBox())!.y)
      .toBeGreaterThan(initial!.y + initial!.height);
    await expect(anchor('plugins')).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('.mobile-navigation')).not.toHaveAttribute('open');
    if (width <= 767) await menu.click();
    const sdks = nav.getByRole('link', { name: 'SDKs & adapters', exact: true });
    await sdks.click();
    await expect(anchor('sdks')).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('.mobile-navigation')).not.toHaveAttribute('open');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('combobox', { name: 'Color theme', exact: true }).click();
    await page.getByRole('option', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(header).toHaveCSS('box-shadow', 'none');
  }
  await page.setViewportSize({ width: 700, height: 320 });
  const toggle = page.getByRole('button', { name: 'Menu', exact: true });
  await toggle.focus();
  await toggle.press('Enter');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
  const lastLink = page.locator('.mobile-nav').getByRole('link', { name: 'GitHub' });
  await expect(lastLink).toBeFocused();
  const link = await lastLink.boundingBox();
  const menu = await page.locator('.mobile-nav').boundingBox();
  expect(link!.y).toBeGreaterThanOrEqual(menu!.y);
  expect(link!.y + link!.height).toBeLessThanOrEqual(menu!.y + menu!.height);
  expect(menu!.y + menu!.height).toBeLessThan(320);
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
});

test('subscription illustration updates both subscribed tabs after each file change', async ({ page }) => {
  await page.goto('/#plugins');
  const plugins = page.locator('#plugins');
  await plugins.scrollIntoViewIfNeeded();
  await plugins.getByRole('button', { name: 'Pause illustrations' }).click();
  const art = plugins.locator('.subscription-art');
  const seek = async (time: number) => {
    await art.evaluate((svg, milliseconds) => {
      for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = milliseconds;
    }, time);
  };
  await expect(art.locator('.subscribed-tab')).toHaveCount(2);
  await expect(art.locator('.todo-row')).toHaveCount(2);
  const opacity = async (selector: string, value: string) => {
    for (const element of await art.locator(selector).all()) await expect(element).toHaveCSS('opacity', value);
  };
  await seek(300);
  await opacity('.file-node', '0');
  await opacity('.todo-row', '0');
  await seek(1300);
  await opacity('.file-node', '1');
  await opacity('.todo-row', '0');
  await seek(3000);
  await opacity('.todo-row', '1');
  await opacity('.file-before', '1');
  await opacity('.todo-before', '1');
  await opacity('.file-after', '0');
  await opacity('.todo-after', '0');
  await art.screenshot({ path: '/tmp/subscriptions-created.png' });
  await seek(4400);
  await opacity('.file-before', '0');
  await opacity('.file-after', '1');
  await opacity('.todo-before', '1');
  await opacity('.todo-after', '0');
  await seek(5500);
  await opacity('.todo-before', '0');
  await opacity('.todo-after', '1');
  await art.screenshot({ path: '/tmp/subscriptions-updated.png' });
  await seek(7700);
  await opacity('.file-node', '0');
  await opacity('.todo-row', '1');
  await seek(8800);
  await opacity('.todo-row', '0');
  await art.screenshot({ path: '/tmp/subscriptions-deleted.png' });
  await seek(10300);
  await opacity('.file-node', '0');
  await opacity('.todo-row', '0');
  await seek(13000);
  await opacity('.file-before', '1');
  await opacity('.todo-before', '1');
  await opacity('.todo-after', '0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await opacity('.file-node', '1');
  await opacity('.todo-row', '1');
  await opacity('.todo-before', '1');
  await opacity('.todo-after', '0');
  await expect(art.locator('.static-caption')).toBeVisible();
});

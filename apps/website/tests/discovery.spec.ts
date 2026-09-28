import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const hidden = [
  '/design/hero/',
  '/demos/devtools/embed/',
  '/demos/mobile-owner-probe/',
  '/demos/dedicated-owner-probe/',
  '/demos/shared-volume-probe/',
];

test('sitemaps cover public pages and link to usable pages with distinct metadata', async ({ page, request }) => {
  const index = await request.get('/sitemap-index.xml');
  expect(index.status()).toBe(200);
  const children = [...(await index.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => new URL(match[1]!));
  const urls: string[] = [];
  for (const child of children) {
    expect(child.origin).toBe('https://opfs.dev');
    const response = await request.get(child.pathname);
    expect(response.status()).toBe(200);
    urls.push(...[...(await response.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!));
  }
  const expected = readdirSync('dist', { recursive: true })
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.html'))
    .map((file) => `/${file.replace(/index\.html$/, '')}`)
    .filter((path) => path !== '/404.html' && !hidden.includes(path))
    .map((path) => `https://opfs.dev${path}`);
  expect(urls.sort()).toEqual(expected.sort());
  expect(urls).toContain('https://opfs.dev/motivation/');
  const descriptions = new Set<string>();
  for (const url of urls) {
    const response = await request.get(new URL(url).pathname);
    expect(response.status(), url).toBe(200);
    const metadata = await page.evaluate(
      (html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return {
          description: doc.querySelector('meta[name="description"]')?.getAttribute('content'),
          canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
          llms: doc.querySelector('link[rel="describedby"]')?.getAttribute('href'),
        };
      },
      await response.text(),
    );
    expect(metadata.canonical, url).toBe(url);
    expect(metadata.description?.length, url).toBeGreaterThan(20);
    expect(descriptions.has(metadata.description!), url).toBe(false);
    descriptions.add(metadata.description!);
    expect(metadata.llms, url).toBe('/llms.txt');
  }
  for (const path of hidden) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(await response.text()).toMatch(/name="robots" content="noindex/);
  }
  await page.goto('/sitemap/');
  const links = await page
    .locator('main a')
    .evaluateAll((nodes) => nodes.map((node) => new URL((node as HTMLAnchorElement).href).pathname));
  expect(links.filter((path) => path.endsWith('/')).sort()).toEqual(
    urls
      .map((url) => new URL(url).pathname)
      .filter((path) => path !== '/sitemap/')
      .sort(),
  );
  expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap: https://opfs.dev/sitemap-index.xml');
});

test('LLM guide and alias agree and all local guide links resolve', async ({ request }) => {
  const response = await request.get('/llms.txt');
  expect(response.status()).toBe(200);
  const content = await response.text();
  const alias = await request.get('/llm.txt');
  expect(alias.status()).toBe(200);
  expect(alias.headers()['content-type']).toContain('text/plain');
  expect(await alias.text()).toBe(content);
  expect(content).toMatch(/^# OPFS VFS\n/);
  for (const match of content.matchAll(/\]\((https:\/\/opfs\.dev[^)]+)\)/g)) {
    expect((await request.get(new URL(match[1]!).pathname)).status(), match[1]).toBe(200);
  }
});

test('motivation links, navigation and new pages remain usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/benchmarks/storage/#motivation');
  await page.locator('#motivation').getByRole('link', { name: 'why we built OPFS VFS' }).click();
  await expect(page).toHaveURL(/\/motivation\/$/);
  await expect(page.getByRole('heading', { name: 'Why OPFS VFS exists', exact: true })).toBeVisible();
  for (const path of ['/', '/motivation/', '/sitemap/', '/benchmarks/storage/', '/docs/']) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Why OPFS VFS', exact: true }).first()).toBeVisible();
  }
  await page.goto('/');
  await expect(page.locator('.benchmark-art')).toHaveAttribute('src', '/images/storage-comparison.webp');
});

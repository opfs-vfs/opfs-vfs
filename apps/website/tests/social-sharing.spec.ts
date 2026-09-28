import { expect, test } from '@playwright/test';

test('shared links include page metadata and a centered-size social image without JavaScript', async ({
  browser,
  request,
}) => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  for (const path of ['/', '/demos/', '/docs/getting-started/']) {
    await page.goto(path);
    const meta = (key: string) => page.locator(`head meta[property="${key}"], head meta[name="${key}"]`);
    for (const key of ['og:title', 'og:description', 'og:type', 'og:site_name', 'og:url', 'og:image', 'twitter:card']) {
      await expect(meta(key)).toHaveCount(1);
      await expect(meta(key)).toHaveAttribute('content', /\S+/);
    }
    await expect(meta('og:description')).toHaveAttribute(
      'content',
      (await meta('description').getAttribute('content'))!,
    );
    await expect(meta('og:url')).toHaveAttribute('content', `https://opfs.dev${path}`);
    await expect(meta('og:image')).toHaveAttribute('content', 'https://opfs.dev/images/opfs-social.png');
    await expect(meta('og:image:width')).toHaveAttribute('content', '1200');
    await expect(meta('og:image:height')).toHaveAttribute('content', '630');
    await expect(meta('twitter:card')).toHaveAttribute('content', 'summary_large_image');
    await expect(meta('twitter:image')).toHaveAttribute('content', (await meta('og:image').getAttribute('content'))!);
    if (path === '/') await expect(meta('og:title')).toHaveAttribute('content', await page.title());
  }
  const response = await request.get('/images/opfs-social.png');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  const png = await response.body();
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  await page.close();
});

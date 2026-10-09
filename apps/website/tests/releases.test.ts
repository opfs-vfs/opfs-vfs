import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReleases } from '../src/lib/releases.ts';

const release = (version: string, extra = {}) => ({
  tag_name: `@opfs-vfs/react@${version}`,
  body: '### Patch Changes\n\nUseful **Changesets** notes.',
  published_at: '2026-10-09T12:00:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

void test('reads every page, excludes drafts and prereleases, retains notes and sorts versions', async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(typeof url, 'string');
    urls.push(url as string);
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-token');
    assert.ok(options?.signal);
    return Response.json(
      urls.length === 1
        ? [
            release('0.2.0'),
            release('0.3.0', { draft: true }),
            release('0.4.0', { prerelease: true }),
            ...Array.from({ length: 97 }, () => ({ tag_name: 'unrelated' })),
          ]
        : [release('0.10.0')],
    );
  };
  const result = await fetchReleases('test-token', request);
  assert.equal(urls.length, 2);
  assert.match(urls[1]!, /page=2$/);
  assert.deepEqual(
    result.map((entry) => entry.version),
    ['0.10.0', '0.2.0'],
  );
  assert.equal(result[0]?.body, release('0.10.0').body);
  assert.equal(result[0]?.url, 'https://github.com/opfs-vfs/opfs-vfs/releases/tag/%40opfs-vfs%2Freact%400.10.0');
});

void test('fails on API errors or malformed releases instead of deploying missing notes', async () => {
  await assert.rejects(
    fetchReleases(undefined, async () => new Response('', { status: 403 })),
    /403/,
  );
  for (const value of [
    { message: 'error' },
    [null],
    [release('0.1.0', { body: null })],
    [release('0.1.0', { published_at: 'bad' })],
  ]) {
    await assert.rejects(fetchReleases(undefined, async () => Response.json(value)));
  }
  assert.deepEqual(
    await fetchReleases(undefined, async (_url, options) => {
      assert.equal(new Headers(options?.headers).has('Authorization'), false);
      return Response.json([]);
    }),
    [],
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import proxy from '../proxy.ts';

await test('protects every path, fails closed, and only opens with an explicit public switch', () => {
  const keys = ['BASIC_AUTH_USERNAME', 'BASIC_AUTH_PASSWORD', 'BASIC_AUTH_DISABLED'] as const;
  const saved = keys.map((key) => process.env[key]);
  const request = (path: string, authorization?: string) =>
    new Request(`https://opfs.dev${path}`, { headers: authorization ? { authorization } : {} });
  const credentials = `Basic ${Buffer.from('tester:password:with:colons').toString('base64')}`;
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(proxy(request('/')).status, 503);
    process.env.BASIC_AUTH_USERNAME = 'tester';
    assert.equal(proxy(request('/')).status, 503);
    process.env.BASIC_AUTH_PASSWORD = 'password:with:colons';
    for (const path of ['/', '/docs/getting-started/', '/_astro/app.js', '/worker.js', '/runtime.wasm']) {
      const allowed = proxy(request(path, credentials));
      assert.equal(allowed.headers.get('x-middleware-next'), '1');
      assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
      assert.equal(allowed.headers.get('x-robots-tag'), 'noindex, nofollow');
      for (const header of [undefined, 'Bearer abc', 'Basic !!!', 'Basic dGVzdGVyOndyb25n', `${credentials} extra`]) {
        const denied = proxy(request(path, header));
        assert.equal(denied.status, 401);
        assert.match(denied.headers.get('www-authenticate') ?? '', /^Basic /);
        assert.equal(denied.headers.get('cache-control'), 'private, no-store');
        assert.equal(denied.headers.get('x-middleware-next'), null);
      }
    }
    process.env.BASIC_AUTH_USERNAME = 'invalid:name';
    assert.equal(proxy(request('/', credentials)).status, 503);
    for (const value of ['false', '1', 'TRUE']) {
      process.env.BASIC_AUTH_DISABLED = value;
      assert.equal(proxy(request('/')).status, 503);
    }
    process.env.BASIC_AUTH_DISABLED = 'true';
    const publicResponse = proxy(request('/'));
    assert.equal(publicResponse.headers.get('x-middleware-next'), '1');
    assert.equal(publicResponse.headers.get('x-robots-tag'), null);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});

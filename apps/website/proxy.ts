import { createHash, timingSafeEqual } from 'node:crypto';
import { next } from '@vercel/functions';

// Vercel runs this before every page and static asset, including workers and WASM.
export default function proxy(request: Request): Response {
  if (process.env.BASIC_AUTH_DISABLED === 'true') return next();

  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  const username = process.env.BASIC_AUTH_USERNAME;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!username || !password || username.includes(':')) {
    return new Response('Website access is not configured.', { status: 503, headers });
  }

  const token = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const expected = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(token), digest(expected))) {
    headers.set('WWW-Authenticate', 'Basic realm="OPFS VFS preview", charset="UTF-8"');
    return new Response('Authentication required.', { status: 401, headers });
  }

  return next({ headers });
}

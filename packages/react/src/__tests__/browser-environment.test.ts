import { expect, test } from 'vitest';

declare const __OPFS_VFS_REQUIRE_HTTPS__: boolean;

test('runs in a secure OPFS and Web Locks browser context', () => {
  const environment = {
    secureContext: isSecureContext,
    origin: location.origin,
    protocol: location.protocol,
    storage: typeof navigator.storage?.getDirectory,
    locks: typeof navigator.locks?.request,
  };
  const missing = [
    ...(environment.secureContext ? [] : ['secure context']),
    ...(environment.storage === 'function' ? [] : ['OPFS storage']),
    ...(environment.locks === 'function' ? [] : ['Web Locks']),
    ...(__OPFS_VFS_REQUIRE_HTTPS__ && environment.protocol !== 'https:' ? ['HTTPS origin'] : []),
  ];
  console.log(JSON.stringify(environment));
  if (missing.length)
    throw new Error(`Browser prerequisites unavailable (${missing.join(', ')}): ${JSON.stringify(environment)}`);
  expect(missing).toEqual([]);
});

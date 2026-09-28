import type { ConfiguredVfsPlugin, VfsPluginFactory, VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';

type TestLockOptions = { secret: string };

function configure(options: unknown): ConfiguredVfsPlugin {
  if (!options || typeof options !== 'object' || (options as TestLockOptions).secret !== 'right') {
    const error = Object.assign(new Error('Volume is locked'), { code: 'EVOLUMELOCKED' });
    throw error;
  }
  return {
    id: 'test-lock',
    contractVersion: 1,
    compatibilityKey: 'test-lock-v1',
    storage: { sidecars: [], factory: async ({ data }) => ({ data, destroy() {} }) },
  };
}

export const testLock = Object.assign((options: TestLockOptions) => configure(options), {
  id: 'test-lock' as const,
  configure,
}) satisfies VfsPluginFactory<TestLockOptions>;

export function testLockRequest(secret: string): VfsPluginRequest<TestLockOptions> {
  return { id: 'test-lock', contractVersion: 1, compatibilityKey: 'test-lock-v1', options: { secret } };
}

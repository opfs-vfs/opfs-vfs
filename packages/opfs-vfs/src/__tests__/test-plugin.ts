import type { ConfiguredVfsPlugin, StorageSidecarSuffix, VolumeStorageFactory } from '../plugins';

export function testPlugin(
  factory: VolumeStorageFactory,
  sidecars: readonly StorageSidecarSuffix[] = [],
): ConfiguredVfsPlugin {
  return {
    id: 'test-storage',
    contractVersion: 1,
    compatibilityKey: 'test-storage-v1',
    storage: { factory: (context) => factory(context), sidecars },
  };
}

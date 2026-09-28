import type { VolumeStorageFactory } from './storage-contract';
import type { LogicalChangeContribution } from './changes';

/** Reserved protection files that a storage plugin may own. */
export type StorageSidecarSuffix = '.vault' | '.crypt' | '.crypt.log';

export interface PluginIdentity {
  readonly id: string;
  readonly contractVersion: 1;
  readonly compatibilityKey: string;
  readonly requiredOpenMode?: 'create-new';
}

export interface StorageContribution {
  readonly factory: VolumeStorageFactory;
  readonly sidecars: readonly StorageSidecarSuffix[];
}

export type ConfiguredVfsPlugin = PluginIdentity &
  (
    | { readonly storage: StorageContribution; readonly logicalChanges?: never }
    | { readonly storage?: never; readonly logicalChanges: LogicalChangeContribution }
  );

export interface VfsPluginRequest<Options = unknown> {
  readonly id: string;
  readonly contractVersion: 1;
  readonly compatibilityKey: string;
  readonly requiredOpenMode?: 'create-new';
  readonly options: Options;
}

export interface VfsPluginRegistration {
  readonly id: string;
  configure(options: unknown): ConfiguredVfsPlugin;
}

export interface VfsPluginFactory<Options> extends VfsPluginRegistration {
  (options: Options): ConfiguredVfsPlugin;
}

export { RecordRole } from './storage-contract';
export type { RecordCodec, VolumeStorage, VolumeStorageFactory, VolumeStorageOpenContext } from './storage-contract';
export type { SyncAccessHandle } from './sync-access-handle';

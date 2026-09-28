export { CURRENT_BINARY_VERSION, MetaSnapshotCorruptionError } from './binary-metadata';
export { DataWalCorruptionError } from './data-wal';
export {
  isVfsCorruptionError,
  isVfsError,
  type VfsCorruptionCategory,
  VfsCorruptionError,
  VfsError,
} from './fs-errors';
export {
  OpfsVfs,
  OpenFlags,
  type OpfsVfsOptions,
  type VfsStat,
  type VfsDirEntry,
  type MkdirOptions,
  type DataWalSalvageEvent,
  type LocalPersistenceState,
  type LocalPersistenceStatus,
  type WriteFileBufferOptions,
} from './opfs-vfs';
export { deleteVolume, VolumeImportingError } from './volume-files';
export { peekVolume, type VolumePeek } from './peek-volume';
export type { FileChangeSource } from './changes';

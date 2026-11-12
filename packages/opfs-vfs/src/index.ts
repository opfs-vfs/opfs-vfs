export { CURRENT_BINARY_VERSION, MetaSnapshotCorruptionError } from './binary-metadata.js';
export { DataWalCorruptionError } from './data-wal.js';
export {
  isVfsCorruptionError,
  isVfsError,
  type VfsCorruptionCategory,
  VfsCorruptionError,
  VfsError,
} from './fs-errors.js';
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
} from './opfs-vfs.js';
export { deleteVolume, VolumeImportingError } from './volume-files.js';
export { peekVolume, type VolumePeek } from './peek-volume.js';
export type { FileChangeSource } from './changes.js';

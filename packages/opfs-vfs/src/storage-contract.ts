import type { SyncAccessHandle } from './sync-access-handle';

/** Stable on-disk record identities. Implementations must preserve these values. */
export const RecordRole = Object.freeze({ metaLog: 0x03, snapshot: 0x02, dataWal: 0x04 });

export interface RecordCodec {
  readonly overheadBytes: number;
  seal(plaintext: Uint8Array, role: number, identity: number): Uint8Array;
  sealInto(plaintext: Uint8Array, role: number, identity: number, out: Uint8Array, outOffset: number): number;
  open(sealed: Uint8Array, role: number, identity: number): Uint8Array;
}

export interface VolumeStorage {
  readonly data: SyncAccessHandle;
  readonly recordCodec?: RecordCodec;
  createDataWalCycle?(): { prefix: Uint8Array; codec: RecordCodec };
  openDataWalCycle?(bytes: Uint8Array): { prefixBytes: number; codec: RecordCodec } | null;
  beforeDataCommit?(): void;
  validateAfterMetadata?(referencesData: boolean): void;
  hasPhysicalBlock?(block: number, physicalDataSize: number, logicalLimit: number): boolean;
  isSemanticallyEmpty?(): boolean;
  destroy(): void;
}

export interface VolumeStorageOpenContext {
  readonly fileName: string;
  readonly root: FileSystemDirectoryHandle;
  readonly data: SyncAccessHandle;
  readonly dataSize: number;
  readonly metaSnapshotSizes: readonly [number, number];
  openSidecar(suffix: string, create?: boolean): Promise<SyncAccessHandle>;
}

export type VolumeStorageFactory = (context: VolumeStorageOpenContext) => Promise<VolumeStorage>;

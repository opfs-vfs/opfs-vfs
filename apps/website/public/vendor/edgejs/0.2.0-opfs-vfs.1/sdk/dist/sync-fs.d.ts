export interface SyncFileMetadata {
    kind: "file" | "directory";
    size: number;
    /** Milliseconds since the Unix epoch. */
    accessed?: number;
    modified?: number;
    created?: number;
}
export interface SyncOpenOptions {
    read: boolean;
    write: boolean;
    append: boolean;
    truncate: boolean;
    create: boolean;
    createNew: boolean;
}
/**
 * Callbacks run synchronously in the owner context. They must not reenter
 * Wasmer or wait for Wasmer locks. Throw errors with POSIX `code`, e.g. ENOENT.
 * A callback running after the 30-second timeout has an uncertain outcome:
 * the bridge fails closed and the operation must not be retried.
 */
export interface SyncFileSystem {
    metadata(path: string): SyncFileMetadata;
    readDir(path: string): readonly (SyncFileMetadata & {
        name: string;
    })[];
    createDir(path: string): void;
    removeDir(path: string): void;
    removeFile(path: string): void;
    /** Unlink the open file itself, or throw ENOTSUP if unsupported. */
    unlink(fd: number): void;
    rename(from: string, to: string): void;
    open(path: string, options: SyncOpenOptions): number;
    read(fd: number, length: number): Uint8Array;
    write(fd: number, bytes: Uint8Array): number;
    seek(fd: number, offset: number, whence: 0 | 1 | 2): number;
    fstat(fd: number): SyncFileMetadata;
    setLen(fd: number, length: number): void;
    flush(fd: number): void;
    close(fd: number): void;
}
export declare function registerSyncFileSystem(fs: SyncFileSystem): number;
/** Call only after guest execution has stopped. Attempts every leaked close. */
export declare function unregisterSyncFileSystems(ids: readonly number[]): void;
/** Install before wasm initialization in each guest worker. */
export declare function installSyncFsWorker(): void;
//# sourceMappingURL=sync-fs.d.ts.map
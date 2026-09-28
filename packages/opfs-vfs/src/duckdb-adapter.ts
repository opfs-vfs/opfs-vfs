import type { DuckDBFileInfo, DuckDBModule, DuckDBRuntime } from '@duckdb/duckdb-wasm/blocking';
import { OpenFlags, type OpfsVfs } from './opfs-vfs';

// DuckDB 1.33.1's public runtime flags. Type-only imports keep Node's blocking
// entry point out of browser bundles and avoid coupling to generated glue.
const READ = 1,
  WRITE = 2,
  CREATE = 8,
  TRUNCATE = 16,
  APPEND = 32;
const NULL_IF_MISSING = 128,
  EXCLUSIVE = 512,
  NULL_IF_EXISTS = 1024;
const decoder = new TextDecoder();

function memory(mod: DuckDBModule) {
  return mod as unknown as {
    _malloc(size: number): number;
    HEAPF64: Float64Array;
    HEAPU8: Uint8Array;
    stackSave(): number;
    stackAlloc(size: number): number;
    stackRestore(stack: number): void;
    _duckdb_web_opfs_vfs_abi?: () => number;
  };
}

function readString(mod: DuckDBModule, ptr: number, length: number) {
  return decoder.decode(memory(mod).HEAPU8.subarray(ptr, ptr + length));
}

function fileInfo(mod: DuckDBModule, id: number): DuckDBFileInfo {
  const mem = memory(mod);
  const stack = mem.stackSave();
  try {
    const response = mem.stackAlloc(24);
    mod.ccall('duckdb_web_fs_get_file_info_by_id', null, ['number', 'number', 'number'], [response, id, 0]);
    const [status, ptr, length] = mem.HEAPF64.subarray(response / 8, response / 8 + 3);
    const json = readString(mod, ptr, length);
    if (status !== 0) throw new Error(json);
    return JSON.parse(json) as DuckDBFileInfo;
  } finally {
    mod.ccall('duckdb_web_clear_response', null, [], []);
    mem.stackRestore(stack);
  }
}

/**
 * Experimental synchronous DuckDB filesystem. Use compatible external engine assets
 * as documented in docs/DUCKDB.md, a dedicated worker, and db.open({ useDirectIO: true }). Await
 * vfs.ready first. Close connections and db.reset() before closing the VFS.
 */
export function createDuckDBRuntime(vfs: OpfsVfs): DuckDBRuntime {
  const descriptors = new Map<number, { fd: number; flags: number }>();
  function guard<T>(mod: DuckDBModule, action: () => T): T {
    let message: string;
    try {
      return action();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Throw into C++ outside the JS catch so DuckDB can report an I/O error.
    mod.ccall('duckdb_web_fail_with', null, ['string'], [message]);
    throw new Error(message);
  }
  function fd(id: number) {
    const entry = descriptors.get(id);
    if (!entry) throw new Error(`Unknown DuckDB file ${id}`);
    return entry.fd;
  }
  function localPath(value: string) {
    if (value.includes('://') || value.includes('\0')) throw new Error('DuckDB adapter requires local file paths');
    return value.startsWith('/') ? value : `/${value}`;
  }
  function path(mod: DuckDBModule, ptr: number, length: number) {
    return localPath(readString(mod, ptr, length));
  }
  return {
    _udfFunctions: new Map(),
    testPlatformFeature: (_mod, feature) => feature === 1 && typeof BigInt64Array !== 'undefined',
    // NODE_FS selects synchronous callbacks; it does not require Node APIs.
    getDefaultDataProtocol: (mod) => {
      // Check before any file handles exist, including with stock builds whose
      // failed-open cleanup is unsafe. Do not enter their C++ I/O error path.
      if (!mod || typeof memory(mod)._duckdb_web_opfs_vfs_abi !== 'function') {
        throw new Error('DuckDB requires patched OPFS VFS build assets');
      }
      return 1;
    },
    openFile: (mod, id, flags) =>
      guard(mod, () => {
        if (memory(mod)._duckdb_web_opfs_vfs_abi?.() !== 1) {
          throw new Error('DuckDB adapter requires the patched OPFS VFS build and useDirectIO: true');
        }
        const info = fileInfo(mod, id);
        if (info.dataProtocol !== 1) throw new Error('DuckDB adapter supports local filesystem callbacks only');
        const name = localPath(info.dataUrl ?? info.fileName);
        const exists = vfs.existsSync(name);
        if ((!exists && flags & NULL_IF_MISSING) || (exists && flags & NULL_IF_EXISTS)) return 0;
        const previous = descriptors.get(id);
        // DuckDB shares IDs across concurrent handles and closes only the last one.
        const access = flags | (previous?.flags ?? 0);
        let mode = access & WRITE ? (access & READ ? OpenFlags.O_RDWR : OpenFlags.O_WRONLY) : OpenFlags.O_RDONLY;
        if (flags & (CREATE | TRUNCATE)) mode |= OpenFlags.O_CREAT;
        if (flags & TRUNCATE) mode |= OpenFlags.O_TRUNC;
        if (flags & EXCLUSIVE) mode |= OpenFlags.O_EXCL;
        if (access & APPEND) mode |= OpenFlags.O_APPEND;
        const descriptor = vfs.openSync(name, mode);
        descriptors.set(id, { fd: descriptor, flags: access });
        if (previous) vfs.closeSync(previous.fd);
        const stat = vfs.fstatSync(descriptor);
        const result = memory(mod)._malloc(24);
        if (!result) throw new Error('DuckDB could not allocate a file response');
        // A nonzero buffer pointer switches DuckDB to an in-memory filesystem.
        memory(mod).HEAPF64.set([stat.size, 0, (stat.mtimeMs ?? stat.timestampMs ?? 0) / 1000], result / 8);
        return result;
      }),
    closeFile: (mod, id) =>
      guard(mod, () => {
        const entry = descriptors.get(id);
        if (entry) vfs.closeSync(entry.fd);
        descriptors.delete(id);
      }),
    syncFile: (mod, id) => guard(mod, () => vfs.fsyncSync(fd(id))),
    truncateFile: (mod, id, size) => guard(mod, () => vfs.ftruncateSync(fd(id), size)),
    getLastFileModificationTime: (mod, id) => guard(mod, () => (vfs.fstatSync(fd(id)).mtimeMs ?? 0) / 1000),
    readFile: (mod, id, ptr, length, offset) =>
      guard(mod, () => vfs.readInto(fd(id), memory(mod).HEAPU8.subarray(ptr, ptr + length), offset)),
    writeFile: (mod, id, ptr, length, offset) =>
      guard(mod, () => vfs.writeSync(fd(id), memory(mod).HEAPU8.subarray(ptr, ptr + length), offset)),
    checkFile: (mod, ptr, length) =>
      guard(mod, () => {
        const name = path(mod, ptr, length);
        return vfs.existsSync(name) && vfs.statSync(name).is_file;
      }),
    checkDirectory: (mod, ptr, length) =>
      guard(mod, () => {
        const name = path(mod, ptr, length);
        return vfs.existsSync(name) && vfs.statSync(name).is_dir;
      }),
    createDirectory: (mod, ptr, length) =>
      guard(mod, () => {
        vfs.mkdirSync(path(mod, ptr, length));
        vfs.syncSync();
      }),
    removeDirectory: (mod, ptr, length) =>
      guard(mod, () => {
        vfs.rmdirSync(path(mod, ptr, length));
        vfs.syncSync();
      }),
    removeFile: (mod, ptr, length) =>
      guard(mod, () => {
        vfs.unlinkSync(path(mod, ptr, length));
        vfs.syncSync();
      }),
    moveFile: (mod, from, fromLength, to, toLength) =>
      guard(mod, () => {
        vfs.renameSync(path(mod, from, fromLength), path(mod, to, toLength));
        vfs.syncSync();
      }),
    glob: (mod, ptr, length) =>
      guard(mod, () => {
        const name = path(mod, ptr, length);
        if (/[*?[\]{}]/.test(name)) throw new Error('DuckDB adapter does not support glob patterns');
        if (vfs.existsSync(name)) mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [name]);
      }),
    listDirectoryEntries: (mod) =>
      guard(mod, () => {
        throw new Error('DuckDB adapter does not support directory listing');
      }),
    dropFile: () => {}, // Deregistration is not unlink: database files must survive reset.
    progressUpdate: () => {},
    callScalarUDF: (mod) =>
      guard(mod, () => {
        throw new Error('DuckDB adapter does not support JavaScript UDFs');
      }),
  };
}

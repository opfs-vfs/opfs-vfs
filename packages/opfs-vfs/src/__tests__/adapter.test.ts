import { ERRNO_CODES } from '@electric-sql/pglite/basefs';
import { describe, expect, it, vi } from 'vitest';
import { OpfsVfsPGliteAdapter, type VfsSyncApi } from '../adapter';
import { OpfsVfsWorker } from '../index_internal';
import { OpenFlags, type VfsStat } from '../opfs-vfs';
import { createVfsError } from '../fs-errors';

function makeStat(overrides: Partial<VfsStat> = {}): VfsStat {
  return {
    ino: 1,
    size: 0,
    mode: 33188,
    nlink: 1,
    blksize: 4096,
    blocks: 0,
    atimeMs: 1712345600000,
    mtimeMs: 1712345610000,
    ctimeMs: 1712345620000,
    timestampMs: 1712345610000,
    is_dir: false,
    is_file: true,
    ...overrides,
  };
}

function makeStubVfs(overrides: Partial<VfsSyncApi> = {}): VfsSyncApi {
  return {
    mkdirSync() {},
    openSync() {
      return 1;
    },
    writeSync() {
      return 0;
    },
    readSync() {
      return { buffer: new Uint8Array(), read: 0 };
    },
    seekSync() {
      return 0;
    },
    closeSync() {},
    removeSync() {},
    renameSync() {},
    truncateSync() {},
    existsSync() {
      return false;
    },
    statSync() {
      return makeStat();
    },
    readdirSync() {
      return [];
    },
    syncSync() {},
    ...overrides,
  };
}

it('awaits flushVfs during closeFs', async () => {
  const flushVfs = vi.fn(async () => {
    await Promise.resolve();
  });

  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ flushVfs }));

  await adapter.closeFs();
  expect(flushVfs).toHaveBeenCalledTimes(1);
});

it('propagates the exact syncSync error from strict syncToFs', async () => {
  const syncError = new Error('strict sync failed');
  const syncSync = vi.fn(() => {
    throw syncError;
  });
  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ syncSync }), { relaxedDurability: false });

  await expect(adapter.syncToFs(false)).rejects.toBe(syncError);
  expect(syncSync).toHaveBeenCalledTimes(1);
});

it('skips syncSync in relaxed mode', async () => {
  const syncSync = vi.fn();
  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ syncSync }), { relaxedDurability: true });

  await expect(adapter.syncToFs(false)).resolves.toBeUndefined();
  expect(syncSync).not.toHaveBeenCalled();
});

it('closes the VFS during closeFs when closeVfs is available', async () => {
  const flushVfs = vi.fn();
  const closeVfs = vi.fn(async () => {
    await Promise.resolve();
  });

  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ flushVfs, closeVfs }));

  await adapter.closeFs();
  expect(closeVfs).toHaveBeenCalledTimes(1);
  expect(flushVfs).not.toHaveBeenCalled();
});

it('keeps VFS handles open until the final nested PGlite closeFs call', async () => {
  const flushVfs = vi.fn();
  const closeVfs = vi.fn();
  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ flushVfs, closeVfs }));

  await adapter.init({} as never, {});
  await adapter.init({} as never, {});

  await adapter.closeFs();
  expect(flushVfs).toHaveBeenCalledTimes(1);
  expect(closeVfs).not.toHaveBeenCalled();

  await adapter.closeFs();
  expect(closeVfs).toHaveBeenCalledTimes(1);
});

it('truncates existing files when opened for write', () => {
  const openSync = vi.fn(() => 7);
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      openSync,
      truncateSync: vi.fn(),
      existsSync() {
        return true;
      },
      statSync() {
        return makeStat({ size: 3 });
      },
    }),
  );

  const fd = adapter.open('/hello.txt', 'w');

  expect(fd).toBe(7);
  expect(openSync).toHaveBeenCalledWith('/hello.txt', OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC);
});

it('maps PGlite open flags into POSIX-style VFS flags', () => {
  const openSync = vi.fn(() => 9);
  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ openSync }));

  adapter.open('/append.txt', 'a+');
  adapter.open('/exclusive.txt', 'wx');
  adapter.open('/read.txt', 'r');

  expect(openSync).toHaveBeenNthCalledWith(1, '/append.txt', OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_APPEND);
  expect(openSync).toHaveBeenNthCalledWith(
    2,
    '/exclusive.txt',
    OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC | OpenFlags.O_EXCL,
  );
  expect(openSync).toHaveBeenNthCalledWith(3, '/read.txt', OpenFlags.O_RDONLY);
});

it('readdir propagates ENOTDIR/ENOENT instead of returning [] (COR-7)', () => {
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      readdirSync() {
        throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      },
    }),
  );

  let thrown: unknown;
  try {
    adapter.readdir('/not-a-dir');
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code: number }).code).toBe(ERRNO_CODES.ENOTDIR);
});

it('fstat propagates EBADF instead of fabricating a 0-byte file (COR-7)', () => {
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      fstatSync() {
        throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
      },
    }),
  );

  let thrown: unknown;
  try {
    adapter.fstat(123);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code: number }).code).toBe(ERRNO_CODES.EBADF);
});

it('close propagates EBADF instead of swallowing it, but still drops the fd path (COR-7)', () => {
  const closeSync = vi.fn(() => {
    throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
  });
  const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ closeSync }));

  let thrown: unknown;
  try {
    adapter.close(7);
  } catch (e) {
    thrown = e;
  }
  expect(closeSync).toHaveBeenCalledWith(7);
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code: number }).code).toBe(ERRNO_CODES.EBADF);
});

it('rekeys tracked fds after rename', () => {
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      openSync() {
        return 11;
      },
      existsSync() {
        return true;
      },
      statSync(path: string) {
        return makeStat({ size: path === '/renamed.txt' ? 9 : 0 });
      },
    }),
  );

  const fd = adapter.open('/source.txt', 'r');
  adapter.rename('/source.txt', '/renamed.txt');

  expect(adapter.fstat(fd).size).toBe(9);
});

it('prefers fd-based stats when available', () => {
  const fstatSync = vi.fn(() => makeStat({ size: 42 }));
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      openSync() {
        return 13;
      },
      fstatSync,
      existsSync() {
        return true;
      },
      statSync() {
        throw new Error('path-based stat should not be used');
      },
    }),
  );

  const fd = adapter.open('/fd-based.txt', 'r');

  expect(adapter.fstat(fd).size).toBe(42);
  expect(fstatSync).toHaveBeenCalledWith(fd);
});

it('uses stored inode modes in lstat', () => {
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      existsSync() {
        return true;
      },
      statSync() {
        return makeStat({ is_dir: true, is_file: false, mode: 16872 });
      },
    }),
  );

  expect(adapter.lstat('/').mode).toBe(16872);
});

it('uses stored inode timestamps in lstat and forwards utimes', () => {
  const utimesSync = vi.fn();
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      existsSync() {
        return true;
      },
      statSync() {
        return makeStat({
          mode: 33152,
          atimeMs: 1712345677000,
          mtimeMs: 1712345678000,
          ctimeMs: 1712345679000,
          timestampMs: 1712345678000,
        });
      },
      utimesSync,
    }),
  );

  const stats = adapter.lstat('/file.txt');
  expect(stats.mtime).toBe(1712345678000);

  adapter.utimes('/file.txt', 111, 222);
  expect(utimesSync).toHaveBeenCalledWith('/file.txt', 111, 222);
});

it('forwards symlink and readlink operations when the VFS exposes them', () => {
  const symlinkSync = vi.fn();
  const readlinkSync = vi.fn(() => '../target.txt');
  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      existsSync() {
        return true;
      },
      statSync() {
        return makeStat({ mode: 33188 });
      },
      symlinkSync,
      readlinkSync,
    }),
  );

  adapter.symlink('../target.txt', '/dir/link.txt');
  expect(symlinkSync).toHaveBeenCalledWith('../target.txt', '/dir/link.txt');
  expect(adapter.readlink('/dir/link.txt')).toBe('../target.txt');
});

it('uses lstatSync directly for broken symlinks and preserves errno codes', () => {
  const lstatSync = vi.fn((path: string) => {
    if (path === '/broken-link') {
      return makeStat({ size: 9, is_dir: false, is_file: false, mode: 0o120777 });
    }
    const err = new Error('ELOOP') as Error & { code: string };
    err.code = 'ELOOP';
    throw err;
  });

  const adapter = new OpfsVfsPGliteAdapter(
    makeStubVfs({
      statSync() {
        return makeStat({ mode: 33188 });
      },
      lstatSync,
    }),
  );

  expect(adapter.lstat('/broken-link').mode).toBe(0o120777);
  expect(lstatSync).toHaveBeenCalledWith('/broken-link');
  try {
    adapter.lstat('/loop');
    throw new Error('Expected lstat to throw');
  } catch (error) {
    expect(error).toMatchObject({ code: 32, message: 'ELOOP' });
  }
});

it('closes the leader worker VFS before terminating the worker', async () => {
  const requestWorker = vi.fn(async () => undefined);
  const abortController = new AbortController();
  const abort = vi.spyOn(abortController, 'abort');
  const terminate = vi.fn();
  const close = vi.fn();
  const vfs = Object.create(OpfsVfsWorker.prototype) as unknown as {
    closeVfs: () => Promise<void>;
    isLeader: boolean;
    workerReady: Promise<void>;
    initSent: boolean;
    lockRequests: Promise<unknown>[];
    requestWorker: ReturnType<typeof vi.fn>;
    abortController: AbortController;
    pendingRequests: Map<number, { reject: (error: unknown) => void }>;
    pendingChangeRequests: Map<number, { cleanup: () => void; reject: (error: unknown) => void }>;
    changeChannels: Map<string, unknown>;
    localChangeSubscriptions: Map<string, unknown>;
    localChangeTerminalIds: Set<string>;
    relayedChangeChannels: Map<string, unknown>;
    worker: { terminate: ReturnType<typeof vi.fn> };
    channel: { close: ReturnType<typeof vi.fn> };
  };

  Object.assign(vfs, {
    isLeader: true,
    ready: Promise.resolve(),
    workerReady: Promise.resolve(),
    initSent: true,
    lockRequests: [],
    requestWorker,
    abortController,
    pendingRequests: new Map(),
    pendingChangeRequests: new Map(),
    changeChannels: new Map(),
    localChangeSubscriptions: new Map(),
    localChangeTerminalIds: new Set(),
    relayedChangeChannels: new Map(),
    worker: { terminate },
    channel: { close },
    status: { state: 'ready' },
    statusListeners: new Set(),
  });

  await vfs.closeVfs();

  expect(requestWorker).toHaveBeenCalledWith('CLOSE_VFS', {});
  expect(abort).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects new leader commands while shared shutdown is in progress', async () => {
  const postMessage = vi.fn();
  const vfs = Object.create(OpfsVfsWorker.prototype) as unknown as {
    handleBroadcastMessage: (event: MessageEvent) => void;
    isLeader: boolean;
    isShuttingDown: boolean;
    channel: { postMessage: ReturnType<typeof vi.fn> };
    sendToWorker: ReturnType<typeof vi.fn>;
  };

  Object.assign(vfs, {
    isLeader: true,
    isShuttingDown: true,
    generation: 'test-generation',
    deadClients: new Set(),
    channel: { postMessage },
    sendToWorker: vi.fn(),
  });

  vfs.handleBroadcastMessage({
    data: {
      id: 7,
      payload: { payload: {}, type: 'READDIR' },
      tabId: 'peer-tab',
      clientId: 'test-client',
      generation: 'test-generation',
      type: 'COMMAND',
    },
  } as MessageEvent);

  expect(postMessage).toHaveBeenCalledWith({
    id: 7,
    result: { code: 'VFS_SHUTTING_DOWN', error: 'Shared VFS is shutting down' },
    tabId: 'peer-tab',
    generation: 'test-generation',
    type: 'RESPONSE_ERROR',
  });
});

it('keeps follower transports alive when shared shutdown requests fail', async () => {
  const sendToLeader = vi.fn(async () => {
    const error = new Error('Timeout waiting for leader response for SHUTDOWN_LEADER') as Error & { code?: string };
    error.code = 'LEADER_RESPONSE_TIMEOUT';
    throw error;
  });
  const abort = vi.fn();
  const terminate = vi.fn();
  const close = vi.fn();
  const vfs = Object.create(OpfsVfsWorker.prototype) as unknown as {
    shutdownSharedVfs: () => Promise<void>;
    ready: Promise<void>;
    isLeader: boolean;
    sendToLeader: ReturnType<typeof vi.fn>;
    abortController: { abort: ReturnType<typeof vi.fn> };
    worker: { terminate: ReturnType<typeof vi.fn> };
    channel: { close: ReturnType<typeof vi.fn> };
  };

  Object.assign(vfs, {
    ready: Promise.resolve(),
    isLeader: false,
    sendToLeader,
    abortController: { abort },
    worker: { terminate },
    channel: { close },
  });

  await expect(vfs.shutdownSharedVfs()).rejects.toMatchObject({ code: 'LEADER_RESPONSE_TIMEOUT' });
  expect(abort).not.toHaveBeenCalled();
  expect(terminate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

function runWorkerTest<T>(type: string, bufferMode?: string, timeoutMs = 60000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];
    const timeout = setTimeout(() => {
      logs.forEach((l) => console.log(l));
      worker.terminate();
      reject(new Error(`${type} timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    worker.onerror = (e) => {
      clearTimeout(timeout);
      logs.forEach((l) => console.log(l));
      worker.terminate();
      reject(new Error(`Worker error: ${e.message}`));
    };
    worker.onmessage = (event) => {
      if (event.data.type === 'RESULT') {
        clearTimeout(timeout);
        worker.terminate();
        resolve(event.data.result);
      }
      if (event.data.type === 'ERROR') {
        clearTimeout(timeout);
        logs.forEach((l) => console.log(l));
        worker.terminate();
        reject(new Error(event.data.result));
      }
      if (event.data.type === 'LOG') {
        logs.push(event.data.msg);
      }
    };
    worker.postMessage({ id: 1, type, bufferMode });
  });
}

interface CrudWorkerResult {
  youngUsers: string[];
  aliceAge: number;
  remainingCount: number;
}

interface VolumeWorkerResult {
  count: number;
  firstPayload: string;
  lastValue: number;
  sumTotal: number;
  insertMs: number;
}

interface TransactionWorkerResult {
  afterTransfer: Array<{ balance: number }>;
  rollbackError: string;
  afterRollback: Array<{ balance: number }>;
}

interface WarmStartWorkerResult {
  coldInitMs: number;
  warmInitMs: number;
  coldRowCount: number;
  warmRowCount: number;
  totalRowCount: number;
  warmRows: Array<{ id: number; value: string }>;
}

describe('OpfsVfsPGliteAdapter in Worker', () => {
  it('should work with PGlite in a dedicated worker', async () => {
    const root = await navigator.storage.getDirectory();
    const before = new Set<string>();
    for await (const name of root.keys()) before.add(name);
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];

    const result = await new Promise<Array<{ name: string }>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('=== COLLECTED LOGS (timeout) ===');
        logs.forEach((l) => console.log(l));
        reject(new Error('Worker test timeout (60s)'));
      }, 60000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        console.log('=== COLLECTED LOGS (error) ===');
        logs.forEach((l) => console.log(l));
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'RESULT') {
          clearTimeout(timeout);
          resolve(event.data.result);
        }
        if (event.data.type === 'ERROR') {
          clearTimeout(timeout);
          console.log('=== COLLECTED LOGS (failure) ===');
          logs.forEach((l) => console.log(l));
          reject(new Error(event.data.result));
        }
        if (event.data.type === 'LOG') {
          logs.push(event.data.msg);
        }
      };
      worker.postMessage({ id: 1, type: 'RUN_TEST' });
    });

    const rows = result as { name: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('PGLite OPFS Worker');
    worker.terminate();
    const added: string[] = [];
    for await (const name of root.keys()) {
      if (name.startsWith('pg-worker-test-') && !before.has(name)) added.push(name);
    }
    expect(added).toEqual([]);
  }, 90000);

  it('should handle full CRUD operations', async () => {
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];

    const result = await new Promise<{ youngUsers: string[]; aliceAge: number; remainingCount: number }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          logs.forEach((l) => console.log(l));
          reject(new Error('CRUD test timeout (60s)'));
        }, 60000);
        worker.onerror = (e) => {
          clearTimeout(timeout);
          reject(new Error(`Worker error: ${e.message}`));
        };
        worker.onmessage = (event) => {
          if (event.data.type === 'RESULT') {
            clearTimeout(timeout);
            resolve(event.data.result);
          }
          if (event.data.type === 'ERROR') {
            clearTimeout(timeout);
            logs.forEach((l) => console.log(l));
            reject(new Error(event.data.result));
          }
          if (event.data.type === 'LOG') {
            logs.push(event.data.msg);
          }
        };
        worker.postMessage({ id: 1, type: 'RUN_CRUD_TEST' });
      },
    );

    worker.terminate();

    // SELECT WHERE age < 30 should return Bob (25), Diana (28), Eve (22)
    expect(result.youngUsers).toEqual(['Bob', 'Diana', 'Eve']);
    // Alice's age updated to 31
    expect(result.aliceAge).toBe(31);
    // Eve deleted, 4 remaining
    expect(result.remainingCount).toBe(4);
  }, 90000);

  it('should handle complex schemas with foreign keys and indexes', async () => {
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];

    const result = await new Promise<{
      departments: { dept: string; emp_count: number; avg_salary: string }[];
      assignmentCount: number;
      tableCount: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        logs.forEach((l) => console.log(l));
        reject(new Error('Schema test timeout (60s)'));
      }, 60000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'RESULT') {
          clearTimeout(timeout);
          resolve(event.data.result);
        }
        if (event.data.type === 'ERROR') {
          clearTimeout(timeout);
          logs.forEach((l) => console.log(l));
          reject(new Error(event.data.result));
        }
        if (event.data.type === 'LOG') {
          logs.push(event.data.msg);
        }
      };
      worker.postMessage({ id: 1, type: 'RUN_SCHEMA_TEST' });
    });

    worker.terminate();

    // 4 tables created
    expect(result.tableCount).toBe(4);
    // 3 departments with correct employee counts
    expect(result.departments).toHaveLength(3);
    expect(result.departments.find((d) => d.dept === 'Engineering')!.emp_count).toBe(3);
    // 7 assignments across 3 projects
    expect(result.assignmentCount).toBe(7);
  }, 90000);

  it('should handle 1,000 rows with varying payload sizes', async () => {
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];

    const result = await new Promise<{
      count: number;
      firstPayload: string;
      lastValue: number;
      sumTotal: number;
      insertMs: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        logs.forEach((l) => console.log(l));
        reject(new Error('Volume test timeout (90s)'));
      }, 90000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'RESULT') {
          clearTimeout(timeout);
          resolve(event.data.result);
        }
        if (event.data.type === 'ERROR') {
          clearTimeout(timeout);
          logs.forEach((l) => console.log(l));
          reject(new Error(event.data.result));
        }
        if (event.data.type === 'LOG') {
          logs.push(event.data.msg);
        }
      };
      worker.postMessage({ id: 1, type: 'RUN_VOLUME_TEST' });
    });

    worker.terminate();

    expect(result.count).toBe(1000);
    expect(result.firstPayload).toContain('item-0-');
    expect(result.lastValue).toBe(999);
    // Sum of 0..999 = 499500
    expect(result.sumTotal).toBe(499500);
    console.log(`Volume test: 1000 rows inserted in ${result.insertMs}ms`);
  }, 120000);

  it('should handle transactions with commit and rollback', async () => {
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];

    const result = await new Promise<{
      afterTransfer: { id: number; balance: number }[];
      rollbackError: string;
      afterRollback: { id: number; balance: number }[];
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        logs.forEach((l) => console.log(l));
        reject(new Error('Transaction test timeout (60s)'));
      }, 60000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'RESULT') {
          clearTimeout(timeout);
          resolve(event.data.result);
        }
        if (event.data.type === 'ERROR') {
          clearTimeout(timeout);
          logs.forEach((l) => console.log(l));
          reject(new Error(event.data.result));
        }
        if (event.data.type === 'LOG') {
          logs.push(event.data.msg);
        }
      };
      worker.postMessage({ id: 1, type: 'RUN_TRANSACTION_TEST' });
    });

    worker.terminate();

    // After successful transfer: 1000-200=800, 500+200=700
    expect(result.afterTransfer[0].balance).toBe(800);
    expect(result.afterTransfer[1].balance).toBe(700);
    // Rollback preserved balances
    expect(result.rollbackError).toContain('forced rollback');
    expect(result.afterRollback[0].balance).toBe(800);
    expect(result.afterRollback[1].balance).toBe(700);
  }, 90000);

  it('should warm-start faster and preserve data across close/reopen', async () => {
    const worker = new Worker(new URL('./test-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];

    const result = await new Promise<{
      coldInitMs: number;
      warmInitMs: number;
      coldRowCount: number;
      warmRowCount: number;
      totalRowCount: number;
      warmRows: { id: number; value: string }[];
      allRows: { id: number; value: string }[];
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('=== COLLECTED LOGS (timeout) ===');
        logs.forEach((l) => console.log(l));
        reject(new Error('Warm start test timeout (120s)'));
      }, 120000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        console.log('=== COLLECTED LOGS (error) ===');
        logs.forEach((l) => console.log(l));
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'RESULT') {
          clearTimeout(timeout);
          resolve(event.data.result);
        }
        if (event.data.type === 'ERROR') {
          clearTimeout(timeout);
          console.log('=== COLLECTED LOGS (failure) ===');
          logs.forEach((l) => console.log(l));
          reject(new Error(event.data.result));
        }
        if (event.data.type === 'LOG') {
          logs.push(event.data.msg);
        }
      };
      worker.postMessage({ id: 2, type: 'RUN_WARM_START_TEST' });
    });

    worker.terminate();

    // Data from cold start persists into warm start
    expect(result.coldRowCount).toBe(3);
    expect(result.warmRowCount).toBe(3);
    expect(result.warmRows.map((r) => r.value)).toEqual(['row1', 'row2', 'row3']);

    // Can insert new data after warm start
    expect(result.totalRowCount).toBe(4);

    // Warm start should be significantly faster than cold start
    console.log(`Cold init: ${result.coldInitMs}ms, Warm init: ${result.warmInitMs}ms`);
    expect(result.warmInitMs).toBeLessThan(result.coldInitMs);
  }, 180000);
});

describe('OpfsVfsPGliteAdapter disk mode', () => {
  it('should work with PGlite using disk bufferMode', async () => {
    const rows = await runWorkerTest<Array<{ name: string }>>('RUN_TEST', 'disk', 90000);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('PGLite OPFS Worker');
  }, 90000);

  it('should handle full CRUD operations in disk mode', async () => {
    const result = await runWorkerTest<CrudWorkerResult>('RUN_CRUD_TEST', 'disk', 90000);
    expect(result.youngUsers).toEqual(['Bob', 'Diana', 'Eve']);
    expect(result.aliceAge).toBe(31);
    expect(result.remainingCount).toBe(4);
  }, 90000);

  it('should handle 1,000 rows in disk mode', async () => {
    const result = await runWorkerTest<VolumeWorkerResult>('RUN_VOLUME_TEST', 'disk', 120000);
    expect(result.count).toBe(1000);
    expect(result.firstPayload).toContain('item-0-');
    expect(result.lastValue).toBe(999);
    expect(result.sumTotal).toBe(499500);
    console.log(`Disk mode volume test: 1000 rows inserted in ${result.insertMs}ms`);
  }, 120000);

  it('should handle transactions in disk mode', async () => {
    const result = await runWorkerTest<TransactionWorkerResult>('RUN_TRANSACTION_TEST', 'disk', 90000);
    expect(result.afterTransfer[0].balance).toBe(800);
    expect(result.afterTransfer[1].balance).toBe(700);
    expect(result.rollbackError).toContain('forced rollback');
    expect(result.afterRollback[0].balance).toBe(800);
    expect(result.afterRollback[1].balance).toBe(700);
  }, 90000);

  it('should persist data across close/reopen in disk mode', async () => {
    const result = await runWorkerTest<WarmStartWorkerResult>('RUN_WARM_START_TEST', 'disk', 180000);
    expect(result.coldRowCount).toBe(3);
    expect(result.warmRowCount).toBe(3);
    expect(result.warmRows.map((r: { value: string }) => r.value)).toEqual(['row1', 'row2', 'row3']);
    expect(result.totalRowCount).toBe(4);
    console.log(`Disk mode - Cold init: ${result.coldInitMs}ms, Warm init: ${result.warmInitMs}ms`);
  }, 180000);
});

describe('SEC-3: makeBufferView rejects invalid lengths', () => {
  it('throws EINVAL on negative length instead of clamping to rest of buffer', () => {
    const writeSync = vi.fn(() => 0);
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ writeSync }));
    const buffer = new Uint8Array(16);
    expect(() => adapter.write(1, buffer, 0, -1, 0)).toThrow(expect.objectContaining({ code: ERRNO_CODES.EINVAL }));
    // The unsigned coercion must never reach the underlying vfs with a giant window.
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('throws EINVAL on non-integer (NaN/float) length', () => {
    const writeSync = vi.fn(() => 0);
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ writeSync }));
    const buffer = new Uint8Array(16);
    expect(() => adapter.write(1, buffer, 0, Number.NaN, 0)).toThrow(
      expect.objectContaining({ code: ERRNO_CODES.EINVAL }),
    );
    expect(() => adapter.write(1, buffer, 0, 1.5, 0)).toThrow(expect.objectContaining({ code: ERRNO_CODES.EINVAL }));
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('accepts a valid integer length', () => {
    const writeSync = vi.fn((_fd: number, view: Uint8Array) => view.byteLength);
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ writeSync }));
    const buffer = new Uint8Array(16);
    expect(adapter.write(1, buffer, 0, 8, 0)).toBe(8);
    expect(writeSync).toHaveBeenCalledTimes(1);
  });
});

describe('Adapter audit regressions', () => {
  for (const kind of ['readInto', 'readSync', 'write'] as const) {
    function setup() {
      const vfs = makeStubVfs({
        readSync: vi.fn((_fd, length) => ({ buffer: new Uint8Array(length).fill(7), read: length })),
        writeSync: vi.fn((_fd, view) => {
          expect([...view]).not.toContain(99);
          return view.byteLength;
        }),
        ...(kind === 'readInto'
          ? {
              readInto: vi.fn((_fd: number, view: Uint8Array) => {
                view.fill(7);
                return view.byteLength;
              }),
            }
          : {}),
      });
      const adapter = new OpfsVfsPGliteAdapter(vfs);
      const backing = new Uint8Array([99, 99, 1, 2, 3, 99, 99]);
      const view = backing.subarray(2, 5);
      const call = (offset: number, length: number) =>
        kind === 'write' ? adapter.write(1, view, offset, length, 0) : adapter.read(1, view, offset, length, 0);
      return { call, backing, vfs };
    }
    for (const length of [20, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      it(`${kind} confines length ${length} to the supplied subarray`, () => {
        const { call, backing } = setup();
        expect(call(1, length)).toBe(2);
        expect([...backing]).toEqual(kind === 'write' ? [99, 99, 1, 2, 3, 99, 99] : [99, 99, 1, 7, 7, 99, 99]);
      });
    }
    it(`${kind} rejects invalid windows before I/O, including zero-length windows`, () => {
      const { call, vfs } = setup();
      for (const offset of [-1, 0.5, 4, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        for (const length of [0, 1])
          expect(() => call(offset, length)).toThrow(expect.objectContaining({ code: ERRNO_CODES.EINVAL }));
      }
      for (const length of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => call(0, length)).toThrow(expect.objectContaining({ code: ERRNO_CODES.EINVAL }));
      }
      expect(vfs.writeSync).not.toHaveBeenCalled();
      expect(vfs.readSync).not.toHaveBeenCalled();
      if (vfs.readInto) expect(vfs.readInto).not.toHaveBeenCalled();
    });
  }
  for (const fast of [false, true]) {
    it(`rejects malformed backend read counts, fast=${fast}`, () => {
      for (const count of [-1, 0.5, NaN, Infinity, 3]) {
        const adapter = new OpfsVfsPGliteAdapter(
          makeStubVfs({
            readSync: () => ({ buffer: new Uint8Array(2), read: count }),
            ...(fast ? { readInto: () => count } : {}),
          }),
        );
        expect(() => adapter.read(1, new Uint8Array(2), 0, 2, 0)).toThrow(
          expect.objectContaining({ code: ERRNO_CODES.EINVAL }),
        );
      }
    });
  }
  it('rejects a fallback count larger than its returned buffer without copying', () => {
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ readSync: () => ({ buffer: new Uint8Array(1), read: 2 }) }));
    const target = new Uint8Array([9, 9]);
    expect(() => adapter.read(1, target, 0, 2, 0)).toThrow(expect.objectContaining({ code: ERRNO_CODES.EINVAL }));
    expect([...target]).toEqual([9, 9]);
  });
  it('still delegates zero-length writes for descriptor validation', () => {
    const error = new Error('bad fd');
    const adapter = new OpfsVfsPGliteAdapter(
      makeStubVfs({
        writeSync: () => {
          throw error;
        },
      }),
    );
    expect(() => adapter.write(999, new Uint8Array(0), 0, 0, 0)).toThrow(error);
  });
  it('validates zero-length windows through the Emscripten bridge', () => {
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs());
    const bridge = (
      adapter as unknown as {
        createPGliteFilesystemBridge(mod: unknown): { stream_ops: { read(...args: unknown[]): number } };
      }
    ).createPGliteFilesystemBridge({
      FS: {
        ErrnoError: class extends Error {
          constructor(public errno: number) {
            super('invalid');
          }
        },
      },
    });
    expect(() => bridge.stream_ops.read({ nfd: 1 }, new Uint8Array(2), -1, 0, 0)).toThrow(
      expect.objectContaining({ errno: ERRNO_CODES.EINVAL }),
    );
  });
  for (const phase of ['open', 'stat', 'read', 'write', 'close'] as const) {
    for (const closeFails of [false, true]) {
      it(`closes once and preserves errors after ${phase} failure, closeFails=${closeFails}`, () => {
        const error = new Error(`${phase} failed`);
        const closeError = phase === 'close' ? error : new Error('close failed');
        const fail = () => {
          throw error;
        };
        const closeSync = vi.fn(() => {
          if (closeFails || phase === 'close') throw closeError;
        });
        const chmodSync = vi.fn();
        const adapter = new OpfsVfsPGliteAdapter(
          makeStubVfs({
            openSync: phase === 'open' ? fail : () => 7,
            statSync: phase === 'stat' ? fail : () => makeStat({ size: 1 }),
            readSync: phase === 'read' ? fail : () => ({ buffer: new Uint8Array(1), read: 1 }),
            writeSync: phase === 'write' ? fail : () => 1,
            closeSync,
            chmodSync,
          }),
        );
        const action =
          phase === 'write' ? () => adapter.writeFile('/file', 'x', { mode: 0o600 }) : () => adapter.readFile('/file');
        expect(action).toThrow(error);
        expect(closeSync).toHaveBeenCalledTimes(phase === 'open' ? 0 : 1);
        expect(chmodSync).not.toHaveBeenCalled();
      });
    }
  }
  it('does not truncate/open a destination when string encoding fails', () => {
    const error = new Error('encoding failed');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
      throw error;
    });
    const openSync = vi.fn(() => 7);
    try {
      const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ openSync }));
      expect(() => adapter.writeFile('/file', 'x')).toThrow(error);
      expect(openSync).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });
});

describe('Adapter audit writeFile cleanup', () => {
  it('does not chmod after a close failure and does not close after a failed open', () => {
    const error = new Error('failed');
    const fail = () => {
      throw error;
    };
    const chmodSync = vi.fn();
    const closeSync = vi.fn(fail);
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs({ closeSync, chmodSync }));
    expect(() => adapter.writeFile('/file', '', { mode: 0o600 })).toThrow(error);
    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(chmodSync).not.toHaveBeenCalled();
    closeSync.mockClear();
    const missing = new OpfsVfsPGliteAdapter(makeStubVfs({ openSync: fail, closeSync }));
    expect(() => missing.writeFile('/file', 'x')).toThrow(error);
    expect(closeSync).not.toHaveBeenCalled();
  });
});

describe('errno mapping', () => {
  const toErrno = (error: unknown) =>
    (
      new OpfsVfsPGliteAdapter(makeStubVfs()) as unknown as { toErrnoCode(error: unknown, fallback: number): number }
    ).toErrnoCode(error, -1);

  it('maps VFS codes to Emscripten numbers, never Linux errnos', () => {
    expect(toErrno(createVfsError('EFBIG'))).toBe(22); // Linux 27 is EINTR here.
    expect(toErrno(createVfsError('ENAMETOOLONG'))).toBe(37);
  });

  it('maps DOMExceptions by name instead of their legacy numeric code', () => {
    expect(toErrno(new DOMException('full', 'QuotaExceededError'))).toBe(51);
    expect(toErrno(new DOMException('gone', 'InvalidStateError'))).toBe(29);
    expect(toErrno(new DOMException('odd', 'UnknownError'))).toBe(29); // Code 0 would mean success.
  });

  it('does not trust unrelated numeric error codes', () => {
    expect(toErrno(Object.assign(new Error('foreign errno'), { code: 52, errno: 52 }))).toBe(-1);
  });

  it('preserves ENOSYS for missing symlink methods through the bridge', () => {
    const adapter = new OpfsVfsPGliteAdapter(makeStubVfs());
    const bridge = (
      adapter as unknown as {
        createPGliteFilesystemBridge(mod: unknown): {
          node_ops: { symlink(...args: unknown[]): void; readlink(...args: unknown[]): string };
        };
      }
    ).createPGliteFilesystemBridge({
      FS: {
        ErrnoError: class extends Error {
          constructor(public errno: number) {
            super('unsupported');
          }
        },
      },
    });
    const node = { mount: { opts: { root: '/' } } };
    Object.assign(node, { parent: node });
    expect(() => adapter.symlink('/target', '/link')).toThrow(expect.objectContaining({ code: 52 }));
    expect(() => adapter.readlink('/link')).toThrow(expect.objectContaining({ code: 52 }));
    expect(() => bridge.node_ops.symlink(node, 'link', '/target')).toThrow(expect.objectContaining({ errno: 52 }));
    expect(() => bridge.node_ops.readlink(node)).toThrow(expect.objectContaining({ errno: 52 }));
  });
});

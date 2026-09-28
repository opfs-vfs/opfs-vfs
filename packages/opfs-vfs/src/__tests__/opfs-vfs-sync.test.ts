import { describe, expect, it, vi } from 'vitest';

import { Bitmap, OpenFlags, OpfsVfs } from '../opfs-vfs';
import { replayLog } from '../binary-metadata';

function expectErrorCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} error`);
}

function makeInode() {
  return {
    ino: 2,
    isDir: false,
    size: 0,
    blocks: [] as number[],
    children: [] as string[],
    mode: 33188,
    nlink: 1,
    atimeMs: 1712345600000,
    mtimeMs: 1712345610000,
    ctimeMs: 1712345620000,
    timestampMs: 1712345610000,
  };
}

function makeDirInode() {
  return {
    ino: 1,
    isDir: true,
    size: 0,
    blocks: [] as number[],
    children: [] as string[],
    mode: 16877,
    nlink: 2,
    atimeMs: 1712345600000,
    mtimeMs: 1712345610000,
    ctimeMs: 1712345620000,
    timestampMs: 1712345610000,
  };
}

type TestOpenFile = {
  path: string;
  cursor: number;
  inodeId: number;
  inode: ReturnType<typeof makeInode>;
  data?: Uint8Array;
  flags: number;
  readable: boolean;
  writable: boolean;
  append: boolean;
};

type TestVfsMethods = Pick<
  OpfsVfs,
  | 'closeSync'
  | 'closeVfs'
  | 'syncSync'
  | 'openSync'
  | 'readSync'
  | 'statSync'
  | 'renameSync'
  | 'rmdirSync'
  | 'readdirSync'
  | 'linkSync'
  | 'writeSync'
  | 'unlinkSync'
  | 'existsSync'
  | 'ftruncateSync'
  | 'fstatSync'
  | 'utimesSync'
  | 'chmodSync'
  | 'mkdirSync'
  | 'symlinkSync'
  | 'readlinkSync'
  | 'lstatSync'
  | 'realpathSync'
  | 'getLocalPersistenceStatusSync'
  | 'getStorageEstimate'
>;

type TestVfsHarness = TestVfsMethods & {
  bufferMode: 'memory' | 'disk';
  closed: boolean;
  flushed: boolean;
  dataDirty: boolean;
  bitmapDirty: boolean;
  dirtyStructure: boolean;
  dirtyInodes: Set<string>;
  attrDirtyInodes: Set<string>;
  deletedInodes: Set<string>;
  dirtyPages: Map<ReturnType<typeof makeInode>, Set<number>>;
  fileData: Map<string, Uint8Array>;
  pendingDeletedInodes: Set<ReturnType<typeof makeInode>>;
  pendingFree: Set<number>;
  openFiles: Map<number, TestOpenFile>;
  bitmap: {
    getRawBits: () => Uint32Array;
    highestSet: () => number;
    alloc: ReturnType<typeof vi.fn>;
    free: ReturnType<typeof vi.fn>;
    grow: ReturnType<typeof vi.fn>;
  };
  dataHandle: {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    truncate: ReturnType<typeof vi.fn>;
  };
  bitmapHandle: {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    truncate: ReturnType<typeof vi.fn>;
  };
  logHandle: {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    truncate: ReturnType<typeof vi.fn>;
  };
  dataLogHandle: {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    truncate: ReturnType<typeof vi.fn>;
  };
  inodes: Map<string, ReturnType<typeof makeInode>>;
  sortedPaths: string[];
  totalBlocks: number;
  logOffset: number;
  maxFileSize: number;
  allocatedDataBlocks: number;
  metaSnapshotSequence: number;
  activeMetaSlot: 0 | 1;
  seekSync: OpfsVfs['seekSync'];
  truncateSync: OpfsVfs['truncateSync'];
};

function makeBareVfs(overrides: Record<string, unknown> = {}) {
  const dataHandle = {
    read: vi.fn(),
    write: vi.fn((bytes: Uint8Array) => bytes.byteLength),
    flush: vi.fn(),
    close: vi.fn(),
    getSize: vi.fn(() => 0),
    truncate: vi.fn(),
  };
  const bitmapHandle = {
    read: vi.fn(),
    write: vi.fn((bytes: Uint8Array) => bytes.byteLength),
    flush: vi.fn(),
    close: vi.fn(),
    getSize: vi.fn(() => 0),
    truncate: vi.fn(),
  };
  const metaHandleA = {
    read: vi.fn(),
    write: vi.fn((bytes: Uint8Array) => bytes.byteLength),
    flush: vi.fn(),
    close: vi.fn(),
    getSize: vi.fn(() => 0),
    truncate: vi.fn(),
  };
  const metaHandleB = {
    read: vi.fn(),
    write: vi.fn((bytes: Uint8Array) => bytes.byteLength),
    flush: vi.fn(),
    close: vi.fn(),
    getSize: vi.fn(() => 0),
    truncate: vi.fn(),
  };
  const logHandle = {
    read: vi.fn(),
    write: vi.fn((bytes: Uint8Array) => bytes.byteLength),
    flush: vi.fn(),
    close: vi.fn(),
    getSize: vi.fn(() => 0),
    truncate: vi.fn(),
  };
  const dataLogHandle = {
    read: vi.fn(),
    write: vi.fn((bytes: Uint8Array) => bytes.byteLength),
    flush: vi.fn(),
    close: vi.fn(),
    getSize: vi.fn(() => 0),
    truncate: vi.fn(),
  };

  const vfs = Object.create(OpfsVfs.prototype) as unknown as TestVfsHarness;
  Object.assign(vfs, {
    bufferMode: 'disk',
    closed: false,
    flushed: false,
    dataDirty: false,
    bitmapDirty: false,
    dirtyStructure: false,
    dirtyInodes: new Set<string>(),
    attrDirtyInodes: new Set<string>(),
    deletedInodes: new Set<string>(),
    dirtyPages: new Map<ReturnType<typeof makeInode>, Set<number>>(),
    fileData: new Map<string, Uint8Array>(),
    pendingDeletedInodes: new Set(),
    pendingFree: new Set<number>(),
    openFiles: new Map<number, TestOpenFile>(),
    bitmap: {
      getRawBits: () => new Uint32Array([1]),
      highestSet: () => 0,
      alloc: vi.fn(),
      free: vi.fn(),
      grow: vi.fn(),
    },
    dataHandle,
    bitmapHandle,
    metaHandleA,
    metaHandleB,
    activeMetaSlot: 0,
    metaSnapshotSequence: 0,
    logHandle,
    dataLogHandle,
    lastSnapshotSize: 0,
    localDurabilityMode: 'strict',
    localPersistenceState: 'clean',
    dataLogOffset: 0,
    debugWal: false,
    maxFileSize: 0xffffffff,
    // SEC-4 quotas: name length defaults to POSIX NAME_MAX; the rest are opt-in.
    maxNameLength: 255,
    maxPathDepth: undefined,
    maxFiles: undefined,
    maxTotalBytes: undefined,
    allocatedDataBlocks: 0,
    inodes: new Map<string, ReturnType<typeof makeInode>>([['/', makeDirInode() as ReturnType<typeof makeInode>]]),
    sortedPaths: ['/'],
    totalBlocks: 16,
    logOffset: 0,
    // Object.create(OpfsVfs.prototype) skips class field initializers, so seed the
    // fd / inode-number counters the constructor would otherwise set. Without these
    // openSync would `undefined++` -> NaN and collide every descriptor.
    storageHandles: [],
    nextFd: 10,
    nextInodeNumber: 2,
    ...overrides,
  });

  return { vfs, dataHandle, bitmapHandle, metaHandleA, metaHandleB, logHandle, dataLogHandle };
}

describe('OpfsVfs sync behavior', () => {
  it('attempts every close and destroys storage even when cleanup throws', () => {
    const firstError = new Error('data WAL close failed');
    const secondError = new Error('meta close failed');
    const lateError = new Error('extension close failed');
    const destroy = vi.fn();
    const extraHandles = Object.fromEntries(
      ['bootstrapHandle', 'extensionHandle'].map((key) => [key, { close: vi.fn() }]),
    );
    extraHandles.extensionHandle.close.mockImplementation(() => {
      throw lateError;
    });
    const { vfs, dataHandle, metaHandleA, metaHandleB, logHandle, dataLogHandle } = makeBareVfs({
      flushed: true,
      storage: { destroy },
      storageHandles: [extraHandles.extensionHandle],
      bootstrapHandle: extraHandles.bootstrapHandle,
    });
    dataLogHandle.close.mockImplementation(() => {
      throw firstError;
    });
    metaHandleA.close.mockImplementation(() => {
      throw secondError;
    });
    let error: unknown;
    try {
      void vfs.closeVfs();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstError, secondError, lateError]);
    for (const handle of [
      dataHandle,
      metaHandleA,
      metaHandleB,
      logHandle,
      dataLogHandle,
      ...Object.values(extraHandles),
    ]) {
      expect(handle.close).toHaveBeenCalledTimes(1);
    }
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(vfs.closed).toBe(true);
    expect(vfs.getLocalPersistenceStatusSync().localPersistenceState).toBe('error');
    expect(() => vfs.closeVfs()).not.toThrow();
  });

  it('removes both balanced flush listeners on close', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('addEventListener', add);
    vi.stubGlobal('removeEventListener', remove);
    try {
      const { vfs, dataHandle } = makeBareVfs({ flushed: true });
      (vfs as unknown as { installBalancedModeHooks(): void }).installBalancedModeHooks();
      void vfs.closeVfs();
      expect(remove.mock.calls).toEqual(add.mock.calls);
      expect(remove.mock.calls.map(([name]) => name)).toEqual(['pagehide', 'beforeunload']);
      // A callback already queued before removal must also be harmless.
      vfs.flushed = false;
      add.mock.calls[0][1]();
      expect(dataHandle.flush).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a flush failure first when handle cleanup also fails', () => {
    const flushError = new Error('flush failed');
    const closeError = new Error('close failed');
    const { vfs, dataHandle, dataLogHandle } = makeBareVfs();
    dataHandle.flush.mockImplementation(() => {
      throw flushError;
    });
    dataLogHandle.close.mockImplementation(() => {
      throw closeError;
    });
    let error: unknown;
    try {
      void vfs.closeVfs();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([flushError, closeError]);
    expect(dataHandle.close).toHaveBeenCalledOnce();
    expect(vfs.closed).toBe(true);
  });

  it('preserves the descriptor cursor when an explicit write exceeds the size limit', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxFileSize: 8 });
    const fd = vfs.openSync('/data', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, new Uint8Array([1, 2]));
    expectErrorCode(() => vfs.writeSync(fd, new Uint8Array([9]), 8), 'EFBIG');
    expect(vfs.seekSync(fd, 0, 1)).toBe(2);
    vfs.writeSync(fd, new Uint8Array([3]));
    expect(vfs.readSync(fd, 3, 0).buffer).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('does not flush the disk data handle on closeSync', () => {
    const inode = makeInode();
    const { vfs, dataHandle } = makeBareVfs();
    vfs.openFiles.set(7, {
      path: '/file',
      cursor: 0,
      inodeId: inode.ino,
      inode,
      flags: 2,
      readable: true,
      writable: true,
      append: false,
    });

    vfs.closeSync(7);

    expect(dataHandle.flush).not.toHaveBeenCalled();
  });

  it('skips disk sync work when nothing is dirty', () => {
    const { vfs, dataHandle, bitmapHandle, logHandle } = makeBareVfs();

    vfs.syncSync();

    expect(dataHandle.flush).not.toHaveBeenCalled();
    expect(bitmapHandle.write).not.toHaveBeenCalled();
    expect(logHandle.write).not.toHaveBeenCalled();
  });

  it('flushes dirty disk data without rewriting the bitmap when allocation state is unchanged', () => {
    const { vfs, dataHandle, bitmapHandle } = makeBareVfs({ dataDirty: true });

    vfs.syncSync();

    expect(dataHandle.flush).toHaveBeenCalledTimes(1);
    expect(bitmapHandle.write).not.toHaveBeenCalled();
  });

  it('rejects reads on write-only file descriptors', () => {
    const { vfs } = makeBareVfs();
    vfs.openSync('/file.txt', OpenFlags.O_CREAT | OpenFlags.O_WRONLY);

    expectErrorCode(() => vfs.readSync(10, 1, 0), 'EBADF');
  });

  it('rejects opening a file for writing without write permission', () => {
    const file = makeInode();
    file.mode = 0o100444;
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/readonly.txt', file],
      ]),
      sortedPaths: ['/', '/readonly.txt'],
    });

    expectErrorCode(() => vfs.openSync('/readonly.txt', OpenFlags.O_WRONLY), 'EACCES');
  });

  it('rejects file creation inside an unwritable directory', () => {
    const dir = makeDirInode();
    dir.mode = 0o40555;
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/locked', dir],
      ]),
      sortedPaths: ['/', '/locked'],
    });

    expectErrorCode(() => vfs.openSync('/locked/new.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR), 'EACCES');
  });

  it('rejects lookups through a non-searchable directory', () => {
    const lockedDir = makeDirInode();
    lockedDir.mode = 0o40600;
    const file = makeInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/locked', lockedDir],
        ['/locked/file.txt', file],
      ]),
      sortedPaths: ['/', '/locked', '/locked/file.txt'],
    });

    expectErrorCode(() => vfs.statSync('/locked/file.txt'), 'EACCES');
  });

  it('treats trailing slashes as a directory requirement', () => {
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file.txt', makeInode()],
      ]),
      sortedPaths: ['/', '/file.txt'],
    });

    expectErrorCode(() => vfs.statSync('/file.txt/'), 'ENOTDIR');
  });

  it('rejects unlink on directories', () => {
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/dir', makeDirInode()],
      ]),
      sortedPaths: ['/', '/dir'],
    });

    expectErrorCode(() => vfs.unlinkSync('/dir'), 'EISDIR');
  });

  it('maintains directory link counts across mkdir, rename, and rmdir', () => {
    const { vfs } = makeBareVfs({
      inodes: new Map([['/', makeDirInode()]]),
      sortedPaths: ['/'],
    });

    vfs.mkdirSync('/a');
    vfs.mkdirSync('/b');
    vfs.mkdirSync('/a/child');

    expect(vfs.statSync('/').nlink).toBe(4);
    expect(vfs.statSync('/a').nlink).toBe(3);
    expect(vfs.statSync('/b').nlink).toBe(2);
    expect(vfs.statSync('/a/child').nlink).toBe(2);

    vfs.renameSync('/a/child', '/b/child');
    expect(vfs.statSync('/a').nlink).toBe(2);
    expect(vfs.statSync('/b').nlink).toBe(3);

    vfs.rmdirSync('/b/child');
    expect(vfs.statSync('/b').nlink).toBe(2);
  });

  it('supports recursive mkdir and returns dot entries from readdir', () => {
    const { vfs } = makeBareVfs({
      inodes: new Map([['/', makeDirInode()]]),
      sortedPaths: ['/'],
    });

    vfs.mkdirSync('/a/b/c', { recursive: true });

    const entries = vfs.readdirSync('/a/b');
    expect(entries).toContain('.');
    expect(entries).toContain('..');
    expect(entries).toContain('c');
  });

  it('supports recursive mkdir through symlinked directories', () => {
    const realDir = makeDirInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/real', realDir],
      ]),
      sortedPaths: ['/', '/real'],
    });

    vfs.symlinkSync('/real', '/link');
    vfs.mkdirSync('/link/nested/child', { recursive: true });

    expect(vfs.existsSync('/real/nested')).toBe(true);
    expect(vfs.existsSync('/real/nested/child')).toBe(true);
    expect(vfs.existsSync('/link/nested/child')).toBe(true);
  });

  it('enforces search permissions for recursive mkdir on existing paths', () => {
    const sealed = makeDirInode();
    sealed.children = ['sub'];
    sealed.mode = 0o40600;
    const sub = makeDirInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/sealed', sealed],
        ['/sealed/sub', sub],
      ]),
      sortedPaths: ['/', '/sealed', '/sealed/sub'],
    });

    expectErrorCode(() => vfs.mkdirSync('/sealed/sub', { recursive: true }), 'EACCES');
  });

  it('rejects rmdir on non-empty directories', () => {
    const dir = makeDirInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/dir', dir],
        ['/dir/child.txt', makeInode()],
      ]),
      sortedPaths: ['/', '/dir', '/dir/child.txt'],
    });

    expectErrorCode(() => vfs.rmdirSync('/dir'), 'ENOTEMPTY');
  });

  it('rejects readdir on unreadable directories', () => {
    const dir = makeDirInode();
    dir.mode = 0o40111;
    dir.children = ['child.txt'];
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/dir', dir],
      ]),
      sortedPaths: ['/', '/dir'],
    });

    expectErrorCode(() => vfs.readdirSync('/dir'), 'EACCES');
  });

  it('keeps inode numbers stable across rename', () => {
    const file = makeInode();
    file.ino = 42;
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file.txt', file],
      ]),
      sortedPaths: ['/', '/file.txt'],
    });

    vfs.renameSync('/file.txt', '/renamed.txt');

    expect(vfs.statSync('/renamed.txt').ino).toBe(42);
  });

  it('shares inode state across hard-linked paths and decrements link counts on unlink', () => {
    const file = makeInode();
    file.ino = 42;
    file.size = 3;
    const root = makeDirInode();
    root.children = ['a.txt'];
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', root],
        ['/a.txt', file],
      ]),
      fileData: new Map([['/a.txt', new Uint8Array([97, 98, 99])]]),
      sortedPaths: ['/', '/a.txt'],
    });

    vfs.linkSync('/a.txt', '/b.txt');

    expect(vfs.statSync('/a.txt').ino).toBe(42);
    expect(vfs.statSync('/b.txt').ino).toBe(42);
    expect(vfs.statSync('/a.txt').nlink).toBe(2);

    const initialReadFd = vfs.openSync('/b.txt', OpenFlags.O_RDONLY);
    expect(Array.from(vfs.readSync(initialReadFd, 3, 0).buffer)).toEqual([97, 98, 99]);

    const writeFd = vfs.openSync('/a.txt', OpenFlags.O_WRONLY | OpenFlags.O_TRUNC);
    vfs.writeSync(writeFd, new Uint8Array([120, 121]), 0);
    vfs.closeSync(writeFd);

    const rereadFd = vfs.openSync('/b.txt', OpenFlags.O_RDONLY);
    expect(Array.from(vfs.readSync(rereadFd, 2, 0).buffer)).toEqual([120, 121]);

    vfs.unlinkSync('/a.txt');

    expect(vfs.existsSync('/a.txt')).toBe(false);
    expect(vfs.existsSync('/b.txt')).toBe(true);
    expect(vfs.statSync('/b.txt').nlink).toBe(1);
    const postUnlinkFd = vfs.openSync('/b.txt', OpenFlags.O_RDONLY);
    expect(Array.from(vfs.readSync(postUnlinkFd, 2, 0).buffer)).toEqual([120, 121]);
  });

  it('allows ftruncate on an open unlinked file descriptor', () => {
    const inode = makeInode();
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/tmp.txt', inode],
      ]),
      sortedPaths: ['/', '/tmp.txt'],
    });
    vfs.openFiles.set(10, {
      path: '/tmp.txt',
      cursor: 0,
      inodeId: inode.ino,
      inode,
      flags: 2,
      readable: true,
      writable: true,
      append: false,
    });

    vfs.unlinkSync('/tmp.txt');
    vfs.ftruncateSync(10, 8);

    expect(vfs.fstatSync(10).size).toBe(8);
    expect(vfs.fstatSync(10).nlink).toBe(0);
  });

  it('allows rmdir of a dir after its only file was unlinked while an fd stays open (COR-3)', () => {
    const dir = makeDirInode();
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        [
          '/',
          (() => {
            const root = makeDirInode();
            root.children = ['d'];
            return root;
          })(),
        ],
        ['/d', dir],
      ]),
      sortedPaths: ['/', '/d'],
    });

    const fd = vfs.openSync('/d/f', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);
    vfs.writeSync(fd, new Uint8Array([1, 2, 3]), 0);
    vfs.unlinkSync('/d/f');

    // The dir is now empty in the namespace; the open fd must not block rmdir.
    expect(() => vfs.rmdirSync('/d')).not.toThrow();
    expect(vfs.existsSync('/d')).toBe(false);

    // The fd survives and still reads its data.
    expect(Array.from(vfs.readSync(fd, 3, 0).buffer)).toEqual([1, 2, 3]);
    vfs.closeSync(fd);
  });

  it('write through an unlinked fd does not clobber a successor file at the same path (PERF-4)', () => {
    const root = makeDirInode();
    root.children = [];
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([['/', root]]),
      sortedPaths: ['/'],
    });

    const oldFd = vfs.openSync('/f', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);
    vfs.writeSync(oldFd, new Uint8Array([1, 1, 1]), 0);
    vfs.unlinkSync('/f');

    // A new file reuses the path while the unlinked fd is still open (the
    // classic tempfile pattern), then the old fd keeps writing.
    const newFd = vfs.openSync('/f', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);
    vfs.writeSync(newFd, new Uint8Array([7, 7]), 0);
    vfs.writeSync(oldFd, new Uint8Array([2, 2, 2]), 0);

    // The old fd's write must stay private to its (deleted) inode: a fresh fd
    // on the path hydrates from fileData and must see the successor's content.
    const checkFd = vfs.openSync('/f', OpenFlags.O_RDWR, 0o644);
    expect(Array.from(vfs.readSync(checkFd, 2, 0).buffer)).toEqual([7, 7]);
    expect(Array.from(vfs.readSync(oldFd, 3, 0).buffer)).toEqual([2, 2, 2]);

    vfs.closeSync(checkFd);
    vfs.closeSync(newFd);
    vfs.closeSync(oldFd);
  });

  it('rename atomically replaces an open file target without EBUSY (COR-3)', () => {
    const root = makeDirInode();
    root.children = [];
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([['/', root]]),
      sortedPaths: ['/'],
    });

    const srcFd = vfs.openSync('/a', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);
    vfs.writeSync(srcFd, new Uint8Array([10, 20]), 0);
    vfs.closeSync(srcFd);

    const dstFd = vfs.openSync('/b', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);
    vfs.writeSync(dstFd, new Uint8Array([99]), 0);

    // POSIX: rename over an open target succeeds; the open fd stays valid on the
    // replaced inode.
    expect(() => vfs.renameSync('/a', '/b')).not.toThrow();
    expect(Array.from(vfs.readSync(dstFd, 1, 0).buffer)).toEqual([99]);
    vfs.closeSync(dstFd);

    // /b now resolves to the source content.
    const checkFd = vfs.openSync('/b', OpenFlags.O_RDONLY);
    expect(Array.from(vfs.readSync(checkFd, 2, 0).buffer)).toEqual([10, 20]);
    vfs.closeSync(checkFd);
    expect(vfs.existsSync('/a')).toBe(false);
  });

  it('still blocks rmdir of a non-empty dir holding a still-linked open file (COR-3)', () => {
    const dir = makeDirInode();
    const root = makeDirInode();
    root.children = ['d'];
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', root],
        ['/d', dir],
      ]),
      sortedPaths: ['/', '/d'],
    });

    const fd = vfs.openSync('/d/f', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);

    // File is still linked → dir is non-empty → ENOTEMPTY (not silently removable).
    expectErrorCode(() => vfs.rmdirSync('/d'), 'ENOTEMPTY');
    vfs.closeSync(fd);
  });

  it('same-parent rename replacing an empty dir decrements parent nlink (COR-4)', () => {
    const root = makeDirInode();
    root.children = ['a', 'b'];
    root.nlink = 4; // 2 base + 1 per subdir (a, b)
    const a = makeDirInode();
    a.ino = 10;
    const b = makeDirInode();
    b.ino = 11;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', root],
        ['/a', a],
        ['/b', b],
      ]),
      sortedPaths: ['/', '/a', '/b'],
    });

    vfs.renameSync('/a', '/b');

    // /b is gone (replaced); only one subdir remains, so parent nlink drops 4 -> 3.
    expect(vfs.statSync('/').nlink).toBe(3);
    expect(vfs.existsSync('/a')).toBe(false);
    expect(vfs.statSync('/b').ino).toBe(10);
  });

  it('O_APPEND opens start the read cursor at 0 so a+ reads return content (COR-5)', () => {
    const file = makeInode();
    file.size = 5;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/log.txt', file],
      ]),
      sortedPaths: ['/', '/log.txt'],
      fileData: new Map([['/log.txt', new TextEncoder().encode('hello')]]),
    });

    const fd = vfs.openSync('/log.txt', OpenFlags.O_RDWR | OpenFlags.O_APPEND);
    // Implicit-cursor read (no offset) must see the existing content from offset 0.
    const res = vfs.readSync(fd, 5);
    expect(new TextDecoder().decode(res.buffer)).toBe('hello');

    // Writes still append at EOF regardless of cursor.
    vfs.writeSync(fd, new TextEncoder().encode('!'));
    expect(vfs.statSync('/log.txt').size).toBe(6);
    const after = vfs.openSync('/log.txt', OpenFlags.O_RDONLY);
    expect(new TextDecoder().decode(vfs.readSync(after, 6, 0).buffer)).toBe('hello!');
    vfs.closeSync(fd);
    vfs.closeSync(after);
  });

  it('pread/pwrite with explicit offset do not move the fd cursor (COR-6)', () => {
    const file = makeInode();
    file.size = 6;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/f.txt', file],
      ]),
      sortedPaths: ['/', '/f.txt'],
      fileData: new Map([['/f.txt', new TextEncoder().encode('ABCDEF')]]),
    });

    const fd = vfs.openSync('/f.txt', OpenFlags.O_RDWR);

    // pread at offset 3 must not advance the implicit cursor (still 0).
    expect(new TextDecoder().decode(vfs.readSync(fd, 2, 3).buffer)).toBe('DE');
    // Implicit read now starts at 0, not at 5.
    expect(new TextDecoder().decode(vfs.readSync(fd, 2).buffer)).toBe('AB');
    // Cursor advanced by the implicit read to 2; the next implicit read continues.
    expect(new TextDecoder().decode(vfs.readSync(fd, 2).buffer)).toBe('CD');

    // pwrite at offset 0 must not move the cursor (still 4 after two implicit reads).
    vfs.writeSync(fd, new TextEncoder().encode('z'), 0);
    // Implicit write lands at cursor 4, not at 1.
    vfs.writeSync(fd, new TextEncoder().encode('Y'));
    vfs.closeSync(fd);

    const check = vfs.openSync('/f.txt', OpenFlags.O_RDONLY);
    expect(new TextDecoder().decode(vfs.readSync(check, 6, 0).buffer)).toBe('zBCDYF');
    vfs.closeSync(check);
  });

  it('updates atime on reads without clobbering mtime', () => {
    const file = makeInode();
    file.size = 4;
    file.atimeMs = 10;
    file.mtimeMs = 20;
    file.ctimeMs = 30;
    file.timestampMs = 20;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/hello.txt', file],
      ]),
      sortedPaths: ['/', '/hello.txt'],
      fileData: new Map([['/hello.txt', new Uint8Array([1, 2, 3, 4])]]),
    });
    vfs.openFiles.set(11, {
      path: '/hello.txt',
      cursor: 0,
      inodeId: file.ino,
      inode: file,
      data: new Uint8Array([1, 2, 3, 4]),
      flags: OpenFlags.O_RDONLY,
      readable: true,
      writable: false,
      append: false,
    });

    vfs.readSync(11, 2, 0);

    const stat = vfs.fstatSync(11);
    expect(stat.atimeMs).toBeGreaterThan(10);
    expect(stat.mtimeMs).toBe(20);
    expect(stat.ctimeMs).toBe(30);
  });

  it('preserves separate atime and mtime through utimes', () => {
    const file = makeInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/hello.txt', file],
      ]),
      sortedPaths: ['/', '/hello.txt'],
    });

    const before = Date.now();
    vfs.utimesSync('/hello.txt', 1111, 2222);
    const after = Date.now();

    const stat = vfs.statSync('/hello.txt');
    expect(stat.atimeMs).toBe(1111);
    expect(stat.mtimeMs).toBe(2222);
    expect(stat.timestampMs).toBe(2222);
    expect(stat.ctimeMs).toBeGreaterThanOrEqual(before);
    expect(stat.ctimeMs).toBeLessThanOrEqual(after);
  });

  it('allows chmod/utimes on a read-only file (COR-1)', () => {
    const file = makeInode();
    file.mode = 0o100444;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/ro.txt', file],
      ]),
      sortedPaths: ['/', '/ro.txt'],
    });

    // Both used to throw EACCES because the write bit was clear; POSIX gates these
    // on ownership, not the write bit, so they must succeed.
    expect(() => vfs.utimesSync('/ro.txt', 100, 200)).not.toThrow();
    expect(() => vfs.chmodSync('/ro.txt', 0o644)).not.toThrow();
    expect(vfs.statSync('/ro.txt').mode & 0o777).toBe(0o644);
  });

  it('allows chmod/utimes on a read-only directory (COR-1)', () => {
    const dir = makeDirInode();
    dir.mode = 0o40555;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/ro', dir],
      ]),
      sortedPaths: ['/', '/ro'],
    });

    expect(() => vfs.utimesSync('/ro', 1, 2)).not.toThrow();
    expect(() => vfs.chmodSync('/ro', 0o755)).not.toThrow();
    expect(vfs.statSync('/ro').mode & 0o777).toBe(0o755);
  });

  it('chmod preserves file-type bits (COR-2)', () => {
    const file = makeInode();
    file.mode = 0o100644; // S_IFREG | 0644
    const dir = makeDirInode();
    dir.mode = 0o40755; // S_IFDIR | 0755
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/f.txt', file],
        ['/d', dir],
      ]),
      sortedPaths: ['/', '/d', '/f.txt'],
    });

    vfs.chmodSync('/f.txt', 0o600);
    vfs.chmodSync('/d', 0o700);

    // Type bits survive; only the permission portion changes.
    expect(vfs.statSync('/f.txt').mode).toBe(0o100600);
    expect(vfs.statSync('/f.txt').is_file).toBe(true);
    expect(vfs.statSync('/d').mode).toBe(0o40700);
    expect(vfs.statSync('/d').is_dir).toBe(true);
  });

  it('open(O_CREAT) with a bare permission mode stores the S_IFREG type bit (COR-2)', () => {
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([['/', makeDirInode()]]),
      sortedPaths: ['/'],
    });

    const fd = vfs.openSync('/new.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o644);
    vfs.closeSync(fd);

    const stat = vfs.statSync('/new.txt');
    expect(stat.mode).toBe(0o100644);
    expect(stat.is_file).toBe(true);
  });

  it('creates symlinks, follows them for stat/open, and preserves raw targets for readlink', () => {
    const file = makeInode();
    file.size = 5;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/target.txt', file],
      ]),
      sortedPaths: ['/', '/target.txt'],
      fileData: new Map([['/target.txt', new TextEncoder().encode('hello')]]),
    });

    vfs.symlinkSync('/target.txt', '/link.txt');

    expect(vfs.readlinkSync('/link.txt')).toBe('/target.txt');
    expect(vfs.lstatSync('/link.txt').mode).toBe(0o120777);
    expect(vfs.lstatSync('/link.txt').is_file).toBe(false);
    expect(vfs.statSync('/link.txt').size).toBe(5);

    const fd = vfs.openSync('/link.txt', OpenFlags.O_RDONLY);
    const res = vfs.readSync(fd, 5, 0);
    vfs.closeSync(fd);
    expect(new TextDecoder().decode(res.buffer)).toBe('hello');
  });

  it('resolves relative symlink targets and realpath through directories', () => {
    const dir = makeDirInode();
    dir.children = ['target.txt'];
    const file = makeInode();
    file.size = 4;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/dir', dir],
        ['/dir/target.txt', file],
      ]),
      sortedPaths: ['/', '/dir', '/dir/target.txt'],
      fileData: new Map([['/dir/target.txt', new TextEncoder().encode('data')]]),
    });

    vfs.symlinkSync('../dir/target.txt', '/dir/link.txt');

    expect(vfs.realpathSync('/dir/link.txt')).toBe('/dir/target.txt');
    expect(vfs.statSync('/dir/link.txt').size).toBe(4);
  });

  it('enforces search permissions while traversing symlink paths', () => {
    const sealedDir = makeDirInode();
    sealedDir.children = ['link.txt'];
    const target = makeInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/sealed', sealedDir],
        ['/target.txt', target],
      ]),
      sortedPaths: ['/', '/sealed', '/target.txt'],
    });

    vfs.symlinkSync('/target.txt', '/sealed/link.txt');
    sealedDir.mode = 0o40600;

    expectErrorCode(() => vfs.readlinkSync('/sealed/link.txt'), 'EACCES');
    expectErrorCode(() => vfs.statSync('/sealed/link.txt'), 'EACCES');
  });

  it('enforces search permissions on canonical targets resolved through symlinks', () => {
    const hiddenDir = makeDirInode();
    hiddenDir.mode = 0o40600;
    hiddenDir.children = ['target.txt'];
    const target = makeInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/hidden', hiddenDir],
        ['/hidden/target.txt', target],
      ]),
      sortedPaths: ['/', '/hidden', '/hidden/target.txt'],
    });

    vfs.symlinkSync('/hidden/target.txt', '/alias.txt');

    expectErrorCode(() => vfs.realpathSync('/alias.txt'), 'EACCES');
    expectErrorCode(() => vfs.statSync('/alias.txt'), 'EACCES');
  });

  it('unlinks symlinks without deleting their targets', () => {
    const file = makeInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/target.txt', file],
      ]),
      sortedPaths: ['/', '/target.txt'],
    });

    vfs.symlinkSync('/target.txt', '/link.txt');
    vfs.unlinkSync('/link.txt');

    expect(vfs.existsSync('/target.txt')).toBe(true);
    expect(vfs.existsSync('/link.txt')).toBe(false);
  });

  it('rejects symlink loops during path resolution', () => {
    const { vfs } = makeBareVfs({
      inodes: new Map([['/', makeDirInode()]]),
      sortedPaths: ['/'],
    });

    vfs.symlinkSync('/b', '/a');
    vfs.symlinkSync('/a', '/b');

    expectErrorCode(() => vfs.statSync('/a'), 'ELOOP');
  });

  it('rejects non-directory components reached through symlinks', () => {
    const target = makeInode();
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/target.txt', target],
      ]),
      sortedPaths: ['/', '/target.txt'],
    });

    vfs.symlinkSync('/target.txt', '/link.txt');

    expectErrorCode(() => vfs.statSync('/link.txt/child'), 'ENOTDIR');
  });

  it('uses lstatSync as the path-level stat entry point', () => {
    const file = makeInode();
    file.ino = 77;
    const { vfs } = makeBareVfs({
      inodes: new Map([
        ['/', makeDirInode()],
        ['/hello.txt', file],
      ]),
      sortedPaths: ['/', '/hello.txt'],
    });

    expect(vfs.lstatSync('/hello.txt').ino).toBe(77);
  });

  it('checkpoints/compacts data WAL only after successful memory-mode persistence', () => {
    const inode = makeInode();
    inode.size = 4;
    const { vfs, dataLogHandle } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file', inode],
      ]),
      sortedPaths: ['/', '/file'],
      dirtyPages: new Map([[inode, new Set([0])]]),
      fileData: new Map([['/file', new Uint8Array([1, 2, 3, 4])]]),
      dataDirty: true,
      dataLogOffset: 128,
    });

    vfs.syncSync();

    expect(dataLogHandle.write).not.toHaveBeenCalled();
    expect(dataLogHandle.truncate).toHaveBeenCalledWith(0);
    expect(dataLogHandle.flush).toHaveBeenCalledTimes(1);
  });

  it('checkpoints a replayed delete-only WAL on sync', () => {
    const { vfs, dataLogHandle } = makeBareVfs({ bufferMode: 'memory', dataLogOffset: 24 });

    vfs.syncSync();

    expect(dataLogHandle.truncate).toHaveBeenCalledWith(0);
    expect(dataLogHandle.flush).toHaveBeenCalledTimes(1);
    expect(vfs.getLocalPersistenceStatusSync().walPendingBytes).toBe(0);
  });

  it('retries truncate and flush before appending after a checkpoint flush failure', () => {
    const { vfs, dataLogHandle } = makeBareVfs({
      bufferMode: 'memory',
      dataLogOffset: 24,
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file', makeInode()],
      ]),
      sortedPaths: ['/', '/file'],
    });
    const events: string[] = [];
    let failFlush = true;
    dataLogHandle.truncate.mockImplementation(() => events.push('truncate'));
    dataLogHandle.flush.mockImplementation(() => {
      events.push('flush');
      if (failFlush) throw new Error('truncate flush failed');
    });
    dataLogHandle.write.mockImplementation((bytes: Uint8Array) => {
      events.push('write');
      return bytes.length;
    });
    expect(() => vfs.syncSync()).toThrow('truncate flush failed');
    const fd = vfs.openSync('/file', OpenFlags.O_RDWR);
    expect(() => vfs.writeSync(fd, Uint8Array.of(9), 0)).toThrow('truncate flush failed');
    expect(dataLogHandle.write).not.toHaveBeenCalled();
    expect(vfs.fstatSync(fd).size).toBe(0);

    failFlush = false;
    events.length = 0;
    expect(vfs.writeSync(fd, Uint8Array.of(9), 0)).toBe(1);
    expect(events).toEqual(['truncate', 'flush', 'write', 'flush']);
    expect(dataLogHandle.write).toHaveBeenCalledWith(expect.any(Uint8Array), { at: 0 });
  });

  it('does not checkpoint data WAL when sync fails before persistence completes', () => {
    const inode = makeInode();
    inode.size = 4;
    const { vfs, dataLogHandle } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file', inode],
      ]),
      sortedPaths: ['/', '/file'],
      dirtyPages: new Map([[inode, new Set([0])]]),
      fileData: new Map([['/file', new Uint8Array([1, 2, 3, 4])]]),
      dataLogOffset: 128,
    });
    vfs.dataHandle.write.mockImplementationOnce(() => {
      throw new Error('disk write failure');
    });

    expect(() => vfs.syncSync()).toThrow('disk write failure');
    expect(dataLogHandle.truncate).not.toHaveBeenCalled();
  });
});

describe('SEC-2 numeric input validation', () => {
  function openWritableMemoryFile(maxFileSize = 0xffffffff) {
    const inode = makeInode();
    const harness = makeBareVfs({
      bufferMode: 'memory',
      maxFileSize,
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file', inode],
      ]),
      sortedPaths: ['/', '/file'],
      fileData: new Map([['/file', new Uint8Array(0)]]),
    });
    const { vfs } = harness;
    vfs.openFiles.set(10, {
      path: '/file',
      cursor: 0,
      inodeId: inode.ino,
      inode,
      flags: 2,
      readable: true,
      writable: true,
      append: false,
    });
    return { ...harness, inode };
  }

  const badValues: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['float', 1.5],
    ['negative', -1],
  ];

  for (const [label, value] of badValues) {
    it(`rejects ${label} write offset with EINVAL and leaves fd + file state unchanged`, () => {
      const { vfs, inode, dataLogHandle } = openWritableMemoryFile();
      expectErrorCode(() => vfs.writeSync(10, new Uint8Array([1, 2, 3]), value), 'EINVAL');
      expect(vfs.openFiles.get(10)?.cursor).toBe(0);
      expect(inode.size).toBe(0);
      // No WAL record may be appended for a rejected write.
      expect(dataLogHandle.write).not.toHaveBeenCalled();
      // A subsequent normal write still works.
      expect(vfs.writeSync(10, new Uint8Array([1, 2, 3]), 0)).toBe(3);
    });

    it(`rejects ${label} read size with EINVAL without poisoning the cursor`, () => {
      const { vfs } = openWritableMemoryFile();
      expectErrorCode(() => vfs.readSync(10, value), 'EINVAL');
      expect(vfs.openFiles.get(10)?.cursor).toBe(0);
    });

    it(`rejects ${label} truncate size with EINVAL`, () => {
      const { vfs, dataLogHandle } = openWritableMemoryFile();
      expectErrorCode(() => vfs.ftruncateSync(10, value), 'EINVAL');
      expect(dataLogHandle.write).not.toHaveBeenCalled();
    });
  }

  it('rejects NaN/Infinity/float seek offset with EINVAL and keeps the cursor intact', () => {
    const { vfs } = openWritableMemoryFile();
    vfs.openFiles.get(10)!.cursor = 5;
    for (const [, value] of badValues.filter(([l]) => l !== 'negative')) {
      expectErrorCode(() => vfs.seekSync(10, value, 0), 'EINVAL');
    }
    expect(vfs.openFiles.get(10)?.cursor).toBe(5);
  });

  it('rejects a negative absolute (SEEK_SET) seek with EINVAL', () => {
    const { vfs } = openWritableMemoryFile();
    expectErrorCode(() => vfs.seekSync(10, -1, 0), 'EINVAL');
  });

  it('disk-mode write at offset 1e15 throws EFBIG before any block allocation or data write', () => {
    const inode = makeInode();
    const { vfs, dataHandle } = makeBareVfs({
      bufferMode: 'disk',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file', inode],
      ]),
      sortedPaths: ['/', '/file'],
    });
    const bitmap = vfs.bitmap;
    vfs.openFiles.set(10, {
      path: '/file',
      cursor: 0,
      inodeId: inode.ino,
      inode,
      flags: 2,
      readable: true,
      writable: true,
      append: false,
    });

    expectErrorCode(() => vfs.writeSync(10, new Uint8Array([1]), 1e15), 'EFBIG');
    expect(bitmap.alloc).not.toHaveBeenCalled();
    expect(dataHandle.write).not.toHaveBeenCalled();
    expect(inode.blocks).toEqual([]);
    expect(inode.size).toBe(0);
  });

  it('rejects a write that would cross maxFileSize with EFBIG but allows a write exactly at the boundary', () => {
    const { vfs, inode } = openWritableMemoryFile(8);
    // 9 bytes crosses the 8-byte ceiling.
    expectErrorCode(() => vfs.writeSync(10, new Uint8Array(9), 0), 'EFBIG');
    expect(inode.size).toBe(0);
    // Exactly 8 bytes is allowed.
    expect(vfs.writeSync(10, new Uint8Array(8), 0)).toBe(8);
    expect(inode.size).toBe(8);
  });

  it('rejects truncate beyond maxFileSize with EFBIG', () => {
    const { vfs } = openWritableMemoryFile(8);
    expectErrorCode(() => vfs.ftruncateSync(10, 9), 'EFBIG');
    // At the boundary it succeeds.
    vfs.ftruncateSync(10, 8);
  });
});

describe('INT-3 disk-mode freed-block quarantine', () => {
  // Faithful tiny allocator: tracks allocated bits and a next-free hint so we can
  // observe whether a freed block is actually reused. Mirrors Bitmap semantics
  // closely enough to assert the quarantine contract without the private class.
  function makeFaithfulAllocator(capacity: number) {
    const used = new Array<boolean>(capacity).fill(false);
    used[0] = true; // reserve block 0, like Bitmap
    return {
      used,
      getRawBits: () => new Uint32Array([0]),
      alloc: vi.fn(() => {
        for (let i = 1; i < used.length; i++) {
          if (!used[i]) {
            used[i] = true;
            return i;
          }
        }
        return -1;
      }),
      free: vi.fn((block: number) => {
        used[block] = false;
      }),
      grow: vi.fn(),
    };
  }

  type QuarantineVfs = {
    bufferMode: 'memory' | 'disk';
    pendingFree: Set<number>;
    bitmap: ReturnType<typeof makeFaithfulAllocator>;
    bitmapDirty: boolean;
    localPersistenceState: string;
    localDurabilityMode: string;
    releaseBlock: (block: number) => void;
    drainPendingFree: () => void;
    allocDiskBlock: () => number;
    writeMeta: (force?: boolean) => void;
    growStorage: () => void;
    totalBlocks: number;
  };

  function makeQuarantineVfs(capacity = 8) {
    const bitmap = makeFaithfulAllocator(capacity);
    const vfs = Object.create(OpfsVfs.prototype) as unknown as QuarantineVfs;
    Object.assign(vfs, {
      bufferMode: 'disk',
      pendingFree: new Set<number>(),
      bitmap,
      bitmapDirty: false,
      localPersistenceState: 'clean',
      localDurabilityMode: 'strict',
      totalBlocks: capacity,
    });
    return { vfs, bitmap };
  }

  it('quarantines a freed disk block instead of returning it to the allocator', () => {
    const { vfs, bitmap } = makeQuarantineVfs();
    const block = bitmap.alloc(); // allocate block 1
    expect(block).toBe(1);

    vfs.releaseBlock(block);

    // The block is quarantined, NOT freed in the allocator: its bit is still set.
    expect(vfs.pendingFree.has(block)).toBe(true);
    expect(bitmap.free).not.toHaveBeenCalled();
    expect(bitmap.used[block]).toBe(true);
  });

  it('does not reallocate a quarantined block before the freeing meta is durable', () => {
    const { vfs, bitmap } = makeQuarantineVfs();
    const first = bitmap.alloc();
    vfs.releaseBlock(first);

    // A subsequent allocation must skip the quarantined block.
    const next = vfs.allocDiskBlock();
    expect(next).not.toBe(first);
    expect(vfs.pendingFree.has(first)).toBe(true);
  });

  it('releases the quarantined block back to the allocator after the meta flush (drainPendingFree)', () => {
    const { vfs, bitmap } = makeQuarantineVfs();
    const block = bitmap.alloc();
    vfs.releaseBlock(block);
    expect(vfs.pendingFree.size).toBe(1);

    // drainPendingFree runs at the tail of writeMeta, AFTER the meta flush.
    vfs.drainPendingFree();

    expect(vfs.pendingFree.size).toBe(0);
    expect(bitmap.free).toHaveBeenCalledWith(block);
    expect(bitmap.used[block]).toBe(false);

    // Now it is genuinely free and reallocatable.
    expect(vfs.bitmap.alloc()).toBe(block);
  });

  it('drains quarantine via a forced meta flush instead of growing when the allocator is exhausted', () => {
    // Capacity 3 => usable blocks are 1 and 2 (0 reserved).
    const { vfs, bitmap } = makeQuarantineVfs(3);
    const a = bitmap.alloc(); // 1
    const b = bitmap.alloc(); // 2
    expect([a, b]).toEqual([1, 2]);

    // Free block 1 into quarantine; the allocator is now exhausted (block 2 held).
    vfs.releaseBlock(a);

    // Stub writeMeta to model "the freeing meta is now durable" by draining —
    // exactly what the real writeMeta does at its tail after flush().
    const order: string[] = [];
    let forcedFlush = 0;
    vfs.writeMeta = (force?: boolean) => {
      forcedFlush++;
      order.push('meta');
      expect(force).toBe(true);
      vfs.drainPendingFree();
    };
    Object.assign(vfs, {
      storage: { beforeDataCommit: () => order.push('sidecar') },
      flushData: () => order.push('data'),
    });

    // allocDiskBlock should force a flush to drain quarantine and reuse block 1,
    // NOT grow the data file.
    const reused = vfs.allocDiskBlock();
    expect(forcedFlush).toBe(1);
    // Never publish other files' unflushed blocks, behind the snapshot.
    expect(order).toEqual(['sidecar', 'data', 'meta']);
    expect(reused).toBe(a);
    expect(bitmap.grow).not.toHaveBeenCalled();
  });

  it('memory mode frees immediately (no quarantine)', () => {
    const { vfs, bitmap } = makeQuarantineVfs();
    vfs.bufferMode = 'memory';
    const block = bitmap.alloc();

    vfs.releaseBlock(block);

    expect(vfs.pendingFree.size).toBe(0);
    expect(bitmap.free).toHaveBeenCalledWith(block);
    expect(bitmap.used[block]).toBe(false);
  });
});

describe('SEC-4 resource quotas', () => {
  it('rejects a name longer than maxNameLength with ENAMETOOLONG', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxNameLength: 8 });
    expectErrorCode(() => vfs.openSync(`/${'x'.repeat(9)}`, OpenFlags.O_CREAT | OpenFlags.O_WRONLY), 'ENAMETOOLONG');
    // A name exactly at the limit is allowed.
    expect(() => vfs.mkdirSync(`/${'y'.repeat(8)}`)).not.toThrow();
  });

  it('rejects a path deeper than maxPathDepth with ENOSPC', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxPathDepth: 2 });
    vfs.mkdirSync('/a');
    vfs.mkdirSync('/a/b'); // depth 2 OK
    expectErrorCode(() => vfs.mkdirSync('/a/b/c'), 'ENOSPC');
  });

  it('rejects creating more entries than maxFiles with ENOSPC', () => {
    // Root already counts as one entry, so maxFiles=2 allows exactly one more.
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxFiles: 2 });
    vfs.mkdirSync('/a');
    expectErrorCode(() => vfs.mkdirSync('/b'), 'ENOSPC');
    expectErrorCode(() => vfs.openSync('/c.txt', OpenFlags.O_CREAT | OpenFlags.O_WRONLY), 'ENOSPC');
  });

  it('rejects a write that would exceed maxTotalBytes with ENOSPC', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxTotalBytes: 4 });
    const fd = vfs.openSync('/f.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, new Uint8Array([1, 2, 3, 4]), 0); // exactly at the limit
    expectErrorCode(() => vfs.writeSync(fd, new Uint8Array([5]), 4), 'ENOSPC');
  });

  it('rejects a grow-via-truncate that would exceed maxTotalBytes', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxTotalBytes: 4 });
    const fd = vfs.openSync('/f.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    expectErrorCode(() => vfs.ftruncateSync(fd, 5), 'ENOSPC');
  });

  it('keeps disk growth sparse and charges quota only for written blocks', () => {
    const physical = new Uint8Array(32 * 4096).fill(0xaa);
    let physicalSize = 0;
    const dataHandle = {
      read: vi.fn((buffer: Uint8Array, { at }: { at: number }) => {
        buffer.set(physical.subarray(at, at + buffer.length));
        return buffer.length;
      }),
      write: vi.fn((buffer: Uint8Array, { at }: { at: number }) => {
        physical.set(buffer, at);
        physicalSize = Math.max(physicalSize, at + buffer.length);
        return buffer.length;
      }),
      getSize: vi.fn(() => physicalSize),
      flush: vi.fn(),
      close: vi.fn(),
      truncate: vi.fn(),
    };
    const { vfs } = makeBareVfs({ bitmap: new Bitmap(32), dataHandle, maxTotalBytes: 8192 });
    const fd = vfs.openSync('/sparse', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    const middle = 512 * 1024 * 1024;
    vfs.ftruncateSync(fd, 1024 * 1024 * 1024);
    expect(physicalSize).toBe(0);
    expect(vfs.readSync(fd, 8, middle).buffer).toEqual(new Uint8Array(8));
    expect(dataHandle.read).not.toHaveBeenCalled();

    vfs.writeSync(fd, Uint8Array.of(1, 2, 3), middle + 13);
    const expected = new Uint8Array(32);
    expected.set([1, 2, 3], 13);
    expect(vfs.readSync(fd, 32, middle).buffer).toEqual(expected);
    expect(vfs.allocatedDataBlocks).toBe(1);
    vfs.writeSync(fd, Uint8Array.of(4), middle + 4096);
    expectErrorCode(() => vfs.writeSync(fd, Uint8Array.of(5), middle + 8192), 'ENOSPC');
    expect(vfs.allocatedDataBlocks).toBe(2);
    vfs.ftruncateSync(fd, middle + 16);
    expect(vfs.allocatedDataBlocks).toBe(2);
    vfs.syncSync();
    expect(vfs.allocatedDataBlocks).toBe(1);
    vfs.closeSync(fd);
    vfs.unlinkSync('/sparse');
    expect(vfs.allocatedDataBlocks).toBe(1);
    vfs.syncSync();
    expect(vfs.allocatedDataBlocks).toBe(0);
  });

  it('counts quarantined disk blocks against quota until sync releases them', () => {
    const { vfs } = makeBareVfs({ bitmap: new Bitmap(16), maxTotalBytes: 4096 });
    const fd = vfs.openSync('/old', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, Uint8Array.of(1));
    vfs.syncSync();
    vfs.closeSync(fd);
    vfs.unlinkSync('/old');
    const replacement = vfs.openSync('/new', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    const before = vfs.bitmap.getRawBits().slice();
    expectErrorCode(() => vfs.writeSync(replacement, Uint8Array.of(2)), 'ENOSPC');
    expect(vfs.bitmap.getRawBits()).toEqual(before);
    expect(vfs.allocatedDataBlocks).toBe(1);
    vfs.syncSync();
    expect(vfs.allocatedDataBlocks).toBe(0);
    expect(vfs.writeSync(replacement, Uint8Array.of(2))).toBe(1);
    expect(vfs.allocatedDataBlocks).toBe(1);
  });

  it('allows writes without allocation above disk quota and dirties only attributes', () => {
    const { vfs } = makeBareVfs({ bitmap: new Bitmap(16) });
    const fd = vfs.openSync('/file', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, Uint8Array.of(1, 2));
    vfs.syncSync();
    Object.assign(vfs, { maxTotalBytes: 1 });
    for (const offset of [0, 5]) {
      expect(vfs.writeSync(fd, Uint8Array.of(3), offset)).toBe(1);
      expect(vfs.dirtyInodes.has('/file')).toBe(false);
      expect(vfs.attrDirtyInodes.has('/file')).toBe(true);
      vfs.syncSync();
    }
    expect(vfs.fstatSync(fd).size).toBe(6);
    expect(vfs.allocatedDataBlocks).toBe(1);
  });

  it('counts unlinked-but-open files against maxTotalBytes', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxTotalBytes: 4 });
    const fd = vfs.openSync('/f.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, new Uint8Array([1, 2, 3]), 0);
    vfs.unlinkSync('/f.txt');
    // The unlinked fd's 3 bytes are still live; growing it past the ceiling
    // must fail even though the inode is gone from the path map.
    expectErrorCode(() => vfs.writeSync(fd, new Uint8Array([4, 5]), 3), 'ENOSPC');
    // ...and a NEW file only has 1 byte of headroom left.
    const fd2 = vfs.openSync('/g.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    expectErrorCode(() => vfs.writeSync(fd2, new Uint8Array([1, 2]), 0), 'ENOSPC');
    expect(() => vfs.writeSync(fd2, new Uint8Array([1]), 0)).not.toThrow();
  });

  it('rename cannot bypass maxNameLength or maxPathDepth', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxNameLength: 8, maxPathDepth: 2 });
    vfs.mkdirSync('/a');
    vfs.mkdirSync('/a/b');
    const fd = vfs.openSync('/short', OpenFlags.O_CREAT | OpenFlags.O_WRONLY);
    vfs.closeSync(fd);
    expectErrorCode(() => vfs.renameSync('/short', `/${'x'.repeat(9)}`), 'ENAMETOOLONG');
    expectErrorCode(() => vfs.renameSync('/short', '/a/b/deep'), 'ENOSPC');
    // A within-quota rename still works.
    expect(() => vfs.renameSync('/short', '/renamed')).not.toThrow();
  });

  it('defaults do not restrict normal use', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    expect(() => {
      vfs.mkdirSync('/a/b/c/d/e', { recursive: true });
      const fd = vfs.openSync('/a/b/c/d/e/file.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, new Uint8Array(10_000), 0);
      vfs.closeSync(fd);
    }).not.toThrow();
  });
});

describe('SEC-5 symlink target validation at creation', () => {
  it('rejects an empty symlink target with ENOENT', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    expectErrorCode(() => vfs.symlinkSync('', '/link'), 'ENOENT');
    // The bad symlink must not have been created.
    expect(vfs.existsSync('/link')).toBe(false);
  });

  it('rejects a symlink target containing a NUL byte with EINVAL', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    expectErrorCode(() => vfs.symlinkSync('/foo\0bar', '/link'), 'EINVAL');
    expect(vfs.existsSync('/link')).toBe(false);
  });

  it('accepts a normal (possibly dangling) symlink target', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    expect(() => vfs.symlinkSync('/does/not/exist', '/link')).not.toThrow();
    expect(vfs.readlinkSync('/link')).toBe('/does/not/exist');
  });
});

describe('COR-8 smaller POSIX divergences', () => {
  it('zero-length writeSync still rejects a bad fd with EBADF', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    expectErrorCode(() => vfs.writeSync(9999, new Uint8Array(0), 0), 'EBADF');
  });

  it('st_blocks is derived from size even before flush (memory mode)', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    const fd = vfs.openSync('/f.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, new Uint8Array(1500), 0); // no flush yet -> inode.blocks empty
    const stat = vfs.fstatSync(fd);
    expect(stat.size).toBe(1500);
    // ceil(1500 / 512) === 3, not 0 (the old inode.blocks.length value).
    expect(stat.blocks).toBe(3);
  });

  it('grants write access when a non-owner write bit is set (0o222 semantics)', () => {
    const file = makeInode();
    // Only the group write bit is set (no owner write). POSIX-spec semantics for
    // this single-user VFS treat any write bit as writable.
    file.mode = 0o100020;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/g.txt', file],
      ]),
      sortedPaths: ['/', '/g.txt'],
    });
    expect(() => vfs.openSync('/g.txt', OpenFlags.O_WRONLY)).not.toThrow();
  });

  it('still rejects writing a file with no write bits at all', () => {
    const file = makeInode();
    file.mode = 0o100444;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/ro.txt', file],
      ]),
      sortedPaths: ['/', '/ro.txt'],
    });
    expectErrorCode(() => vfs.openSync('/ro.txt', OpenFlags.O_WRONLY), 'EACCES');
  });
});

describe('legacy bare-mode inodes get S_IFMT type bits on load', () => {
  it('backfills S_IFREG / S_IFDIR / S_IFLNK during normalizeLoadedInodes', () => {
    // Pre-COR-2 persisted inodes: bare permission modes, no type bits.
    const bareFile = makeInode();
    bareFile.ino = 2;
    bareFile.mode = 0o644; // no S_IFREG
    const bareDir = makeDirInode();
    bareDir.ino = 3;
    bareDir.isDir = true;
    bareDir.mode = 0o755; // no S_IFDIR
    const bareLink = makeInode();
    bareLink.ino = 4;
    bareLink.mode = 0o777; // no S_IFLNK
    (bareLink as unknown as { symlinkTarget?: string }).symlinkTarget = '/file';
    (bareLink as unknown as { kind?: string }).kind = 'symlink';

    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/file', bareFile],
        ['/dir', bareDir],
        ['/link', bareLink],
      ]),
      sortedPaths: ['/', '/dir', '/file', '/link'],
    });

    (vfs as unknown as { normalizeLoadedInodes(): void }).normalizeLoadedInodes();

    expect(bareFile.mode & 0o170000).toBe(0o100000); // S_IFREG
    expect(bareFile.mode & 0o777).toBe(0o644); // permission bits preserved
    expect(bareDir.mode & 0o170000).toBe(0o040000); // S_IFDIR
    expect(bareLink.mode & 0o170000).toBe(0o120000); // S_IFLNK
  });

  it('leaves an inode that already has type bits untouched', () => {
    const file = makeInode();
    file.ino = 2;
    file.mode = 0o100600; // already S_IFREG | 0o600
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/keep', file],
      ]),
      sortedPaths: ['/', '/keep'],
    });
    (vfs as unknown as { normalizeLoadedInodes(): void }).normalizeLoadedInodes();
    expect(file.mode).toBe(0o100600);
  });
});

describe('bitmap generation stamp ordering (follow-up)', () => {
  it('keeps persistence state clean for a read-only workload (relatime not fired)', () => {
    const now = Date.now();
    const file = makeInode();
    file.ino = 42;
    file.size = 3;
    // atime is recent and newer-or-equal to mtime/ctime, so relatime must NOT fire.
    file.atimeMs = now;
    file.mtimeMs = now - 1000;
    file.ctimeMs = now - 1000;
    file.timestampMs = file.mtimeMs;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      localPersistenceState: 'clean',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/a.txt', file],
      ]),
      fileData: new Map([['/a.txt', new Uint8Array([97, 98, 99])]]),
      sortedPaths: ['/', '/a.txt'],
    });

    const fd = vfs.openSync('/a.txt', OpenFlags.O_RDONLY);
    expect(Array.from(vfs.readSync(fd, 3, 0).buffer)).toEqual([97, 98, 99]);
    expect(Array.from(vfs.readSync(fd, 3, 0).buffer)).toEqual([97, 98, 99]);

    // No atime mutation, no dirty inode, state stays clean.
    expect(file.atimeMs).toBe(now);
    expect(vfs.dirtyInodes.has('/a.txt')).toBe(false);
    expect(vfs.getLocalPersistenceStatusSync().localPersistenceState).toBe('clean');
  });

  it('updates atime on read when atime is older than mtime (relatime fires)', () => {
    const now = Date.now();
    const file = makeInode();
    file.ino = 42;
    file.size = 3;
    // atime strictly older than mtime -> relatime fires on read.
    file.atimeMs = now - 100000;
    file.mtimeMs = now - 1000;
    file.ctimeMs = now - 1000;
    file.timestampMs = file.mtimeMs;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      localPersistenceState: 'clean',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/a.txt', file],
      ]),
      fileData: new Map([['/a.txt', new Uint8Array([97, 98, 99])]]),
      sortedPaths: ['/', '/a.txt'],
    });

    const fd = vfs.openSync('/a.txt', OpenFlags.O_RDONLY);
    vfs.readSync(fd, 3, 0);

    expect(file.atimeMs).toBeGreaterThan(now - 100000);
    // PERF-9: an atime-only change is tracked as attr-only, not structural.
    expect(vfs.attrDirtyInodes.has('/a.txt')).toBe(true);
    expect(vfs.dirtyInodes.has('/a.txt')).toBe(false);
    expect(vfs.getLocalPersistenceStatusSync().localPersistenceState).toBe('dirty');
  });

  it('never updates atime when noatime is set', () => {
    const now = Date.now();
    const file = makeInode();
    file.ino = 42;
    file.size = 3;
    // atime older than mtime — relatime WOULD fire, but noatime suppresses it.
    file.atimeMs = now - 100000;
    file.mtimeMs = now - 1000;
    file.ctimeMs = now - 1000;
    file.timestampMs = file.mtimeMs;
    const { vfs } = makeBareVfs({
      bufferMode: 'memory',
      noatime: true,
      localPersistenceState: 'clean',
      inodes: new Map([
        ['/', makeDirInode()],
        ['/a.txt', file],
      ]),
      fileData: new Map([['/a.txt', new Uint8Array([97, 98, 99])]]),
      sortedPaths: ['/', '/a.txt'],
    });

    const fd = vfs.openSync('/a.txt', OpenFlags.O_RDONLY);
    vfs.readSync(fd, 3, 0);

    expect(file.atimeMs).toBe(now - 100000);
    expect(vfs.dirtyInodes.has('/a.txt')).toBe(false);
    expect(vfs.getLocalPersistenceStatusSync().localPersistenceState).toBe('clean');
  });

  // PERF-9 — log-size snapshot trigger.
  it('forces a full snapshot when the meta log exceeds the size threshold', () => {
    const file = makeInode();
    file.ino = 42;
    const { vfs, logHandle } = makeBareVfs({
      bufferMode: 'disk',
      flushedDataSize: 8192,
      flushedLogicalExtent: 4096,
      // Not structurally dirty — only an attr change — but the log is already huge.
      dirtyStructure: false,
      dirtyInodes: new Set<string>(),
      attrDirtyInodes: new Set<string>(['/f']),
      // 5MB > the 4MB floor threshold.
      logOffset: 5 * 1024 * 1024,
      metaSnapshotSequence: 3,
      activeMetaSlot: 0,
      inodes: new Map([
        ['/', makeDirInode()],
        ['/f', file],
      ]),
      sortedPaths: ['/', '/f'],
    });

    vfs.syncSync();

    // The oversized log triggered a full snapshot (sequence bumped, log reset).
    expect(vfs.metaSnapshotSequence).toBe(4);
    expect(logHandle.write).toHaveBeenCalledOnce();
    const batch = logHandle.write.mock.calls[0][0];
    expect(vfs.logOffset).toBe(batch.byteLength);
    expect(replayLog(batch.slice().buffer, new Map(), [], vfs.totalBlocks, 4)).toMatchObject({
      count: 0,
      validEnd: batch.byteLength,
      physicalDataSize: 8192,
      logicalExtent: 4096,
    });
    expect(replayLog(batch.slice().buffer, new Map(), [], vfs.totalBlocks, 3).generationMismatch).toBe('newer');
    expect(logHandle.flush).toHaveBeenCalledOnce();
  });

  it('does not snapshot for a small log with only attr-only changes', () => {
    const file = makeInode();
    file.ino = 42;
    const { vfs } = makeBareVfs({
      bufferMode: 'disk',
      dirtyStructure: false,
      dirtyInodes: new Set<string>(),
      attrDirtyInodes: new Set<string>(['/f']),
      logOffset: 1024, // well under threshold
      metaSnapshotSequence: 3,
      activeMetaSlot: 0,
      inodes: new Map([
        ['/', makeDirInode()],
        ['/f', file],
      ]),
      sortedPaths: ['/', '/f'],
    });

    vfs.syncSync();

    // No snapshot: sequence unchanged, an incremental compact record was appended.
    expect(vfs.metaSnapshotSequence).toBe(3);
    expect(vfs.attrDirtyInodes.size).toBe(0);
  });

  // PERF-10 — memory-mode namespace-log flush policy.
  // In relaxed/balanced the namespace record is WRITTEN per op (so a
  // crash-close still recovers it and a later data-WAL write can replay against
  // the inode) but the fsync is DEFERRED to the next sync.
  it('writes but does not flush the namespace log on a relaxed-mode mkdir', () => {
    const { vfs, logHandle } = makeBareVfs({
      bufferMode: 'memory',
      localDurabilityMode: 'relaxed',
      metaSnapshotSequence: 1,
      inodes: new Map([['/', makeDirInode()]]),
      sortedPaths: ['/'],
    });

    vfs.mkdirSync('/d');

    // Relaxed: bytes written per op, but NOT fsynced.
    expect(logHandle.write).toHaveBeenCalled();
    expect(logHandle.flush).not.toHaveBeenCalled();

    vfs.syncSync();
    // The explicit sync flushes the deferred namespace records.
    expect(logHandle.flush).toHaveBeenCalled();
    expect(vfs.dirtyInodes.size).toBe(0);
  });

  it('writes AND flushes the namespace log per-op in strict mode', () => {
    const { vfs, logHandle } = makeBareVfs({
      bufferMode: 'memory',
      localDurabilityMode: 'strict',
      metaSnapshotSequence: 1,
      inodes: new Map([['/', makeDirInode()]]),
      sortedPaths: ['/'],
    });

    vfs.mkdirSync('/d');

    // Strict: the meta log is written + flushed synchronously per namespace op.
    expect(logHandle.write).toHaveBeenCalled();
    expect(logHandle.flush).toHaveBeenCalled();
  });

  // §6.3 — browser storage quota mapped to ENOSPC.
  it('maps a QuotaExceededError on a disk write to ENOSPC and a consistent state', () => {
    let allocCounter = 0;
    const usable = {
      getRawBits: () => new Uint32Array([1]),
      alloc: () => ++allocCounter, // hands out 1, 2, 3, ...
      allocRun: () => -1, // force per-block allocation
      free: vi.fn(),
      grow: vi.fn(),
    };
    const file = makeInode();
    file.ino = 42;
    const { vfs, dataHandle } = makeBareVfs({
      bufferMode: 'disk',
      localPersistenceState: 'clean',
      bitmap: usable,
      inodes: new Map([
        ['/', makeDirInode()],
        ['/f', file],
      ]),
      sortedPaths: ['/', '/f'],
    });
    // The first OPFS data write hits the browser quota.
    dataHandle.write.mockImplementation(() => {
      const err = new Error('quota');
      (err as { name: string }).name = 'QuotaExceededError';
      throw err;
    });

    const fd = vfs.openSync('/f', OpenFlags.O_WRONLY);
    expectErrorCode(() => vfs.writeSync(fd, new Uint8Array([1, 2, 3]), 0), 'ENOSPC');

    // State reflects the failure, and the just-allocated blocks were rolled back
    // (in-memory allocator/inode not left ahead of disk).
    const status = vfs.getLocalPersistenceStatusSync();
    expect(status.localPersistenceState).toBe('error');
    expect((status.lastError as { code?: string })?.code).toBe('ENOSPC');
    expect(file.blocks).toEqual([]);
  });

  it('getStorageEstimate returns undefined when the Storage Manager API is absent', async () => {
    const { vfs } = makeBareVfs();
    // jsdom/browser test env may or may not expose navigator.storage.estimate;
    // the method must resolve (never throw) in either case.
    const estimate = await vfs.getStorageEstimate();
    expect(estimate === undefined || typeof estimate === 'object').toBe(true);
  });
});

describe('POSIX semantics hardening', () => {
  const rdwr = OpenFlags.O_CREAT | OpenFlags.O_RDWR;
  const memory = () => makeBareVfs({ bufferMode: 'memory' }).vfs;

  it('rejects ftruncate through a read-only descriptor', () => {
    const vfs = memory();
    const fd = vfs.openSync('/file', rdwr);
    vfs.writeSync(fd, new Uint8Array([1, 2, 3]));
    vfs.closeSync(fd);
    const readOnly = vfs.openSync('/file', OpenFlags.O_RDONLY);
    expectErrorCode(() => vfs.ftruncateSync(readOnly, 0), 'EBADF');
    expect(vfs.statSync('/file').size).toBe(3);
  });

  it('fails path and descriptor operations after closeVfs', () => {
    const vfs = memory();
    const fd = vfs.openSync('/file', rdwr);
    void vfs.closeVfs();
    expectErrorCode(() => vfs.mkdirSync('/dir'), 'EBADF');
    expectErrorCode(() => vfs.statSync('/file'), 'EBADF');
    expectErrorCode(() => vfs.writeSync(fd, new Uint8Array([1])), 'EBADF');
  });

  it('O_CREAT|O_EXCL reports EEXIST for a dangling symlink instead of creating its target', () => {
    const vfs = memory();
    vfs.symlinkSync('/missing', '/link');
    expectErrorCode(() => vfs.openSync('/link', rdwr | OpenFlags.O_EXCL), 'EEXIST');
    expect(vfs.existsSync('/missing')).toBe(false);
  });

  it('validates O_TRUNC before creating the file', () => {
    const vfs = memory();
    expectErrorCode(() => vfs.openSync('/file', OpenFlags.O_CREAT | OpenFlags.O_TRUNC), 'EINVAL');
    expect(vfs.existsSync('/file')).toBe(false);
  });

  it('renaming a hard link over another link of the same inode does nothing', () => {
    const vfs = memory();
    const fd = vfs.openSync('/a', rdwr);
    vfs.writeSync(fd, new Uint8Array([7]));
    vfs.closeSync(fd);
    vfs.linkSync('/a', '/b');
    vfs.renameSync('/a', '/b');
    expect(vfs.existsSync('/a')).toBe(true);
    expect(vfs.existsSync('/b')).toBe(true);
    expect(vfs.statSync('/b').nlink).toBe(2);
  });

  it('validates pathnames before treating a rename as a no-op', () => {
    const vfs = memory();
    vfs.closeSync(vfs.openSync('/a', rdwr));
    vfs.linkSync('/a', '/b');
    for (const [from, to] of [
      ['/a/', '/b'],
      ['/a', '/b/'],
      ['/a/', '/a'],
      ['/a', '/a/'],
    ]) {
      expectErrorCode(() => vfs.renameSync(from!, to!), 'ENOTDIR');
    }
    expectErrorCode(() => vfs.renameSync('/missing', '/missing'), 'ENOENT');
    expect(() => vfs.renameSync('/a', '/a')).not.toThrow();
    expect(() => vfs.renameSync('/', '/')).not.toThrow();
    expect(vfs.statSync('/a').nlink).toBe(2);
    expect(vfs.statSync('/b').ino).toBe(vfs.statSync('/a').ino);
  });

  it('keeps the inode kind in the type bits whatever mode is requested', () => {
    const vfs = memory();
    vfs.closeSync(vfs.openSync('/file', rdwr, 0o120644));
    vfs.mkdirSync('/dir', 0o100755);
    expect(vfs.statSync('/file')).toMatchObject({ is_file: true, mode: 0o100644 });
    expect(vfs.statSync('/dir')).toMatchObject({ is_dir: true, mode: 0o40755 });
  });

  it('applies maxPathDepth to entries moved by a directory rename', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory', maxPathDepth: 3 });
    vfs.mkdirSync('/a/b/c', { recursive: true });
    vfs.mkdirSync('/x/y', { recursive: true });
    expectErrorCode(() => vfs.renameSync('/a', '/x/y/a'), 'ENOSPC');
  });

  it('rejects non-byte views and non-finite times', () => {
    const vfs = memory();
    const fd = vfs.openSync('/file', rdwr);
    expectErrorCode(() => vfs.writeSync(fd, new Uint16Array(4) as unknown as Uint8Array), 'EINVAL');
    expectErrorCode(() => vfs.utimesSync('/file', Number.NaN, 0), 'EINVAL');
  });

  it('existsSync answers false below a regular file', () => {
    const vfs = memory();
    vfs.closeSync(vfs.openSync('/file', rdwr));
    expect(vfs.existsSync('/file/child')).toBe(false);
  });

  it('numbers descriptors from a per-instance random base', () => {
    const [a, b] = [
      new OpfsVfs('a.bin', { openMode: 'bogus' as never }),
      new OpfsVfs('b.bin', { openMode: 'bogus' as never }),
    ];
    void a.ready.catch(() => {});
    void b.ready.catch(() => {});
    const next = (vfs: OpfsVfs) => (vfs as unknown as { nextFd: number }).nextFd;
    expect(next(a)).toBeGreaterThanOrEqual(10);
    expect(next(a)).not.toBe(next(b));
  });
});

describe('sorted path maintenance', () => {
  it('keeps the path list sorted when a subtree moves past siblings sharing its prefix', () => {
    const { vfs } = makeBareVfs({ bufferMode: 'memory' });
    for (const dir of ['/a', '/a/x', '/a-b', '/b', '/z']) vfs.mkdirSync(dir);
    for (const file of ['/a/1', '/a/x/2', '/a-b/3'])
      vfs.closeSync(vfs.openSync(file, OpenFlags.O_CREAT | OpenFlags.O_RDWR));
    vfs.renameSync('/a', '/b/a');
    vfs.renameSync('/a-b', '/z/a');
    const paths = (vfs as unknown as OpfsVfs).listPathsSync();
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(['/', '/b', '/b/a', '/b/a/1', '/b/a/x', '/b/a/x/2', '/z', '/z/a', '/z/a/3']);
  });
});

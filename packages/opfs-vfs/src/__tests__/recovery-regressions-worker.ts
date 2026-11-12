import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs.js';
import { testPlugin } from './test-plugin.js';

export type Expected = {
  files: [string, Uint8Array][];
  dirs: string[];
  /** Error code of the injected failed sync, asserted after recovery. */
  failure?: string;
  /** Data file size at the last successful flush. */
  flushedSize?: number;
};
type Request = {
  action:
    | 'prepare'
    | 'verify'
    | 'append-zeros'
    | 'truncate-data'
    | 'truncate-alloc'
    | 'double-claim'
    | 'zero-protected-wal'
    | 'detached-forge'
    | 'detached-verify'
    | 'rollback-report'
    | 'deferred-namespace'
    | 'tear-final-frame'
    | 'unwritten-namespace'
    | 'unwritten-verify'
    | 'non-storage-namespace'
    | 'damaged-wal-length'
    | 'damaged-wal-verify';
  name: string;
  scenario?:
    | 'shrink-hole'
    | 'shrink-hole-snapshot'
    | 'extend'
    | 'reused-block'
    | 'synced-growth'
    | 'failed-persist'
    | 'failed-hole-fill'
    | 'failed-multi-file'
    | 'failed-flush'
    | 'prior-session'
    | 'legacy-tail-forge'
    | 'legacy-tail'
    | 'wal-only'
    | 'wal-two-files'
    | 'wal-three-files';
  mode?: 'memory' | 'disk';
  recoveryMode?: OpfsVfsOptions['recoveryMode'];
  expected?: Expected;
  bytes?: number;
  round?: number;
  blocker?: Blocker;
  durability?: OpfsVfsOptions['localDurabilityMode'];
  variant?: 'sync-fails' | 'sync-succeeds';
};

const BLOCK = 4096;
const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function put(vfs: OpfsVfs, path: string, data: Uint8Array, offset = 0) {
  const fd = vfs.openSync(path, create);
  try {
    check(vfs.writeSync(fd, data, offset) === data.length, `${path}: write count`);
  } finally {
    vfs.closeSync(fd);
  }
}

function read(vfs: OpfsVfs, path: string) {
  const fd = vfs.openSync(path);
  try {
    return vfs.readSync(fd, vfs.fstatSync(fd).size + 1, 0).buffer;
  } finally {
    vfs.closeSync(fd);
  }
}

function checkFile(vfs: OpfsVfs, path: string, expected: Uint8Array) {
  const actual = read(vfs, path);
  check(actual.length === expected.length, `${path}: size ${actual.length} != ${expected.length}`);
  const mismatch = actual.findIndex((byte, i) => byte !== expected[i]);
  check(mismatch === -1, `${path}: byte ${mismatch} is ${actual[mismatch]}, expected ${expected[mismatch]}`);
}

function bytes(length: number, fill: number, patches: [number, number[]][] = []) {
  const out = new Uint8Array(length).fill(fill);
  for (const [at, values] of patches) out.set(values, at);
  return out;
}

async function mount(name: string, options: OpfsVfsOptions) {
  const vfs = new OpfsVfs(name, { localDurabilityMode: 'relaxed', ...options });
  await vfs.ready;
  return vfs;
}

type Fault = { failWrite: number; failFlush: boolean; fired: number; dataSize(): number };

/**
 * Mount in memory mode with an injectable failure on the volume data file:
 * a quota error on its nth write (`failWrite`), or an error on its next flush.
 */
async function mountWithDataFault(name: string, options: OpfsVfsOptions = {}) {
  let dataHandle: FileSystemSyncAccessHandle | undefined;
  const fault: Fault = { failWrite: 0, failFlush: false, fired: 0, dataSize: () => dataHandle!.getSize() };
  const vfs = await mount(name, {
    bufferMode: 'memory',
    ...options,
    _wrapSyncAccessHandle: (handle, tag) => {
      if (tag !== 'data') return handle;
      dataHandle ??= handle;
      return new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'write' || key === 'flush') {
            return (...args: unknown[]) => {
              if (target === dataHandle && key === 'write' && fault.failWrite > 0 && --fault.failWrite === 0) {
                fault.fired++;
                throw new DOMException('injected quota failure', 'QuotaExceededError');
              }
              if (target === dataHandle && key === 'flush' && fault.failFlush) {
                fault.failFlush = false;
                fault.fired++;
                throw new DOMException('injected flush failure', 'InvalidStateError');
              }
              return (value as (...args: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  return { vfs, fault };
}

/** Returns the error code (or name) the failed sync reported; tests assert it after the recovery checks. */
function failingSync(vfs: OpfsVfs, fault: Fault, failure: { write: number } | 'flush') {
  if (failure === 'flush') fault.failFlush = true;
  else fault.failWrite = failure.write;
  let error: unknown;
  try {
    vfs.syncSync();
  } catch (caught) {
    error = caught;
  }
  check(fault.fired === 1 && error !== undefined, 'the injected data failure must fire and reach the caller');
  const details = error as { code?: unknown; name?: unknown };
  return String(typeof details.code === 'string' ? details.code : details.name);
}

/** A disk-mode session leaves `/sparse` as three unallocated pages. */
async function sparseFile(name: string) {
  const disk = await mount(name, { bufferMode: 'disk' });
  const fd = disk.openSync('/sparse', create);
  disk.ftruncateSync(fd, 3 * BLOCK);
  disk.closeSync(fd);
  await disk.closeVfs();
}

/** Stand-in for a record codec with data-WAL cycle stamps (a protected volume). */
function protectedPlugin() {
  const stamp = new Uint8Array([0x44, 0x57, 0x43, 0x31]);
  const codec = {
    overheadBytes: 0,
    seal: (plain: Uint8Array) => plain,
    sealInto: (plain: Uint8Array, _role: number, _identity: number, out: Uint8Array, outOffset: number) => {
      out.set(plain, outOffset);
      return plain.length;
    },
    open: (sealed: Uint8Array) => sealed,
  };
  return testPlugin(async ({ data }) => ({
    data,
    recordCodec: codec,
    createDataWalCycle: () => ({ prefix: stamp, codec }),
    openDataWalCycle: (bytes) =>
      bytes.length >= stamp.length && stamp.every((byte, i) => bytes[i] === byte)
        ? { prefixBytes: stamp.length, codec }
        : null,
    destroy() {},
  }));
}

/** Leaves the volume open: the test terminates this worker to model a killed tab. */
async function prepare(name: string, scenario: NonNullable<Request['scenario']>): Promise<Expected> {
  if (scenario === 'failed-persist') {
    const { vfs, fault } = await mountWithDataFault(name);
    put(vfs, '/f', bytes(3 * BLOCK, 7));
    const failure = failingSync(vfs, fault, { write: 1 });
    vfs.mkdirSync('/later');
    return { files: [['/f', bytes(3 * BLOCK, 7)]], dirs: ['/later'], failure };
  }
  if (scenario === 'failed-hole-fill') {
    await sparseFile(name);
    const { vfs, fault } = await mountWithDataFault(name);
    put(vfs, '/sparse', new Uint8Array([5, 5, 5]), BLOCK + 10);
    const failure = failingSync(vfs, fault, { write: 1 });
    vfs.mkdirSync('/later');
    return { files: [['/sparse', bytes(3 * BLOCK, 0, [[BLOCK + 10, [5, 5, 5]]])]], dirs: ['/later'], failure };
  }
  if (scenario === 'failed-multi-file' || scenario === 'failed-flush') {
    await sparseFile(name);
    const { vfs, fault } = await mountWithDataFault(name, { localDurabilityMode: 'strict' });
    put(vfs, '/a', bytes(2 * BLOCK, 1));
    vfs.syncSync();
    const flushedSize = fault.dataSize();
    // Persist order: /sparse fills a hole, /c takes new blocks, then (multi-file) /d's write fails.
    put(vfs, '/sparse', new Uint8Array([5, 5, 5]), BLOCK + 10);
    put(vfs, '/c', bytes(3 * BLOCK, 3));
    put(vfs, '/d', bytes(2 * BLOCK, 4));
    const failure = failingSync(vfs, fault, scenario === 'failed-flush' ? 'flush' : { write: 3 });
    check(fault.dataSize() > flushedSize, 'fixture must leave unflushed data-file growth');
    // Strict mode logs and flushes this record at once.
    vfs.mkdirSync('/later');
    return {
      files: [
        ['/a', bytes(2 * BLOCK, 1)],
        ['/sparse', bytes(3 * BLOCK, 0, [[BLOCK + 10, [5, 5, 5]]])],
        ['/c', bytes(3 * BLOCK, 3)],
        ['/d', bytes(2 * BLOCK, 4)],
      ],
      dirs: ['/later'],
      failure,
      flushedSize,
    };
  }
  if (scenario === 'prior-session') {
    const first = await mount(name, { bufferMode: 'memory' });
    put(first, '/f', bytes(100, 1));
    put(first, '/h', bytes(2 * BLOCK, 7));
    await first.closeVfs();
    // Sizes loaded at mount are the persisted sizes of this session.
    const second = await mount(name, { bufferMode: 'memory' });
    put(second, '/f', bytes(100, 2), 100);
    second.truncateSync('/h', 10);
    second.mkdirSync('/any');
    return {
      files: [
        ['/f', bytes(200, 1, [[100, Array<number>(100).fill(2)]])],
        ['/h', bytes(10, 7)],
      ],
      dirs: ['/any'],
    };
  }
  if (scenario === 'legacy-tail-forge') {
    // An earlier release could log a size past the file's blocks and then lose the WAL.
    const forged = await mount(name, { bufferMode: 'memory' });
    put(forged, '/f', bytes(BLOCK, 1));
    forged.syncSync();
    const internals = forged as unknown as { inodes: Map<string, { size: number }>; dirtyInodes: Set<string> };
    internals.inodes.get('/f')!.size = 10_000;
    internals.dirtyInodes.add('/f');
    await forged.closeVfs();
    return { files: [], dirs: [] };
  }
  if (scenario === 'legacy-tail') {
    const legacy = await mount(name, { bufferMode: 'memory' });
    const mounted = bytes(10_000, 0, [[0, Array<number>(BLOCK).fill(1)]]);
    checkFile(legacy, '/f', mounted);
    put(legacy, '/f', new Uint8Array([5]), 9000);
    legacy.mkdirSync('/any');
    mounted[9000] = 5;
    return { files: [['/f', mounted]], dirs: ['/any'] };
  }

  const vfs = await mount(name, { bufferMode: 'memory' });
  if (scenario === 'wal-only') {
    put(vfs, '/a', new Uint8Array([111, 107]));
    return { files: [['/a', new Uint8Array([111, 107])]], dirs: [] };
  }
  if (scenario === 'wal-two-files') {
    // Two frames; the test then breaks the checksum of the second.
    put(vfs, '/a', new Uint8Array([111, 107]));
    put(vfs, '/b', new Uint8Array([1, 2, 3]));
    return {
      files: [
        ['/a', new Uint8Array([111, 107])],
        ['/b', new Uint8Array(0)],
      ],
      dirs: [],
    };
  }
  if (scenario === 'wal-three-files') {
    for (const [i, path] of ['/a', '/b', '/c'].entries()) put(vfs, path, bytes(3, i + 1));
    return { files: [], dirs: [] };
  }
  if (scenario === 'synced-growth') {
    put(vfs, '/f', bytes(100, 1));
    vfs.syncSync();
    put(vfs, '/f', bytes(100, 2), 100);
    // Logs /f while its growth is still pending; the sync below must record the new size.
    vfs.mkdirSync('/any');
    vfs.syncSync();
    return { files: [['/f', bytes(200, 1, [[100, Array<number>(100).fill(2)]])]], dirs: ['/any'] };
  }
  if (scenario === 'reused-block') {
    put(vfs, '/old', bytes(BLOCK, 0xbb));
    put(vfs, '/guard', bytes(BLOCK, 0xcc));
    vfs.syncSync();
    vfs.unlinkSync('/old');
    // Takes over the freed block; its bytes past offset 100 still belong to /old.
    put(vfs, '/f', bytes(100, 0x11));
    vfs.syncSync();
    put(vfs, '/f', new Uint8Array([9]), 3000);
    // Any namespace operation logs metadata for every file with unsynced changes.
    vfs.mkdirSync('/any');
    return {
      files: [
        [
          '/f',
          bytes(3001, 0, [
            [0, Array<number>(100).fill(0x11)],
            [3000, [9]],
          ]),
        ],
        ['/guard', bytes(BLOCK, 0xcc)],
      ],
      dirs: ['/any'],
    };
  }
  put(vfs, '/f', bytes(2 * BLOCK, 0xaa));
  vfs.syncSync();
  vfs.truncateSync('/f', 5000);
  vfs.syncSync();
  const kept = Array<number>(5000).fill(0xaa);
  if (scenario === 'extend') {
    vfs.truncateSync('/f', 8000);
    vfs.mkdirSync('/any');
    return { files: [['/f', bytes(8000, 0, [[0, kept]])]], dirs: ['/any'] };
  }
  put(vfs, '/f', new Uint8Array([1, 2, 3]), 8000);
  // A grown volume or a long log turns the next metadata write into a full snapshot.
  if (scenario === 'shrink-hole-snapshot') (vfs as unknown as { dirtyStructure: boolean }).dirtyStructure = true;
  vfs.mkdirSync('/any');
  return {
    files: [
      [
        '/f',
        bytes(8003, 0, [
          [0, kept],
          [8000, [1, 2, 3]],
        ]),
      ],
    ],
    dirs: ['/any'],
  };
}

async function verify(request: Request) {
  const vfs = await mount(request.name, { bufferMode: request.mode, recoveryMode: request.recoveryMode });
  try {
    if (request.recoveryMode === 'fail-stop') {
      check(vfs.getLocalPersistenceStatusSync().lastSalvage === undefined, 'a torn tail is not a salvage event');
    }
    for (const [path, data] of request.expected!.files) checkFile(vfs, path, data);
    for (const dir of request.expected!.dirs) check(vfs.statSync(dir).is_dir, `${dir}: directory survives`);
  } finally {
    await vfs.closeVfs();
  }
}

async function rawHandle(fileName: string) {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(fileName);
  return (
    file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
  ).createSyncAccessHandle();
}

async function appendZeros(name: string, count: number, toEmptyLog = false) {
  const handle = await rawHandle(name.replace(/\.bin$/, '.data.log'));
  try {
    const size = handle.getSize();
    check(toEmptyLog ? size === 0 : size > 0, `unexpected data WAL size ${size}`);
    handle.write(new Uint8Array(count), { at: size });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** Power loss: growth of the data file that was never flushed is gone. */
async function truncateData(name: string, size: number) {
  const handle = await rawHandle(name);
  try {
    check(handle.getSize() > size, `data file ${handle.getSize()} has nothing unflushed past ${size}`);
    handle.truncate(size);
    handle.flush();
  } finally {
    handle.close();
  }
}

async function zeroProtectedWal(name: string) {
  const content = new Uint8Array([111, 107]);
  const first = await mount(name, { bufferMode: 'memory', plugins: [protectedPlugin()] });
  put(first, '/a', content);
  await first.closeVfs();
  // The first append of the next cycle reached the file length, not its bytes.
  await appendZeros(name, 64, true);
  const vfs = await mount(name, { bufferMode: 'memory', recoveryMode: 'fail-stop', plugins: [protectedPlugin()] });
  try {
    const status = vfs.getLocalPersistenceStatusSync();
    check(status.lastSalvage === undefined, 'an all-zero log is not a salvage event');
    check(status.walPendingBytes === 0, 'the zero bytes are dropped');
    checkFile(vfs, '/a', content);
    put(vfs, '/b', content);
    vfs.syncSync();
  } finally {
    await vfs.closeVfs();
  }
}

type Blocker = 'none' | 'file' | 'file+nested' | 'file+lost-file' | 'file+lost-dir';

/**
 * Leaves the log an earlier release wrote when it renamed `/a` to `/b` after a
 * remount: "delete /a, upsert /b", with `/a/1` still present under no parent.
 * With a blocker, a file has since taken the name `/a`, so `/a/1` sits under a
 * non-directory; `nested` adds a file `/a/sub` with `/a/sub/x` below it, so moved entries
 * still sit under a moved file; `lost-file` / `lost-dir` also occupy the name `/lost+found`.
 */
async function forgeDetached(name: string, mode: 'memory' | 'disk', blocker: Blocker) {
  const first = await mount(name, { bufferMode: mode });
  first.mkdirSync('/a');
  put(first, '/a/1', bytes(10, 9));
  if (blocker === 'file+nested') put(first, '/a/sub', bytes(10, 5));
  for (const n of [1, 2, 3, 4]) put(first, `/a-${n}`, bytes(10, n));
  if (blocker === 'file+lost-file') put(first, '/lost+found', bytes(3, 7));
  if (blocker === 'file+lost-dir') {
    first.mkdirSync('/lost+found');
    put(first, '/lost+found/keep', bytes(3, 7));
  }
  await first.closeVfs();
  const vfs = await mount(name, { bufferMode: mode });
  const internals = vfs as unknown as {
    inodes: Map<string, unknown>;
    deletedInodes: Set<string>;
    dirtyInodes: Set<string>;
    writeMeta(): void;
  };
  internals.inodes.set('/b', internals.inodes.get('/a'));
  internals.inodes.delete('/a');
  internals.deletedInodes.add('/a');
  internals.dirtyInodes.add('/b');
  if (blocker !== 'none') {
    // A hard link to /a-1 stands in for any file created at the old directory name.
    internals.inodes.set('/a', internals.inodes.get('/a-1'));
    internals.dirtyInodes.add('/a');
  }
  if (blocker === 'file+nested') {
    // A hard link to /a-2 stands in for a file created below the file /a/sub.
    internals.inodes.set('/a/sub/x', internals.inodes.get('/a-2'));
    internals.dirtyInodes.add('/a/sub/x');
  }
  internals.writeMeta();
}

async function verifyDetached(request: Request) {
  const blocker = request.blocker ?? 'none';
  const root = blocker === 'file+lost-file' || blocker === 'file+lost-dir' ? '/lost+found-2' : '/lost+found';
  const recovered = blocker === 'none' ? '/a/1' : `${root}/a/1`;
  const expectedPaths = ['/', '/a', '/a-1', '/a-2', '/a-3', '/a-4', '/b'];
  if (blocker === 'none') expectedPaths.push('/a/1');
  else expectedPaths.push(root, `${root}/a`, recovered);
  if (blocker === 'file+nested') {
    // The file /a/sub took its place with it, so its child moved on to a second root.
    const second = '/lost+found-2/lost+found/a/sub';
    expectedPaths.push(`${root}/a/sub`, '/lost+found-2', '/lost+found-2/lost+found', '/lost+found-2/lost+found/a');
    expectedPaths.push(second, `${second}/x`);
  }
  if (blocker === 'file+lost-file') expectedPaths.push('/lost+found');
  if (blocker === 'file+lost-dir') expectedPaths.push('/lost+found', '/lost+found/keep');
  expectedPaths.sort();

  const vfs = await mount(request.name, { bufferMode: request.mode, recoveryMode: request.recoveryMode });
  try {
    const status = vfs.getLocalPersistenceStatusSync();
    const error = status.lastError as { name?: string; category?: string; message?: string } | undefined;
    if (request.round === 0) {
      check(status.localPersistenceState === 'error', 'the repair is reported at mount');
      check(
        error?.name === 'VfsCorruptionError' &&
          error.category === 'meta-log' &&
          !!error.message?.includes(blocker === 'none' ? 'missing parent directory: /a' : `to ${root}: /a/1`),
        `the repair names what it did, got ${String(status.lastError)}`,
      );
    } else {
      check(error === undefined, `a repaired volume mounts without a report, got ${String(status.lastError)}`);
    }
    const paths = JSON.stringify(vfs.listPathsSync());
    check(paths === JSON.stringify(expectedPaths), `paths ${paths}, expected ${JSON.stringify(expectedPaths)}`);
    check(vfs.statSync('/b').is_dir, 'the renamed directory exists');
    checkFile(vfs, recovered, bytes(10, 9));
    const parent = recovered.slice(0, recovered.lastIndexOf('/'));
    const listed = JSON.stringify(vfs.readdirNamesSync(parent));
    check(
      listed === (blocker === 'file+nested' ? '["1","sub"]' : '["1"]'),
      `the recovered file is listed, got ${listed}`,
    );
    if (blocker === 'file+nested') {
      checkFile(vfs, `${root}/a/sub`, bytes(10, 5));
      checkFile(vfs, '/lost+found-2/lost+found/a/sub/x', bytes(10, 2));
    }
    if (blocker === 'none') check(vfs.statSync('/a').is_dir, 'the missing directory is back');
    else checkFile(vfs, '/a', bytes(10, 1));
    // Whatever already used the name /lost+found is untouched.
    if (blocker === 'file+lost-file') checkFile(vfs, '/lost+found', bytes(3, 7));
    if (blocker === 'file+lost-dir') {
      check(JSON.stringify(vfs.readdirNamesSync('/lost+found')) === '["keep"]', 'the existing directory is untouched');
      checkFile(vfs, '/lost+found/keep', bytes(3, 7));
    }
    put(vfs, `/new${request.round}`, bytes(5, 9));
    vfs.syncSync();
    vfs.unlinkSync(`/new${request.round}`);
  } finally {
    // Before the repair every close threw: a missing parent, or a parent that is not a directory.
    await vfs.closeVfs();
  }
}

/** The newest snapshot slot is unreadable; the log belongs to it. */
async function rollbackReport(name: string, mode: 'memory' | 'disk') {
  for (const [path, fill] of [
    ['/old', 1],
    ['/kept', 2],
    ['/new', 3],
  ] as const) {
    const session = await mount(name, { bufferMode: mode });
    put(session, path, bytes(100, fill));
    await session.closeVfs();
  }
  const slots = await Promise.all(['.meta.a', '.meta.b'].map((suffix) => rawHandle(name.replace(/\.bin$/, suffix))));
  try {
    const sequence = (handle: FileSystemSyncAccessHandle) => {
      const header = new Uint8Array(8);
      handle.read(header, { at: 0 });
      return new DataView(header.buffer).getUint32(4, true);
    };
    const newest = sequence(slots[0]!) > sequence(slots[1]!) ? slots[0]! : slots[1]!;
    const byte = new Uint8Array(1);
    newest.read(byte, { at: 40 });
    byte[0] ^= 0xff;
    newest.write(byte, { at: 40 });
    newest.flush();
  } finally {
    for (const slot of slots) slot.close();
  }

  let failStop: unknown;
  try {
    await (await mount(name, { bufferMode: mode, recoveryMode: 'fail-stop' })).closeVfs();
  } catch (error) {
    failStop = error;
  }
  check(
    (failStop as { name?: string })?.name === 'MetaSnapshotCorruptionError',
    `fail-stop must refuse, got ${String(failStop)}`,
  );

  const vfs = await mount(name, { bufferMode: mode });
  try {
    const reported = () => {
      const error = vfs.getLocalPersistenceStatusSync().lastError as {
        name?: string;
        category?: string;
        message?: string;
      };
      return (
        error?.name === 'MetaSnapshotCorruptionError' &&
        error.category === 'meta-snapshot' &&
        !!error.message?.includes('older snapshot')
      );
    };
    check(
      vfs.getLocalPersistenceStatusSync().localPersistenceState === 'error',
      'salvage reports the rollback at mount',
    );
    check(reported(), `salvage reports a typed error, got ${String(vfs.getLocalPersistenceStatusSync().lastError)}`);
    checkFile(vfs, '/old', bytes(100, 1));
    checkFile(vfs, '/kept', bytes(100, 2));
    check(!vfs.existsSync('/new'), 'the older snapshot is mounted');
    put(vfs, '/after', bytes(5, 4));
    vfs.syncSync();
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'clean', 'the volume keeps working');
    check(reported(), 'the rollback stays reported after later writes and syncs');
  } finally {
    await vfs.closeVfs();
  }
}

/** A quota failure on the namespace log write of one rename. */
async function deferredNamespace(name: string, durability: NonNullable<OpfsVfsOptions['localDurabilityMode']>) {
  let armed = false;
  const vfs = await mount(name, {
    bufferMode: 'memory',
    localDurabilityMode: durability,
    _wrapSyncAccessHandle: (handle, tag) => {
      if (tag !== 'metaLog') return handle;
      const write = handle.write.bind(handle);
      handle.write = (buffer, options) => {
        if (armed) {
          armed = false;
          throw new DOMException('injected quota failure', 'QuotaExceededError');
        }
        return write(buffer, options);
      };
      return handle;
    },
  });
  const content = bytes(10, 1);
  try {
    put(vfs, '/a', content);
    vfs.syncSync();
    armed = true;
    let failure: unknown;
    try {
      vfs.renameSync('/a', '/b');
    } catch (error) {
      failure = error;
    }
    check(!armed, 'the injected namespace log failure must fire');
    const status = vfs.getLocalPersistenceStatusSync();
    check(status.localPersistenceState === 'error', 'the failed log write is recorded');
    check((status.lastError as { code?: string })?.code === 'ENOSPC', 'the recorded failure is the quota error');
    if (durability === 'strict') {
      check((failure as { code?: string })?.code === 'ENOSPC', `strict must still throw, got ${String(failure)}`);
      return;
    }
    check(failure === undefined, `the rename must succeed, got ${String(failure)}`);
    check(vfs.existsSync('/b') && !vfs.existsSync('/a'), 'the rename is applied');
    vfs.syncSync();
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'clean', 'the next sync retries the record');
  } finally {
    await vfs.closeVfs();
  }
  const reopened = await mount(name, { bufferMode: 'memory' });
  try {
    checkFile(reopened, '/b', content);
    check(!reopened.existsSync('/a'), 'the rename is durable after the retried sync');
  } finally {
    await reopened.closeVfs();
  }
}

type MetaLogFault = { fail: number; error: () => unknown; fired: number };

/** Mount in memory mode with an injectable failure on the next `fail` metadata log writes. */
async function mountWithMetaLogFault(name: string, durability: NonNullable<OpfsVfsOptions['localDurabilityMode']>) {
  const fault: MetaLogFault = {
    fail: 0,
    error: () => new DOMException('injected quota failure', 'QuotaExceededError'),
    fired: 0,
  };
  const vfs = await mount(name, {
    bufferMode: 'memory',
    localDurabilityMode: durability,
    _wrapSyncAccessHandle: (handle, tag) => {
      if (tag !== 'metaLog') return handle;
      const write = handle.write.bind(handle);
      handle.write = (buffer, options) => {
        if (fault.fail-- > 0) {
          fault.fired++;
          throw fault.error();
        }
        return write(buffer, options);
      };
      return handle;
    },
  });
  return { vfs, fault };
}

/**
 * `/a` is unlinked while its namespace record's log write fails (the unlink still returns), then `/b`
 * grows into `/a`'s freed block. Leaves the volume open: the test terminates this worker.
 */
async function unwrittenNamespace(
  name: string,
  durability: NonNullable<OpfsVfsOptions['localDurabilityMode']>,
  variant: NonNullable<Request['variant']>,
): Promise<Expected> {
  const { vfs, fault } = await mountWithMetaLogFault(name, durability);
  put(vfs, '/a', bytes(BLOCK, 0xaa));
  put(vfs, '/b', bytes(BLOCK, 0xbb));
  vfs.syncSync();
  fault.fail = 1;
  vfs.unlinkSync('/a');
  check(fault.fired === 1, 'the injected namespace log failure must fire');
  put(vfs, '/b', bytes(BLOCK, 0xcc), BLOCK);
  if (variant === 'sync-fails') {
    fault.fail = Infinity;
    let failure: unknown;
    try {
      vfs.syncSync();
    } catch (error) {
      failure = error;
    }
    check(failure !== undefined, 'the sync must report the failed metadata write');
  } else {
    vfs.syncSync();
  }
  return { files: [['/b', bytes(2 * BLOCK, 0xbb, [[BLOCK, Array<number>(BLOCK).fill(0xcc)]])]], dirs: [] };
}

/** After a kill, `/a` is gone or intact with its own bytes: never another file's. */
async function verifyUnwrittenNamespace(request: Request) {
  const vfs = await mount(request.name, { bufferMode: 'memory', recoveryMode: 'fail-stop' });
  try {
    if (request.variant === 'sync-succeeds') {
      check(!vfs.existsSync('/a'), '/a: the unlink is durable after the sync');
      checkFile(vfs, '/b', request.expected!.files[0]![1]);
    } else {
      if (vfs.existsSync('/a')) checkFile(vfs, '/a', bytes(BLOCK, 0xaa));
      check(vfs.existsSync('/b'), '/b survives');
      check(
        read(vfs, '/b')
          .subarray(0, BLOCK)
          .every((byte) => byte === 0xbb),
        '/b keeps its first page',
      );
    }
  } finally {
    await vfs.closeVfs();
  }
}

/** A failure that is not a storage failure must reach the caller of a namespace operation. */
async function nonStorageNamespace(name: string, durability: NonNullable<OpfsVfsOptions['localDurabilityMode']>) {
  const { vfs, fault } = await mountWithMetaLogFault(name, durability);
  try {
    put(vfs, '/a', bytes(10, 1));
    put(vfs, '/b', bytes(10, 2));
    vfs.syncSync();
    // A plain error, and a coded one that is not a storage failure.
    for (const [path, invariant] of [
      ['/a', new Error('serializer invariant')],
      ['/b', Object.assign(new Error('coded invariant'), { code: 'EINVAL' })],
    ] as const) {
      fault.error = () => invariant;
      fault.fail = 1;
      let failure: unknown;
      try {
        vfs.unlinkSync(path);
      } catch (error) {
        failure = error;
      }
      check(failure === invariant, `a non-storage error must propagate, got ${String(failure)}`);
    }
  } finally {
    fault.fail = 0;
    await vfs.closeVfs();
  }
}

/** Decrements the length field of the first data WAL frame: it still fits in the file, later frames stay valid. */
async function damageWalLength(name: string) {
  const handle = await rawHandle(name.replace(/\.bin$/, '.data.log'));
  try {
    const field = new Uint8Array(4);
    handle.read(field, { at: 0 });
    const view = new DataView(field.buffer);
    view.setUint32(0, view.getUint32(0, true) - 1, true);
    handle.write(field, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** fail-stop refuses the log with a typed error; salvage reports the corrupt frame instead of mounting empty. */
async function verifyDamagedWalLength(name: string) {
  let failStop: unknown;
  try {
    await (await mount(name, { bufferMode: 'memory', recoveryMode: 'fail-stop' })).closeVfs();
  } catch (error) {
    failStop = error;
  }
  check(
    (failStop as { name?: string })?.name === 'DataWalCorruptionError',
    `fail-stop must refuse a damaged frame length, got ${String(failStop)}`,
  );
  const vfs = await mount(name, { bufferMode: 'memory', recoveryMode: 'salvage' });
  try {
    const salvage = vfs.getLocalPersistenceStatusSync().lastSalvage;
    check(salvage?.reason === 'corrupt-frame', `salvage must report corrupt-frame, got ${String(salvage?.reason)}`);
    check(salvage.truncatedAt === 0, 'the whole log is reported as discarded from byte 0');
  } finally {
    await vfs.closeVfs();
  }
}

/** Flips the last byte of the data WAL: its final frame no longer matches its checksum. */
async function tearFinalFrame(name: string) {
  const handle = await rawHandle(name.replace(/\.bin$/, '.data.log'));
  try {
    const at = handle.getSize() - 1;
    check(at > 0, 'fixture must have pending WAL frames');
    const byte = new Uint8Array(1);
    handle.read(byte, { at });
    byte[0] ^= 0xff;
    handle.write(byte, { at });
    handle.flush();
  } finally {
    handle.close();
  }
}

async function truncateAllocation(name: string) {
  const size = 5_000_001;
  const original = bytes(100, 3);
  const vfs = await mount(name, { bufferMode: 'memory' });
  try {
    put(vfs, '/f', original);
    vfs.syncSync();
    const realUint8Array = globalThis.Uint8Array;
    // Stands in for a buffer too large for the worker to allocate.
    globalThis.Uint8Array = new Proxy(realUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === size) throw new RangeError('Array buffer allocation failed');
        return Reflect.construct(target, args, newTarget);
      },
    });
    let failure: unknown;
    try {
      vfs.truncateSync('/f', size);
    } catch (error) {
      failure = error;
    } finally {
      globalThis.Uint8Array = realUint8Array;
    }
    check(failure instanceof RangeError, `truncate must report the failed allocation, got ${String(failure)}`);
    check(vfs.statSync('/f').size === original.length, 'a failed truncate must not change the file size');
    check(vfs.getLocalPersistenceStatusSync().walPendingBytes === 0, 'a failed truncate must not be logged');
    checkFile(vfs, '/f', original);
  } finally {
    await vfs.closeVfs();
  }
  const reopened = await mount(name, { bufferMode: 'memory' });
  try {
    checkFile(reopened, '/f', original);
  } finally {
    await reopened.closeVfs();
  }
}

async function doubleClaim(name: string) {
  const first = await mount(name, { bufferMode: 'disk' });
  put(first, '/a', bytes(BLOCK, 1));
  put(first, '/b', bytes(BLOCK, 2));
  // Forge the corruption: both files name /a's block.
  const inodes = (first as unknown as { inodes: Map<string, { blocks: number[] }> }).inodes;
  inodes.get('/b')!.blocks = inodes.get('/a')!.blocks.slice();
  await first.closeVfs();

  const vfs = await mount(name, { bufferMode: 'disk' });
  try {
    const corruption = (status = vfs.getLocalPersistenceStatusSync()) =>
      (status.lastError as { name?: string; category?: string } | undefined)?.name === 'VfsCorruptionError' &&
      (status.lastError as { category?: string }).category === 'meta-snapshot';
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'error', 'mount reports the corruption');
    check(
      corruption(),
      `mount reports a typed corruption error, got ${String(vfs.getLocalPersistenceStatusSync().lastError)}`,
    );
    put(vfs, '/c', bytes(10, 3));
    vfs.syncSync();
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'clean', 'a later sync still succeeds');
    check(corruption(), 'the corruption stays reported after later writes and syncs');
  } finally {
    await vfs.closeVfs();
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    let expected: Expected | undefined;
    if (data.action === 'prepare') expected = await prepare(data.name, data.scenario!);
    else if (data.action === 'unwritten-namespace')
      expected = await unwrittenNamespace(data.name, data.durability!, data.variant!);
    else if (data.action === 'verify') await verify(data);
    else if (data.action === 'append-zeros') await appendZeros(data.name, data.bytes!);
    else if (data.action === 'truncate-data') await truncateData(data.name, data.bytes!);
    else if (data.action === 'zero-protected-wal') await zeroProtectedWal(data.name);
    else if (data.action === 'detached-forge') await forgeDetached(data.name, data.mode!, data.blocker ?? 'none');
    else if (data.action === 'rollback-report') await rollbackReport(data.name, data.mode!);
    else if (data.action === 'deferred-namespace') await deferredNamespace(data.name, data.durability!);
    else if (data.action === 'tear-final-frame') await tearFinalFrame(data.name);
    else if (data.action === 'unwritten-verify') await verifyUnwrittenNamespace(data);
    else if (data.action === 'non-storage-namespace') await nonStorageNamespace(data.name, data.durability!);
    else if (data.action === 'damaged-wal-length') await damageWalLength(data.name);
    else if (data.action === 'damaged-wal-verify') await verifyDamagedWalLength(data.name);
    else if (data.action === 'detached-verify') await verifyDetached(data);
    else if (data.action === 'truncate-alloc') await truncateAllocation(data.name);
    else await doubleClaim(data.name);
    self.postMessage({ expected });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
};

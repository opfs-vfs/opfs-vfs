import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';

export type Expected = {
  files: [string, Uint8Array][];
  changedMtime?: string;
  fixedMtime?: [string, number];
};
type Request = {
  action: 'prepare' | 'verify';
  name: string;
  mode: 'memory' | 'disk';
  scenario?: 'alias-unlink' | 'alias-replace' | 'alias-subtree' | 'descriptor' | 'zero' | 'coalesced' | 'wal-replay';
  operation?: 'append' | 'shrink' | 'grow' | 'overwrite';
  crossBlock?: boolean;
  survivingAlias?: boolean;
  encrypted?: boolean;
  expected?: Expected;
};

const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;
// Metadata stores whole seconds. Fixed historical values avoid clock-resolution races.
const oldTime = 1_600_000_000_000;
const successorTime = 1_600_000_001_000;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bytes(size: number, version: number) {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + version * 17) % 251);
}

function put(vfs: OpfsVfs, path: string, data: Uint8Array) {
  const fd = vfs.openSync(path, create);
  try {
    check(vfs.writeSync(fd, data) === data.length, `${path}: write count`);
  } finally {
    vfs.closeSync(fd);
  }
}

function checkFile(vfs: OpfsVfs, path: string, expected: Uint8Array) {
  check(vfs.statSync(path).size === expected.length, `${path}: size ${vfs.statSync(path).size} != ${expected.length}`);
  const fd = vfs.openSync(path);
  try {
    const actual = vfs.readSync(fd, expected.length + 1, 0);
    check(
      actual.read === expected.length && actual.buffer.length === expected.length,
      `${path}: read ${actual.read}, buffer length ${actual.buffer.length} != ${expected.length}; prefix=${String([...actual.buffer.subarray(0, 8)])}`,
    );
    const mismatch = actual.buffer.findIndex((byte, i) => byte !== expected[i]);
    check(mismatch === -1, `${path}: byte ${mismatch}: ${actual.buffer[mismatch]} != ${expected[mismatch]}`);
    const eof = vfs.readSync(fd, 1, expected.length);
    check(eof.read === 0 && eof.buffer.length === 0, `${path}: EOF`);
  } finally {
    vfs.closeSync(fd);
  }
}

function verify(vfs: OpfsVfs, expected: Expected) {
  const names = expected.files.map(([path]) => path.slice(1)).sort();
  check(JSON.stringify(vfs.readdirNamesSync('/')) === JSON.stringify(names), 'exact root namespace');
  for (const [path, data] of expected.files) checkFile(vfs, path, data);
  if (expected.changedMtime) {
    check(
      (vfs.statSync(expected.changedMtime).mtimeMs ?? 0) > oldTime,
      'old descriptor must update surviving inode mtime',
    );
  }
  if (expected.fixedMtime) {
    const [path, mtime] = expected.fixedMtime;
    check(vfs.statSync(path).mtimeMs === mtime, 'old descriptor must not touch successor mtime');
  }
}

function aliasRemoval(vfs: OpfsVfs, scenario: Request['scenario']): Expected {
  const data = bytes(4102, 1);
  const replacement = bytes(7, 2);
  put(vfs, '/a', data);
  if (scenario === 'alias-subtree') vfs.mkdirSync('/dir');
  const alias = scenario === 'alias-subtree' ? '/dir/b' : '/b';
  vfs.linkSync('/a', alias);
  if (scenario === 'alias-replace') put(vfs, '/replacement', replacement);
  vfs.syncSync();
  const fd = vfs.openSync(alias, OpenFlags.O_RDWR);
  const patch = bytes(7, 3);
  vfs.writeSync(fd, patch, 4095);
  vfs.closeSync(fd);
  data.set(patch, 4095);
  if (scenario === 'alias-subtree') vfs.removeSync('/dir');
  else if (scenario === 'alias-replace') vfs.renameSync('/replacement', alias);
  else vfs.unlinkSync(alias);
  return {
    files:
      scenario === 'alias-replace'
        ? [
            ['/a', data],
            ['/b', replacement],
          ]
        : [['/a', data]],
  };
}

function descriptor(vfs: OpfsVfs, request: Request): Expected {
  const original = bytes(8199, 1);
  const successor = bytes(7, 2);
  put(vfs, '/b', original);
  if (request.survivingAlias) vfs.linkSync('/b', '/a');
  vfs.utimesSync('/b', oldTime, oldTime);
  const fd = vfs.openSync('/b', OpenFlags.O_RDWR | (request.operation === 'append' ? OpenFlags.O_APPEND : 0));
  vfs.unlinkSync('/b');
  put(vfs, '/b', successor);
  vfs.utimesSync('/b', successorTime, successorTime);
  // Publish the namespace first so unrelated dirty metadata cannot hide stale descriptor metadata.
  vfs.syncSync();
  let data: Uint8Array;
  if (request.operation === 'append') {
    const patch = bytes(request.crossBlock ? 4097 : 7, 3);
    vfs.writeSync(fd, patch);
    data = new Uint8Array(original.length + patch.length);
    data.set(original);
    data.set(patch, original.length);
  } else if (request.operation === 'overwrite') {
    data = original.slice();
    const patch = bytes(7, 3);
    vfs.writeSync(fd, patch, 4095);
    data.set(patch, 4095);
  } else {
    const size =
      request.operation === 'shrink' ? (request.crossBlock ? 4095 : 8193) : request.crossBlock ? 12289 : 8200;
    vfs.ftruncateSync(fd, size);
    data = new Uint8Array(size);
    data.set(original.subarray(0, size));
  }
  const live = vfs.readSync(fd, data.length + 1, 0);
  check(live.read === data.length && live.buffer.every((byte, i) => byte === data[i]), 'old descriptor live bytes');
  // Keep the old descriptor open through the durability barrier and native termination.
  return {
    files: request.survivingAlias
      ? [
          ['/a', data],
          ['/b', successor],
        ]
      : [['/b', successor]],
    changedMtime: request.survivingAlias ? '/a' : undefined,
    fixedMtime: ['/b', successorTime],
  };
}

type DataWrite = { at: number; length: number };
function physicalBlocks(writes: DataWrite[]) {
  const blocks = new Set<number>();
  for (const { at, length } of writes) {
    for (let block = Math.floor(at / 4096); block < Math.ceil((at + length) / 4096); block++) blocks.add(block);
  }
  return [...blocks].sort((a, b) => a - b);
}

function zero(vfs: OpfsVfs, writes: DataWrite[]): Expected {
  const data = bytes(8199, 1);
  const guard = bytes(4096, 2);
  put(vfs, '/a', data);
  vfs.syncSync();
  const oldBlocks = physicalBlocks(writes);
  check(oldBlocks.length === 3, 'seed must allocate three data blocks');
  put(vfs, '/guard', guard);
  vfs.syncSync();
  vfs.truncateSync('/a', 0);
  vfs.syncSync();
  writes.length = 0;
  put(vfs, '/replacement', data);
  vfs.syncSync();
  check(
    JSON.stringify(physicalBlocks(writes)) === JSON.stringify(oldBlocks),
    'zero truncate must release all three blocks for reuse',
  );
  return {
    files: [
      ['/a', new Uint8Array()],
      ['/guard', guard],
      ['/replacement', data],
    ],
  };
}

function coalesced(vfs: OpfsVfs, writes: DataWrite[]): Expected {
  const data = bytes(12288, 1);
  put(vfs, '/a', data);
  vfs.linkSync('/a', '/b');
  vfs.syncSync();
  writes.length = 0;
  for (const [path, offset] of [
    ['/a', 4095],
    ['/b', 8191],
  ] as const) {
    const fd = vfs.openSync(path, OpenFlags.O_RDWR);
    const patch = bytes(2, offset);
    vfs.writeSync(fd, patch, offset);
    vfs.closeSync(fd);
    data.set(patch, offset);
  }
  vfs.syncSync();
  check(writes.length === 1 && writes[0].length === data.length, `persist one inode once: ${JSON.stringify(writes)}`);
  return {
    files: [
      ['/a', data],
      ['/b', data],
    ],
  };
}

function walReplay(vfs: OpfsVfs): Expected {
  put(vfs, '/a', new TextEncoder().encode('old-a'));
  put(vfs, '/b', new TextEncoder().encode('ABCDE'));
  vfs.syncSync();
  vfs.unlinkSync('/a');
  vfs.renameSync('/b', '/a');
  const fd = vfs.openSync('/a', OpenFlags.O_RDWR);
  vfs.writeSync(fd, new TextEncoder().encode('x'), 2);
  // Strict mode acknowledges each WAL append. Terminate before checkpointing it.
  return { files: [['/a', new TextEncoder().encode('ABxDE')]] };
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    const writes: DataWrite[] = [];
    let dataHandle: FileSystemSyncAccessHandle | undefined;
    const options: OpfsVfsOptions = {
      bufferMode: data.mode,
      localDurabilityMode: 'strict',
      noatime: true,
      openMode: data.action === 'verify' ? 'open-existing' : 'create-new',
      _wrapSyncAccessHandle: (handle) => {
        // The first acquired handle is the volume data file; crypto sidecars also use the data tag.
        dataHandle ??= handle;
        return new Proxy(handle, {
          get(target, property) {
            if (target === dataHandle && property === 'write')
              return (buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions) => {
                writes.push({ at: options?.at ?? 0, length: buffer.byteLength });
                return target.write(buffer, options);
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const vfs = new OpfsVfs(data.name, options);
    await vfs.ready;
    if (data.action === 'verify') {
      verify(vfs, data.expected!);
      vfs.syncSync();
      await vfs.closeVfs();
      self.postMessage({});
      return;
    }
    let expected: Expected;
    switch (data.scenario) {
      case 'descriptor':
        expected = descriptor(vfs, data);
        break;
      case 'zero':
        expected = zero(vfs, writes);
        break;
      case 'coalesced':
        expected = coalesced(vfs, writes);
        break;
      case 'wal-replay':
        expected = walReplay(vfs);
        break;
      default:
        expected = aliasRemoval(vfs, data.scenario);
    }
    if (data.scenario !== 'wal-replay') vfs.syncSync();
    self.postMessage({ expected });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};

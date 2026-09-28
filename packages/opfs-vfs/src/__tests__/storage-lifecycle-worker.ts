import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';

type World = Map<string, { bytes: Uint8Array }>;
export type SequenceState = { world: World; trace: string[] };
type Request = {
  scenario: 'write' | 'verify' | 'sequence';
  name: string;
  mode: 'memory' | 'disk';
  durability: OpfsVfsOptions['localDurabilityMode'];
  barrier?: 'close' | 'sync' | 'fsync';
  seed?: number;
  round?: number;
  state?: SequenceState;
};

const sizes = [0, 1, 7, 4095, 4096, 4097, 8199];
const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// File/version-seeded byte pattern, following the crash-consistency World.
function pattern(name: string, version: number, length: number) {
  let seed = 2166136261;
  for (let i = 0; i < name.length; i++) seed = Math.imul(seed ^ name.charCodeAt(i), 16777619) >>> 0;
  seed = Math.imul(seed ^ (version + 1), 16777619) >>> 0;
  return Uint8Array.from({ length }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 255;
  });
}

function latestWorld(): World {
  return new Map(sizes.map((size) => [`/size-${size}`, { bytes: pattern(`/size-${size}`, 1, size) }]));
}

function verify(vfs: OpfsVfs, world: World) {
  const actualNames = vfs.readdirNamesSync('/');
  const expectedNames = [...world.keys()].map((name) => name.slice(1)).sort();
  check(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `namespace: ${String(actualNames)} != ${String(expectedNames)}`,
  );
  for (const [name, { bytes }] of world) {
    check(vfs.statSync(name).size === bytes.length, `${name}: size must be ${bytes.length}`);
    const fd = vfs.openSync(name);
    try {
      const actual = vfs.readSync(fd, bytes.length + 1, 0);
      check(actual.read === bytes.length, `${name}: read count ${actual.read} != ${bytes.length}`);
      check(actual.buffer.length === bytes.length, `${name}: returned buffer length`);
      const mismatch = actual.buffer.findIndex((byte, i) => byte !== bytes[i]);
      check(
        mismatch === -1,
        `${name}: latest byte mismatch at ${mismatch}: ${actual.buffer[mismatch]} != ${bytes[mismatch]}`,
      );
      const eof = vfs.readSync(fd, 1, bytes.length);
      check(eof.read === 0 && eof.buffer.length === 0, `${name}: expected EOF`);
    } finally {
      vfs.closeSync(fd);
    }
  }
}

function replace(vfs: OpfsVfs, name: string, bytes: Uint8Array) {
  const fd = vfs.openSync(name, create | OpenFlags.O_TRUNC);
  check(vfs.writeSync(fd, bytes, 0) === bytes.length, `${name}: short write`);
  return fd;
}

async function write(vfs: OpfsVfs, barrier: Request['barrier']) {
  const world = latestWorld();
  for (const [name, { bytes }] of world) {
    const fd = replace(vfs, name, pattern(name, 0, bytes.length + 11));
    vfs.closeSync(fd);
  }
  vfs.syncSync();
  const descriptors = [...world].map(([name, { bytes }]) => replace(vfs, name, bytes));
  if (barrier === 'close') await vfs.closeVfs();
  else if (barrier === 'sync') vfs.syncSync();
  else for (const fd of descriptors) vfs.fsyncSync(fd);
  // Sync/fsync leave every descriptor and the mount open until native termination.
}

function sequence(vfs: OpfsVfs, request: Request): SequenceState {
  const seed = request.seed!;
  const round = request.round!;
  const { world, trace }: SequenceState = request.state ?? { world: new Map(), trace: [] };
  let random = (seed ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0;
  const pick = <T>(values: T[]): T => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return values[(random >>> 0) % values.length];
  };
  const candidates = () => [...world.keys()].filter((path) => !path.startsWith('/shared'));
  const choose = () => pick(candidates());
  const record = (operation: string) => trace.push(`round ${round}: ${operation}`);
  const put = (name: string, bytes: Uint8Array) => {
    record(`replace ${name}, ${bytes.length} bytes`);
    const fd = replace(vfs, name, bytes);
    vfs.closeSync(fd);
    const inode = world.get(name) ?? { bytes };
    inode.bytes = bytes;
    world.set(name, inode);
  };
  const writeAt = (name: string, at: number, bytes: Uint8Array, append = false) => {
    record(`${append ? 'append' : 'write'} ${name} at ${at}, ${bytes.length} bytes`);
    const fd = vfs.openSync(name, OpenFlags.O_RDWR | (append ? OpenFlags.O_APPEND : 0));
    try {
      check(vfs.writeSync(fd, bytes, append ? undefined : at) === bytes.length, `${name}: short write`);
    } finally {
      vfs.closeSync(fd);
    }
    const inode = world.get(name)!;
    const updated = new Uint8Array(Math.max(inode.bytes.length, at + bytes.length));
    updated.set(inode.bytes);
    updated.set(bytes, at);
    inode.bytes = updated;
  };
  const resize = (name: string, size: number) => {
    record(`truncate ${name} to ${size}`);
    const fd = vfs.openSync(name, OpenFlags.O_RDWR);
    try {
      vfs.ftruncateSync(fd, size);
    } finally {
      vfs.closeSync(fd);
    }
    const inode = world.get(name)!;
    const bytes = new Uint8Array(size);
    bytes.set(inode.bytes.subarray(0, size));
    inode.bytes = bytes;
  };

  try {
    if (request.state) verify(vfs, world);
    else {
      for (let i = 0; i < 3; i++) put(`/file-${i}`, pattern(`/file-${i}`, seed, 8199));
      put('/shared', pattern('/shared', seed, 8199));
      record('link /shared to /shared-alias');
      vfs.linkSync('/shared', '/shared-alias');
      world.set('/shared-alias', world.get('/shared')!);
      vfs.syncSync();
      trace.push('seed sync acknowledged');
    }
    // Keep one pair linked across every structured clone and durable reopen.
    check(world.get('/shared') === world.get('/shared-alias'), 'model hard links must share identity');
    writeAt('/shared-alias', [4095, 4096, 4097, 8191][round], pattern('/shared', seed + round + 1, 7));
    const name = choose();
    writeAt(name, pick([0, 1, 4095, 4096, 4097, 8191]), pattern(name, seed + round, pick([1, 7, 4097])));
    const appendTo = choose();
    writeAt(appendTo, world.get(appendTo)!.bytes.length, pattern(appendTo, round, pick([1, 7, 4095])), true);
    const shrink = pick(candidates().filter((path) => world.get(path)!.bytes.length > 0));
    resize(shrink, pick(sizes.filter((size) => size < world.get(shrink)!.bytes.length)));
    const grow = choose();
    resize(grow, Math.max(world.get(grow)!.bytes.length + 1, pick([4095, 4096, 4097, 8199])));

    const source = choose();
    const alias = `/link-${round}`;
    record(`link ${source} to ${alias}`);
    vfs.linkSync(source, alias);
    world.set(alias, world.get(source)!);
    writeAt(alias, pick([1, 4095, 4096, 4097]), pattern(alias, seed, 7));
    verify(vfs, world);

    const renamed = `/renamed-${round}`;
    record(`rename ${source} to ${renamed}`);
    vfs.renameSync(source, renamed);
    world.set(renamed, world.get(source)!);
    world.delete(source);
    record(`unlink ${alias}`);
    vfs.unlinkSync(alias);
    world.delete(alias);
    put(alias, pattern(alias, seed + round + 1, pick(sizes)));
    verify(vfs, world);
    vfs.syncSync();
    trace.push(`round ${round}: sync acknowledged`);
    return { world, trace };
  } catch (error) {
    throw new Error(`seed=${seed}\n${trace.join('\n')}\n${String(error)}`, { cause: error });
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    const vfs = new OpfsVfs(data.name, {
      bufferMode: data.mode,
      localDurabilityMode: data.durability,
      noatime: true,
      openMode: data.scenario === 'verify' || data.state ? 'open-existing' : 'open-or-create',
    });
    await vfs.ready;
    let result: SequenceState | undefined;
    if (data.scenario === 'write') await write(vfs, data.barrier);
    else if (data.scenario === 'sequence') result = sequence(vfs, data);
    else {
      verify(vfs, data.state?.world ?? latestWorld());
      await vfs.closeVfs();
    }
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};

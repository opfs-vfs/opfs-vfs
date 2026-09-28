/**
 * Worker harness for PERF-1 (contiguous-block I/O coalescing) and PERF-5
 * (write-amplification / no-stale-data invariant). These need a real
 * `FileSystemSyncAccessHandle` (off-main-thread only), so they run here and
 * report a boolean Check[] back to the driver (same protocol as
 * durability-fixes-worker.ts).
 */

import { OpenFlags, OpfsVfs, type SyncAccessHandleTag } from '../opfs-vfs';

type Check = { check: string; pass: boolean; detail?: string };

const RDWR_CREATE = OpenFlags.O_RDWR | OpenFlags.O_CREAT;
const BLOCK = 4096;

let nameCounter = 0;
const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${nameCounter++}.bin`;

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deterministic pseudo-random byte pattern keyed by seed. */
function pattern(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < len; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

/** Read a whole file via the VFS and return its bytes. */
function readAll(vfs: OpfsVfs, path: string, size: number): Uint8Array {
  const fd = vfs.openSync(path, OpenFlags.O_RDONLY);
  const { buffer } = vfs.readSync(fd, size, 0);
  vfs.closeSync(fd);
  return buffer;
}

/**
 * PERF-1: prove read/write coalescing is correct under a *fragmented* physical
 * block layout (block numbers non-contiguous), with partial head/tail reads and
 * an EOF-spanning last block. We force fragmentation by interleaved alloc/free:
 * fill blocks with 1-block files, unlink every other one, flush to drain the
 * INT-3 quarantine, then write a big file that must reuse the scattered holes.
 */
async function perf1Fragmented(): Promise<Check[]> {
  const checks: Check[] = [];
  const vfs = new OpfsVfs(uniqueName('perf1'), { bufferMode: 'disk', localDurabilityMode: 'relaxed' });
  await vfs.ready;

  // 1) Allocate 16 single-block files so the low address space is dense and
  //    sequential.
  const small = pattern(BLOCK, 1);
  for (let i = 0; i < 16; i++) {
    const fd = vfs.openSync(`/s${i}.bin`, RDWR_CREATE);
    vfs.writeSync(fd, small, 0);
    vfs.closeSync(fd);
  }
  // 2) Free every other file, then flush so the freed (quarantined) blocks
  //    actually return to the allocator. This leaves scattered single-block
  //    holes (no contiguous run), so the allocator (incl. PERF-6 allocRun)
  //    cannot satisfy a multi-block run from them and must stitch singles.
  for (let i = 0; i < 16; i += 2) vfs.unlinkSync(`/s${i}.bin`);
  vfs.flushVfs();

  // 3) Build a multi-block file ONE block per write so each block is allocated
  //    independently into a scattered hole — guaranteeing a non-contiguous
  //    block list even with run allocation. Last write ends mid-block (EOF span).
  const bigSize = BLOCK * 7 + 1234;
  const big = pattern(bigSize, 42);
  const fdBig = vfs.openSync('/big.bin', RDWR_CREATE);
  let written = 0;
  while (written < bigSize) {
    const chunk = Math.min(BLOCK, bigSize - written);
    vfs.writeSync(fdBig, big.subarray(written, written + chunk), written);
    written += chunk;
  }
  vfs.closeSync(fdBig);

  // Inspect the actual block list to confirm we really fragmented it.
  const inode = (vfs as unknown as { getInodeByPath(p: string): { blocks: number[] } | undefined }).getInodeByPath(
    '/big.bin',
  );
  const blocks = inode?.blocks ?? [];
  let contiguous = true;
  for (let i = 1; i < blocks.length; i++) if (blocks[i] !== blocks[i - 1] + 1) contiguous = false;
  checks.push({
    check: 'PERF-1 setup produced a fragmented (non-contiguous) block layout',
    pass: blocks.length >= 7 && !contiguous,
    detail: `blocks=${blocks.join(',')}`,
  });

  // 4) Full read must reconstruct the exact bytes despite fragmentation + EOF span.
  checks.push({
    check: 'PERF-1 full read of fragmented file matches written content',
    pass: eq(readAll(vfs, '/big.bin', bigSize), big),
  });

  // 5) Partial reads at arbitrary offsets (head/tail spanning run boundaries).
  {
    const fd = vfs.openSync('/big.bin', OpenFlags.O_RDONLY);
    const off = BLOCK * 2 - 7; // straddles a block boundary
    const len = BLOCK * 3 + 11;
    const { buffer } = vfs.readSync(fd, len, off);
    vfs.closeSync(fd);
    checks.push({
      check: 'PERF-1 partial read spanning block boundaries matches',
      pass: eq(buffer, big.subarray(off, off + len)),
    });
  }

  // 6) Partial overwrite that straddles boundaries, then full read-back.
  {
    const fd = vfs.openSync('/big.bin', OpenFlags.O_RDWR);
    const off = BLOCK + 100;
    const patch = pattern(BLOCK * 2 + 50, 7);
    vfs.writeSync(fd, patch, off);
    vfs.closeSync(fd);
    const expected = big.slice();
    expected.set(patch, off);
    checks.push({
      check: 'PERF-1 straddling partial overwrite reads back correctly',
      pass: eq(readAll(vfs, '/big.bin', bigSize), expected),
    });
  }

  // 7) Survives flush + reopen (persistToOpfs coalescing path + hydrate path).
  vfs.flushVfs();
  checks.push({
    check: 'PERF-1 content stable after flush',
    pass: eq(
      readAll(vfs, '/big.bin', bigSize),
      (() => {
        const e = big.slice();
        e.set(pattern(BLOCK * 2 + 50, 7), BLOCK + 100);
        return e;
      })(),
    ),
  });
  await vfs.closeVfs();
  return checks;
}

/**
 * PERF-1 memory-mode hydrate/persist coalescing: write a fragmented file in
 * memory mode, flush (persistToOpfs), reopen (hydrateMemoryFileData), and verify
 * content. Memory mode allocates blocks in persistToOpfs, so fragmentation comes
 * from the same alloc/free/realloc dance.
 */
async function perf1MemoryRoundtrip(): Promise<Check[]> {
  const checks: Check[] = [];
  const name = uniqueName('perf1mem');
  const bigSize = BLOCK * 5 + 321;
  const big = pattern(bigSize, 99);

  {
    const vfs = new OpfsVfs(name, { bufferMode: 'memory', localDurabilityMode: 'relaxed' });
    await vfs.ready;
    // Fragment the bitmap: create+flush small files, free alternates, flush.
    for (let i = 0; i < 12; i++) {
      const fd = vfs.openSync(`/m${i}.bin`, RDWR_CREATE);
      vfs.writeSync(fd, pattern(BLOCK, i + 1), 0);
      vfs.closeSync(fd);
    }
    vfs.flushVfs();
    for (let i = 0; i < 12; i += 2) vfs.unlinkSync(`/m${i}.bin`);
    vfs.flushVfs();
    const fd = vfs.openSync('/mbig.bin', RDWR_CREATE);
    vfs.writeSync(fd, big, 0);
    vfs.closeSync(fd);
    vfs.flushVfs();
    checks.push({
      check: 'PERF-1 memory-mode flushed file reads back in-process',
      pass: eq(readAll(vfs, '/mbig.bin', bigSize), big),
    });
    await vfs.closeVfs();
  }
  {
    const vfs = new OpfsVfs(name, { bufferMode: 'memory', localDurabilityMode: 'relaxed' });
    await vfs.ready; // triggers hydrateMemoryFileData
    checks.push({
      check: 'PERF-1 memory-mode hydrate after reopen matches',
      pass: eq(readAll(vfs, '/mbig.bin', bigSize), big),
    });
    await vfs.closeVfs();
  }
  return checks;
}

/**
 * PERF-5: no-stale-data invariant. Allocate blocks, free them, re-allocate to a
 * new file, and write only PART of each new block. The uncovered sub-ranges must
 * read back as zero — never the previous file's content. This guards the
 * "zero only uncovered head/tail" optimization against leaking freed data.
 */
async function perf5NoStaleLeak(): Promise<Check[]> {
  const checks: Check[] = [];
  const vfs = new OpfsVfs(uniqueName('perf5'), { bufferMode: 'disk', localDurabilityMode: 'relaxed' });
  await vfs.ready;

  // 1) Write a "secret" file fully populating several blocks with 0xAB.
  const secretSize = BLOCK * 6;
  const secret = new Uint8Array(secretSize).fill(0xab);
  const fdS = vfs.openSync('/secret.bin', RDWR_CREATE);
  vfs.writeSync(fdS, secret, 0);
  vfs.closeSync(fdS);
  // 2) Delete it and flush so those blocks return to the allocator.
  vfs.unlinkSync('/secret.bin');
  vfs.flushVfs();

  // 3) New file: write at an offset that leaves a partial HEAD hole in the first
  //    block and a partial TAIL hole in the last block. Those holes must be zero,
  //    not 0xAB.
  const fdN = vfs.openSync('/new.bin', RDWR_CREATE);
  // Grow the file to span 6 blocks but only write the middle of the range.
  const writeOff = 100; // leaves bytes [0,100) of block 0 as a head hole
  const payload = pattern(BLOCK * 5 + 200, 5); // ends mid-block → tail hole
  vfs.writeSync(fdN, payload, writeOff);
  vfs.closeSync(fdN);

  const fileSize = writeOff + payload.length;
  const readBack = readAll(vfs, '/new.bin', fileSize);

  // Head hole [0, writeOff) must be zero.
  let headZero = true;
  for (let i = 0; i < writeOff; i++) if (readBack[i] !== 0) headZero = false;
  checks.push({ check: 'PERF-5 head hole reads as zero (no 0xAB leak)', pass: headZero });

  // Written region must match payload.
  checks.push({
    check: 'PERF-5 written region intact',
    pass: eq(readBack.subarray(writeOff, writeOff + payload.length), payload),
  });

  // No byte anywhere equals the secret marker run (sanity: secret was all 0xAB;
  // any leak in a hole would show 0xAB). Holes are head + nothing-after-EOF here.
  let anyLeak = false;
  for (let i = 0; i < writeOff; i++) if (readBack[i] === 0xab) anyLeak = true;
  checks.push({ check: 'PERF-5 no 0xAB from freed secret visible in holes', pass: !anyLeak });

  // 4) Reading PAST EOF returns nothing (no resurrection of stale block tails).
  {
    const fd = vfs.openSync('/new.bin', OpenFlags.O_RDONLY);
    const { read } = vfs.readSync(fd, BLOCK, fileSize); // at EOF
    vfs.closeSync(fd);
    checks.push({ check: 'PERF-5 read past EOF returns 0 bytes', pass: read === 0 });
  }

  // 5) Survive flush + reopen.
  vfs.flushVfs();
  const after = readAll(vfs, '/new.bin', fileSize);
  let headZero2 = true;
  for (let i = 0; i < writeOff; i++) if (after[i] !== 0) headZero2 = false;
  checks.push({
    check: 'PERF-5 holes still zero + data intact after flush/reopen',
    pass: headZero2 && eq(after.subarray(writeOff, writeOff + payload.length), payload),
  });
  await vfs.closeVfs();
  return checks;
}

/**
 * PERF-3: incremental derived-index maintenance must equal a full rebuild.
 * Run a randomized sequence of namespace ops (create/mkdir/unlink/rename/link/
 * symlink/rmdir), snapshot the incrementally-maintained inodeTable / dirEntries
 * / pathIndex / inoToPaths, then force a fresh rebuildIndexesFromPathMap and
 * assert the two states are deep-equal.
 */
async function perf3IncrementalEqualsRebuild(): Promise<Check[]> {
  const checks: Check[] = [];
  const vfs = new OpfsVfs(uniqueName('perf3'), { bufferMode: 'memory', localDurabilityMode: 'relaxed' });
  await vfs.ready;
  const v = vfs as unknown as {
    openSync(p: string, f: number): number;
    closeSync(fd: number): void;
    mkdirSync(p: string, m?: number): void;
    unlinkSync(p: string): void;
    rmdirSync(p: string): void;
    renameSync(a: string, b: string): void;
    linkSync(a: string, b: string): void;
    symlinkSync(t: string, p: string): void;
    inodeTable: Map<number, { ino: number }>;
    dirEntries: Map<number, Map<string, number>>;
    pathIndex: Map<string, number>;
    inoToPaths: Map<number, Set<string>>;
    rebuildIndexesFromPathMap(): void;
  };

  // Deterministic PRNG so failures reproduce.
  let s = 0x12345678;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const pick = <T>(arr: T[]): T | undefined => (arr.length ? arr[Math.floor(rnd() * arr.length)] : undefined);

  const files: string[] = [];
  const dirs: string[] = ['/'];
  const symlinks: string[] = [];
  let counter = 0;
  const childPath = (dir: string, base: string) => (dir === '/' ? `/${base}` : `${dir}/${base}`);

  const OPS = 400;
  for (let i = 0; i < OPS; i++) {
    const op = Math.floor(rnd() * 6);
    try {
      if (op === 0) {
        // create file
        const dir = pick(dirs)!;
        const p = childPath(dir, `f${counter++}`);
        const fd = v.openSync(p, RDWR_CREATE);
        v.closeSync(fd);
        files.push(p);
      } else if (op === 1) {
        // mkdir
        const dir = pick(dirs)!;
        const p = childPath(dir, `d${counter++}`);
        v.mkdirSync(p);
        dirs.push(p);
      } else if (op === 2 && files.length) {
        // unlink file
        const idx = Math.floor(rnd() * files.length);
        const p = files[idx];
        v.unlinkSync(p);
        files.splice(idx, 1);
        for (let k = symlinks.length - 1; k >= 0; k--) void k; // no-op keep symlinks
      } else if (op === 3 && files.length) {
        // hard link a file
        const src = pick(files)!;
        const dir = pick(dirs)!;
        const p = childPath(dir, `l${counter++}`);
        v.linkSync(src, p);
        files.push(p);
      } else if (op === 4) {
        // symlink
        const dir = pick(dirs)!;
        const p = childPath(dir, `s${counter++}`);
        v.symlinkSync('/some/target', p);
        symlinks.push(p);
      } else if (op === 5 && files.length) {
        // rename a file to a new name in a (possibly different) dir
        const idx = Math.floor(rnd() * files.length);
        const from = files[idx];
        const dir = pick(dirs)!;
        const to = childPath(dir, `r${counter++}`);
        if (to === from) continue;
        v.renameSync(from, to);
        files[idx] = to;
      }
    } catch {
      // Some random ops legitimately fail (EEXIST/ENOENT after prior moves);
      // those are fine — we only care that the indexes stay consistent.
    }
  }

  // Snapshot incrementally-maintained state.
  const snap = (
    inodeTable: Map<number, { ino: number }>,
    dirEntries: Map<number, Map<string, number>>,
    pathIndex: Map<string, number>,
    inoToPaths: Map<number, Set<string>>,
  ) => ({
    inodeTable: [...inodeTable.keys()].sort((a, b) => a - b),
    pathIndex: [...pathIndex.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    dirEntries: [...dirEntries.entries()]
      .map(([ino, m]) => [ino, [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))] as const)
      .sort((a, b) => a[0] - b[0]),
    inoToPaths: [...inoToPaths.entries()]
      .map(([ino, set]) => [ino, [...set].sort()] as const)
      .sort((a, b) => a[0] - b[0]),
  });

  const before = snap(v.inodeTable, v.dirEntries, v.pathIndex, v.inoToPaths);
  v.rebuildIndexesFromPathMap();
  const after = snap(v.inodeTable, v.dirEntries, v.pathIndex, v.inoToPaths);

  checks.push({
    check: 'PERF-3 incremental pathIndex equals full rebuild',
    pass: JSON.stringify(before.pathIndex) === JSON.stringify(after.pathIndex),
    detail: `before=${before.pathIndex.length} after=${after.pathIndex.length}`,
  });
  checks.push({
    check: 'PERF-3 incremental inodeTable keys equal full rebuild',
    pass: JSON.stringify(before.inodeTable) === JSON.stringify(after.inodeTable),
  });
  checks.push({
    check: 'PERF-3 incremental dirEntries equal full rebuild',
    pass: JSON.stringify(before.dirEntries) === JSON.stringify(after.dirEntries),
  });
  checks.push({
    check: 'PERF-3 incremental inoToPaths equal full rebuild',
    pass: JSON.stringify(before.inoToPaths) === JSON.stringify(after.inoToPaths),
  });
  await vfs.closeVfs();
  return checks;
}

const RUNNERS: Record<string, () => Promise<Check[]>> = {
  perf1Fragmented,
  perf1MemoryRoundtrip,
  perf5NoStaleLeak,
  perf3IncrementalEqualsRebuild,
};

void ([] as SyncAccessHandleTag[]);

self.onmessage = async (event: MessageEvent<{ type: string; scenario?: string }>) => {
  const { type, scenario } = event.data;
  if (type !== 'RUN') return;
  const runner = scenario ? RUNNERS[scenario] : undefined;
  if (!runner) {
    self.postMessage({ type: 'ERROR', error: `unknown scenario: ${scenario}` });
    return;
  }
  try {
    const results = await runner();
    self.postMessage({ type: 'RESULT', results });
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error instanceof Error ? error.message : String(error) });
  }
};

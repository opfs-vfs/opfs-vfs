import { OpenFlags } from '../opfs-vfs';

export const BLOCK = 4096;
export const DATA_BLOCKS = 256;
export const FRAGMENT_FILES = 64;
export const LARGE_BYTES = DATA_BLOCKS * BLOCK;

export type Workload = 'read' | 'write' | 'metadata' | 'sync' | 'large-read' | 'large-write';

export interface BenchClient {
  mkdir(path: string): Promise<void>;
  open(path: string, flags: number): Promise<number>;
  read(fd: number, size: number, offset: number): Promise<{ buffer: Uint8Array; read: number }>;
  write(fd: number, data: Uint8Array, offset: number): Promise<number>;
  stat(path: string): Promise<{ size: number }>;
  fsync(fd: number): Promise<void>;
  close(fd: number): Promise<void>;
  unlink(path: string): Promise<void>;
  flush(): Promise<void>;
  ready: Promise<void>;
  closeVfs(): Promise<void>;
}

export interface SyncBenchClient {
  mkdirSync(path: string): void;
  openSync(path: string, flags: number): number;
  readSync(fd: number, size: number, offset: number): { buffer: Uint8Array; read: number };
  writeSync(fd: number, data: Uint8Array, offset: number): number;
  statSync(path: string): { size: number };
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  unlinkSync(path: string): void;
  flushVfs(): Promise<void>;
}

export function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deterministic pseudo-random byte pattern, shared with perf-coalescing-worker. */
export function pattern(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < len; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

// This subarray does not own its ArrayBuffer, so OpfsVfsWorker copies the reused payload instead of detaching it.
const retainedPattern = (len: number, seed: number) => {
  const bytes = new Uint8Array(len + 1);
  bytes.set(pattern(len, seed));
  return bytes.subarray(0, len);
};

export async function prepareDataset(client: BenchClient): Promise<void> {
  await client.mkdir('/bench');
  for (let i = 0; i < FRAGMENT_FILES; i++) {
    const fd = await client.open(`/bench/frag-${i}`, OpenFlags.O_RDWR | OpenFlags.O_CREAT);
    await client.write(fd, pattern(BLOCK, i + 1), 0);
    await client.close(fd);
  }
  await client.flush();
  for (let i = 0; i < FRAGMENT_FILES; i += 2) await client.unlink(`/bench/frag-${i}`);
  await client.flush();

  const data = pattern(LARGE_BYTES, 42);
  const dataFd = await client.open('/bench/data.bin', OpenFlags.O_RDWR | OpenFlags.O_CREAT);
  // Flush after each block: memory mode allocates on flush, and one block per flush fills the scattered holes first.
  for (let i = 0; i < DATA_BLOCKS; i++) {
    await client.write(dataFd, data.subarray(i * BLOCK, (i + 1) * BLOCK), i * BLOCK);
    await client.flush();
  }
  await client.close(dataFd);

  const writeFd = await client.open('/bench/write.bin', OpenFlags.O_RDWR | OpenFlags.O_CREAT);
  // This subarray does not own its ArrayBuffer, so OpfsVfsWorker copies the reused payload instead of detaching it.
  const zero = new Uint8Array(BLOCK + 1).subarray(0, BLOCK);
  for (let i = 0; i < DATA_BLOCKS; i++) await client.write(writeFd, zero, i * BLOCK);
  await client.close(writeFd);
  await client.flush();

  const verifyFd = await client.open('/bench/data.bin', OpenFlags.O_RDWR);
  const actual = await client.read(verifyFd, data.length, 0);
  await client.close(verifyFd);
  if (actual.read !== data.length || !eq(actual.buffer, data)) throw new Error('Benchmark dataset verification failed');
}

type MeasureOptions = { warmup: number; ops: number };
export type MeasureResult = { warmupMs: number[]; samplesMs: number[]; wallMs: number; mismatches: number };

/*
 * Workloads are sequential. read and write use 4 KiB I/O, large-read and large-write use 1 MiB I/O,
 * metadata times stat, and sync times fsync after an untimed dirty write. Checks happen outside individual timers.
 */
export async function measureAsync(
  client: BenchClient,
  workload: Workload,
  options: MeasureOptions,
): Promise<MeasureResult> {
  const data = pattern(LARGE_BYTES, 42);
  const payloads = Array.from({ length: 16 }, (_, i) => retainedPattern(BLOCK, 1000 + i));
  const largePayloads = [retainedPattern(LARGE_BYTES, 2000), retainedPattern(LARGE_BYTES, 2001)];
  // Only slots written by this measurement are verified; other slots keep earlier workloads' bytes.
  const expected: (Uint8Array | undefined)[] = new Array(DATA_BLOCKS);
  const dataFd = await client.open('/bench/data.bin', OpenFlags.O_RDWR);
  const writeFd = await client.open('/bench/write.bin', OpenFlags.O_RDWR);
  const warmupMs: number[] = [];
  const samplesMs: number[] = [];
  let mismatches = 0;
  let wallStarted = 0;
  try {
    for (let i = 0; i < options.warmup + options.ops; i++) {
      if (i === options.warmup) wallStarted = performance.now();
      const slot = (i * 97) % DATA_BLOCKS;
      const payload = payloads[(i + Math.floor(i / DATA_BLOCKS)) % payloads.length];
      let started: number;
      let elapsed: number;
      if (workload === 'read') {
        started = performance.now();
        const result = await client.read(dataFd, BLOCK, slot * BLOCK);
        elapsed = performance.now() - started;
        if (result.read !== BLOCK || !eq(result.buffer, data.subarray(slot * BLOCK, (slot + 1) * BLOCK))) mismatches++;
      } else if (workload === 'large-read') {
        started = performance.now();
        const result = await client.read(dataFd, LARGE_BYTES, 0);
        elapsed = performance.now() - started;
        if (result.read !== LARGE_BYTES || !eq(result.buffer, data)) mismatches++;
      } else if (workload === 'write') {
        started = performance.now();
        const written = await client.write(writeFd, payload, slot * BLOCK);
        elapsed = performance.now() - started;
        if (written !== BLOCK) mismatches++;
        expected[slot] = payload;
      } else if (workload === 'large-write') {
        const payload = largePayloads[i % largePayloads.length];
        started = performance.now();
        const written = await client.write(writeFd, payload, 0);
        elapsed = performance.now() - started;
        if (written !== LARGE_BYTES) mismatches++;
      } else if (workload === 'metadata') {
        started = performance.now();
        const result = await client.stat('/bench/data.bin');
        elapsed = performance.now() - started;
        if (result.size !== DATA_BLOCKS * BLOCK) mismatches++;
      } else {
        const written = await client.write(writeFd, payload, slot * BLOCK);
        if (written !== BLOCK) mismatches++;
        expected[slot] = payload;
        started = performance.now();
        await client.fsync(writeFd);
        elapsed = performance.now() - started;
      }
      (i < options.warmup ? warmupMs : samplesMs).push(elapsed);
    }
    const wallMs = performance.now() - wallStarted;
    if (workload === 'write' || workload === 'sync') {
      for (let slot = 0; slot < DATA_BLOCKS; slot++) {
        const want = expected[slot];
        if (!want) continue;
        const result = await client.read(writeFd, BLOCK, slot * BLOCK);
        if (result.read !== BLOCK || !eq(result.buffer, want)) mismatches++;
      }
    }
    if (workload === 'large-write') {
      const result = await client.read(writeFd, LARGE_BYTES, 0);
      const expected = largePayloads[(options.warmup + options.ops - 1) % largePayloads.length];
      if (result.read !== LARGE_BYTES || !eq(result.buffer, expected)) mismatches++;
    }
    return { warmupMs, samplesMs, wallMs, mismatches };
  } finally {
    try {
      await client.close(dataFd);
    } finally {
      await client.close(writeFd);
    }
  }
}

export function measureSync(client: SyncBenchClient, workload: Workload, options: MeasureOptions): MeasureResult {
  const data = pattern(LARGE_BYTES, 42);
  const payloads = Array.from({ length: 16 }, (_, i) => retainedPattern(BLOCK, 1000 + i));
  const largePayloads = [retainedPattern(LARGE_BYTES, 2000), retainedPattern(LARGE_BYTES, 2001)];
  // Only slots written by this measurement are verified; other slots keep earlier workloads' bytes.
  const expected: (Uint8Array | undefined)[] = new Array(DATA_BLOCKS);
  const dataFd = client.openSync('/bench/data.bin', OpenFlags.O_RDWR);
  const writeFd = client.openSync('/bench/write.bin', OpenFlags.O_RDWR);
  const warmupMs: number[] = [];
  const samplesMs: number[] = [];
  let mismatches = 0;
  let wallStarted = 0;
  try {
    for (let i = 0; i < options.warmup + options.ops; i++) {
      if (i === options.warmup) wallStarted = performance.now();
      const slot = (i * 97) % DATA_BLOCKS;
      const payload = payloads[(i + Math.floor(i / DATA_BLOCKS)) % payloads.length];
      let started: number;
      let elapsed: number;
      if (workload === 'read') {
        started = performance.now();
        const result = client.readSync(dataFd, BLOCK, slot * BLOCK);
        elapsed = performance.now() - started;
        if (result.read !== BLOCK || !eq(result.buffer, data.subarray(slot * BLOCK, (slot + 1) * BLOCK))) mismatches++;
      } else if (workload === 'large-read') {
        started = performance.now();
        const result = client.readSync(dataFd, LARGE_BYTES, 0);
        elapsed = performance.now() - started;
        if (result.read !== LARGE_BYTES || !eq(result.buffer, data)) mismatches++;
      } else if (workload === 'write') {
        started = performance.now();
        const written = client.writeSync(writeFd, payload, slot * BLOCK);
        elapsed = performance.now() - started;
        if (written !== BLOCK) mismatches++;
        expected[slot] = payload;
      } else if (workload === 'large-write') {
        const payload = largePayloads[i % largePayloads.length];
        started = performance.now();
        const written = client.writeSync(writeFd, payload, 0);
        elapsed = performance.now() - started;
        if (written !== LARGE_BYTES) mismatches++;
      } else if (workload === 'metadata') {
        started = performance.now();
        const result = client.statSync('/bench/data.bin');
        elapsed = performance.now() - started;
        if (result.size !== DATA_BLOCKS * BLOCK) mismatches++;
      } else {
        const written = client.writeSync(writeFd, payload, slot * BLOCK);
        if (written !== BLOCK) mismatches++;
        expected[slot] = payload;
        started = performance.now();
        client.fsyncSync(writeFd);
        elapsed = performance.now() - started;
      }
      (i < options.warmup ? warmupMs : samplesMs).push(elapsed);
    }
    const wallMs = performance.now() - wallStarted;
    if (workload === 'write' || workload === 'sync') {
      for (let slot = 0; slot < DATA_BLOCKS; slot++) {
        const want = expected[slot];
        if (!want) continue;
        const result = client.readSync(writeFd, BLOCK, slot * BLOCK);
        if (result.read !== BLOCK || !eq(result.buffer, want)) mismatches++;
      }
    }
    if (workload === 'large-write') {
      const result = client.readSync(writeFd, LARGE_BYTES, 0);
      const expected = largePayloads[(options.warmup + options.ops - 1) % largePayloads.length];
      if (result.read !== LARGE_BYTES || !eq(result.buffer, expected)) mismatches++;
    }
    return { warmupMs, samplesMs, wallMs, mismatches };
  } finally {
    try {
      client.closeSync(dataFd);
    } finally {
      client.closeSync(writeFd);
    }
  }
}

type ColdClient = { ready: Promise<void>; closeVfs(): Promise<void> };

export async function measureColdAsync(
  factory: () => ColdClient,
  options: { warmup: number; count: number },
): Promise<{ warmupReadyMs: number[]; warmupCloseMs: number[]; readyMs: number[]; closeMs: number[] }> {
  const warmupReadyMs: number[] = [];
  const warmupCloseMs: number[] = [];
  const readyMs: number[] = [];
  const closeMs: number[] = [];
  for (let i = 0; i < options.warmup + options.count; i++) {
    const started = performance.now();
    const client = factory();
    let readyAt: number;
    try {
      await client.ready;
      readyAt = performance.now();
    } catch (error) {
      try {
        await client.closeVfs();
      } catch {}
      throw error;
    }
    await client.closeVfs();
    const targetReady = i < options.warmup ? warmupReadyMs : readyMs;
    const targetClose = i < options.warmup ? warmupCloseMs : closeMs;
    targetReady.push(readyAt - started);
    targetClose.push(performance.now() - readyAt);
  }
  return { warmupReadyMs, warmupCloseMs, readyMs, closeMs };
}

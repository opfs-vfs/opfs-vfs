/**
 * Crash-consistency fault-injection sweep harness (spec §6.1).
 *
 * Turns the Phase-1 integrity fixes (INT-1, INT-2, INT-4, INT-5, SEC-2) from
 * "fixed once" into "guarded forever" by killing the VFS at EVERY OPFS-mutation
 * boundary during representative workloads, remounting with a fresh un-proxied
 * VFS, and asserting integrity invariants.
 *
 * ── Fault-injection seam ──
 * `FaultProxy` wraps every `FileSystemSyncAccessHandle` the VFS acquires (via
 * the test-only `_wrapSyncAccessHandle` constructor hook). A single shared
 * `KillBudget` counts mutation ops (`write`/`truncate`/`flush`) in the exact
 * order the VFS issues them across ALL handles. Ops 1..N forward to the real
 * handle; from op N+1 onward the proxy STOPS FORWARDING (the real file never
 * sees the byte) and throws a `CrashSentinel` into the VFS. This models "the
 * process died at op boundary N".
 *
 * Honest limitation: in-browser we cannot simulate loss of written-but-unflushed
 * data — a `write` that we forwarded is treated as durable even if no `flush`
 * followed. The harness therefore exercises OPERATION-ORDERING windows (write
 * meta before/after bitmap, truncate-then-write, snapshot swap order — where ALL
 * the Phase-1 bugs lived), not sector-level tearing within a single write.
 * Reads always forward (they don't change disk state). `close` forwards (handle
 * hygiene) but is not counted.
 */

import { OpenFlags, OpfsVfs, type OpfsVfsOptions, type SyncAccessHandleTag } from '../opfs-vfs';

// ── Fault-injection proxy ──

/** Sentinel thrown when the kill budget is exhausted; distinguishes a simulated
 * crash from a genuine harness/VFS bug when caught at the workload boundary. */
class CrashSentinel extends Error {
  readonly isCrashSentinel = true;
  constructor(op: number) {
    super(`crash-sentinel: killed at mutation op ${op}`);
    this.name = 'CrashSentinel';
  }
}

interface OpTrace {
  op: number; // 1-based mutation op index (write/truncate/flush only)
  tag: SyncAccessHandleTag;
  kind: 'write' | 'truncate' | 'flush';
  forwarded: boolean;
}

/** Shared, ordered mutation-op counter across all of a VFS's handles. */
class KillBudget {
  count = 0;
  /** Forward ops 1..budget; from budget+1 onward, throw the sentinel. Infinity = never kill. */
  budget = Number.POSITIVE_INFINITY;
  killed = false;
  trace: OpTrace[] = [];
  /** ~last 12 ops, for diagnostics. */
  private readonly traceCap = 256;

  /** @returns true if this op should forward; false means "throw sentinel". */
  gate(tag: SyncAccessHandleTag, kind: OpTrace['kind']): boolean {
    this.count += 1;
    const forwarded = this.count <= this.budget;
    if (this.trace.length < this.traceCap) {
      this.trace.push({ op: this.count, tag, kind, forwarded });
    }
    if (!forwarded) this.killed = true;
    return forwarded;
  }

  traceTail(n = 12): string {
    return this.trace
      .slice(-n)
      .map((t) => `#${t.op} ${t.tag}.${t.kind}${t.forwarded ? '' : ' [KILLED]'}`)
      .join(' | ');
  }
}

type RawHandle = FileSystemSyncAccessHandle;

/** Wrap one real handle; route mutations through the shared budget. */
function makeFaultProxy(real: RawHandle, tag: SyncAccessHandleTag, budget: KillBudget): RawHandle {
  const proxy: Partial<RawHandle> & Record<string, unknown> = {
    // Reads never change disk state — always forward.
    read: (buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number => real.read(buffer, options),
    getSize: (): number => real.getSize(),
    // close forwards for handle hygiene but is not counted as a mutation.
    close: (): void => real.close(),
    write: (buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number => {
      if (!budget.gate(tag, 'write')) throw new CrashSentinel(budget.count);
      return real.write(buffer, options);
    },
    truncate: (newSize: number): void => {
      if (!budget.gate(tag, 'truncate')) throw new CrashSentinel(budget.count);
      real.truncate(newSize);
    },
    flush: (): void => {
      if (!budget.gate(tag, 'flush')) throw new CrashSentinel(budget.count);
      real.flush();
    },
  };
  return proxy as unknown as RawHandle;
}

function wrapHook(budget: KillBudget): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  return (handle, tag) => makeFaultProxy(handle, tag, budget);
}

function isCrashSentinel(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { isCrashSentinel?: boolean }).isCrashSentinel === true;
}

// ── Best-effort handle release after a simulated crash ──
// After the sentinel fires, the still-open REAL handles must be released
// WITHOUT any further flush (a real crash flushes nothing). We close the raw
// handles directly via the VFS's private fields — mirroring `simulateCrashClose`
// in persistence-test-worker.ts. The proxy's `close` simply forwards.

type CrashableVfs = {
  closed: boolean;
  storageHandles?: Array<{ close(): void }>;
  storage?: { destroy(): void };
  dataHandle?: { close(): void };
  metaHandleA?: { close(): void };
  metaHandleB?: { close(): void };
  bitmapHandle?: { close(): void };
  logHandle?: { close(): void };
  dataLogHandle?: { close(): void };
  bootstrapHandle?: { close(): void };
};

function releaseAfterCrash(vfs: OpfsVfs): void {
  const c = vfs as unknown as CrashableVfs;
  c.closed = true; // prevent any debounced flush from firing
  void (vfs as unknown as { releaseVolumeLock?: () => Promise<void> }).releaseVolumeLock?.();
  for (const h of [
    c.dataHandle,
    c.metaHandleA,
    c.metaHandleB,
    c.bitmapHandle,
    c.logHandle,
    c.dataLogHandle,
    c.bootstrapHandle,
    ...(c.storageHandles ?? []),
  ]) {
    try {
      h?.close();
    } catch {
      // Handle already closed / never acquired — ignore.
    }
  }
  c.storage?.destroy();
  c.storage = undefined;
  c.storageHandles = [];
}

// ── World model ──
// Each file's content at any synced point must equal one of the byte patterns
// it has held over the workload (its version history). Patterns are derivable
// from the file name + a version index, so cross-file bleed is detectable: a
// file must NEVER read back bytes belonging to a DIFFERENT file's pattern.

type BufferMode = 'memory' | 'disk';

/** Deterministic, file-unique, version-unique byte pattern. */
function pattern(name: string, version: number, length: number): Uint8Array {
  // Seed mixes a per-name hash with the version so two files never share bytes
  // and two versions of the same file differ.
  let seed = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    seed = Math.imul(seed ^ name.charCodeAt(i), 16777619) >>> 0;
  }
  seed = Math.imul(seed ^ (version + 1), 16777619) >>> 0;
  const out = new Uint8Array(length);
  let s = seed || 1;
  for (let i = 0; i < length; i++) {
    // xorshift32 — cheap deterministic stream
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A logical file's content history, tracked by stable identity rather than by
 * path (so rename aliasing and hard links don't confuse it). The crash window
 * means run-window ops may or may not be durable, so the model is deliberately
 * TOLERANT about which name a file currently has and whether an unlinked file
 * survived — but STRICT about content: whatever is present must equal a valid
 * historical version, and must never read another logical file's bytes.
 */
interface FileSpec {
  /** Stable identity (first name the file was created under). */
  id: string;
  /** Recorded version contents, oldest → newest. A valid remount reads back any of these. */
  versions: Uint8Array[];
  /** Every path this file has ever been reachable at (creation + rename targets + hard links). */
  names: Set<string>;
  /** True if a version was fully synced before the workload window (the pre-state). */
  preSeeded: boolean;
  /** True if a namespace op in the run window may have removed/moved it
   *  (so its absence under a given name is acceptable). */
  namespaceTouched: boolean;
}

class World {
  /** Keyed by stable identity. */
  specs = new Map<string, FileSpec>();
  /** name → current spec (latest mapping; tolerant — both old/new names kept in spec.names). */
  byName = new Map<string, FileSpec>();

  recordVersion(name: string, bytes: Uint8Array, preSeeded = false) {
    let spec = this.byName.get(name);
    if (!spec) {
      spec = { id: name, versions: [], names: new Set([name]), preSeeded: false, namespaceTouched: false };
      this.specs.set(name, spec);
      this.byName.set(name, spec);
    }
    spec.versions.push(bytes);
    spec.names.add(name);
    if (preSeeded) spec.preSeeded = true;
  }

  markRemoved(name: string) {
    const spec = this.byName.get(name);
    if (spec) spec.namespaceTouched = true;
    this.byName.delete(name);
  }

  renameKey(from: string, to: string) {
    const spec = this.byName.get(from);
    if (spec) {
      spec.namespaceTouched = true;
      spec.names.add(to);
      this.byName.delete(from);
      this.byName.set(to, spec);
    }
  }

  /** Register a hard link: `link` becomes another name for `existing`'s file. */
  linkName(existing: string, link: string) {
    const spec = this.byName.get(existing);
    if (spec) {
      spec.namespaceTouched = true;
      spec.names.add(link);
      this.byName.set(link, spec);
    }
  }

  /** All (id, version-bytes) pairs ever recorded — for cross-bleed scanning. */
  allVersions(): { id: string; bytes: Uint8Array }[] {
    const out: { id: string; bytes: Uint8Array }[] = [];
    for (const spec of this.specs.values()) {
      for (const v of spec.versions) out.push({ id: spec.id, bytes: v });
    }
    return out;
  }
}

// ── Workloads ──
// Each workload is a deterministic script of VFS ops that maintains the World.
// `seed(vfs, world)` runs the pre-state (always fully synced before the kill
// window). `run(vfs, world)` runs the mutating window the sweep kills inside.

interface Workload {
  name: string;
  mode: BufferMode;
  seed: (vfs: OpfsVfs, world: World) => void;
  run: (vfs: OpfsVfs, world: World) => void;
}

const SMALL = 1500; // ~half a block; cheap, but crosses partial-block boundaries
const MULTI = 9000; // spans 3 blocks — exercises run-coalescing / block tables
const EMPTY = new Uint8Array(0);

/**
 * Write `bytes` to `name` via `O_CREAT|O_TRUNC|O_RDWR` and register the
 * legitimate durable end-states in the world model.
 *
 * `O_TRUNC` + write is logically TWO durable steps: (1) truncate-to-0,
 * (2) write the new bytes. A crash between them leaves the file legitimately
 * EMPTY; a crash before either leaves the PRIOR content; full completion leaves
 * the new bytes. We therefore record EMPTY and the new content as acceptable
 * versions (the prior content is already in the spec from earlier calls), and
 * record them BEFORE issuing the write so an attempted-but-killed create still
 * has a spec to validate against.
 */
function doWrite(vfs: OpfsVfs, name: string, bytes: Uint8Array) {
  const fd = vfs.openSync(name, OpenFlags.O_CREAT | OpenFlags.O_RDWR | OpenFlags.O_TRUNC);
  if (bytes.length > 0) vfs.writeSync(fd, bytes, 0);
  vfs.closeSync(fd);
}

/**
 * Run-window write: records the legitimate durable end-states BEFORE writing.
 * A crash mid-`O_TRUNC`+write leaves EMPTY; a full completion leaves `bytes`;
 * a crash before anything durable leaves the prior content (already in the
 * spec). Recording up-front means an attempted-but-killed create still has a
 * spec to validate against.
 */
function writeFile(vfs: OpfsVfs, world: World, name: string, bytes: Uint8Array) {
  world.recordVersion(name, EMPTY);
  world.recordVersion(name, bytes);
  doWrite(vfs, name, bytes);
}

/**
 * Pre-state write: fully completes and is synced before the kill window, so the
 * transient EMPTY state is never a valid outcome — record only the final bytes.
 */
function seedFile(vfs: OpfsVfs, world: World, name: string, bytes: Uint8Array) {
  world.recordVersion(name, bytes, true);
  doWrite(vfs, name, bytes);
}

/** (a) create N small files with unique per-file patterns + syncSync. */
function workloadCreate(mode: BufferMode): Workload {
  const N = 12;
  return {
    name: `create-unique-${mode}`,
    mode,
    seed: (vfs, world) => {
      // One pre-seeded file that must survive every kill point intact.
      seedFile(vfs, world, '/seed.bin', pattern('/seed.bin', 0, SMALL));
      vfs.syncSync();
    },
    run: (vfs, world) => {
      for (let i = 0; i < N; i++) {
        const name = `/c${i}.bin`;
        const len = i % 3 === 0 ? MULTI : SMALL;
        writeFile(vfs, world, name, pattern(name, 0, len));
      }
      vfs.syncSync();
    },
  };
}

/** (b) overwrite + extend + truncate existing files + syncSync. */
function workloadOverwrite(mode: BufferMode): Workload {
  const N = 8;
  return {
    name: `overwrite-extend-truncate-${mode}`,
    mode,
    seed: (vfs, world) => {
      for (let i = 0; i < N; i++) {
        const name = `/o${i}.bin`;
        seedFile(vfs, world, name, pattern(name, 0, MULTI));
      }
      vfs.syncSync();
    },
    run: (vfs, world) => {
      for (let i = 0; i < N; i++) {
        const name = `/o${i}.bin`;
        // overwrite-same / extend / truncate-shorter, cycling.
        const len = i % 3 === 0 ? MULTI : i % 3 === 1 ? MULTI + SMALL : SMALL;
        writeFile(vfs, world, name, pattern(name, 1, len));
      }
      vfs.syncSync();
    },
  };
}

/** (c) namespace churn: rename / unlink / mkdir / hardlink + syncSync. */
function workloadNamespace(mode: BufferMode): Workload {
  const N = 8;
  return {
    name: `namespace-churn-${mode}`,
    mode,
    seed: (vfs, world) => {
      vfs.mkdirSync('/d');
      for (let i = 0; i < N; i++) {
        const name = `/d/n${i}.bin`;
        seedFile(vfs, world, name, pattern(name, 0, SMALL));
      }
      vfs.syncSync();
    },
    run: (vfs, world) => {
      vfs.mkdirSync('/d2');
      for (let i = 0; i < N; i++) {
        const name = `/d/n${i}.bin`;
        if (i % 4 === 0) {
          const to = `/d2/r${i}.bin`;
          vfs.renameSync(name, to);
          world.renameKey(name, to);
        } else if (i % 4 === 1) {
          vfs.unlinkSync(name);
          world.markRemoved(name);
        } else if (i % 4 === 2) {
          const link = `/d2/l${i}.bin`;
          vfs.linkSync(name, link);
          world.linkName(name, link); // hardlink shares the same content history
        }
        // i % 4 === 3: leave untouched
      }
      vfs.syncSync();
    },
  };
}

/** (d) full snapshot rewrite via flushVfs/closeVfs after dirty structure. */
function workloadSnapshotRewrite(mode: BufferMode): Workload {
  const N = 6;
  return {
    name: `snapshot-rewrite-${mode}`,
    mode,
    seed: (vfs, world) => {
      for (let i = 0; i < N; i++) {
        const name = `/s${i}.bin`;
        seedFile(vfs, world, name, pattern(name, 0, i % 2 === 0 ? MULTI : SMALL));
      }
      vfs.syncSync();
    },
    run: (vfs, world) => {
      // Dirty the structure, then force a FULL snapshot swap (INT-1/INT-2 path).
      for (let i = 0; i < N; i++) {
        const name = `/s${i}.bin`;
        writeFile(vfs, world, name, pattern(name, 1, SMALL));
      }
      vfs.mkdirSync('/late');
      vfs.flushVfs(); // full snapshot rewrite into the inactive A/B slot
    },
  };
}

function buildWorkloads(): Workload[] {
  return [
    workloadCreate('disk'),
    workloadCreate('memory'),
    workloadOverwrite('disk'),
    workloadOverwrite('memory'),
    workloadNamespace('disk'),
    workloadSnapshotRewrite('disk'),
  ];
}

// ── Integrity assertions ──

type Check = { check: string; pass: boolean; detail?: string };

interface CorruptionError extends Error {
  name: string;
}

const TYPED_CORRUPTION_NAMES = new Set(['MetaSnapshotCorruptionError', 'DataWalCorruptionError']);

function isTypedCorruption(e: unknown): e is CorruptionError {
  return !!e && typeof e === 'object' && TYPED_CORRUPTION_NAMES.has((e as Error).name);
}

function readAll(vfs: OpfsVfs, name: string): Uint8Array {
  const size = vfs.statSync(name).size;
  const fd = vfs.openSync(name, OpenFlags.O_RDONLY);
  try {
    const { buffer, read } = vfs.readSync(fd, size, 0);
    return buffer.subarray(0, read);
  } finally {
    vfs.closeSync(fd);
  }
}

/** Recursively list all regular-file paths in the mounted namespace. */
function listFiles(vfs: OpfsVfs, dir = '/'): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = vfs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    const full = dir === '/' ? `/${n}` : `${dir}/${n}`;
    let st: { is_dir: boolean };
    try {
      st = vfs.statSync(full);
    } catch {
      continue;
    }
    if (st.is_dir) out.push(...listFiles(vfs, full));
    else out.push(full);
  }
  return out;
}

/**
 * Assert all invariants after a remount. Returns a list of failures (empty = ok).
 *
 * The model is TOLERANT about durability of run-window ops (a file may be absent,
 * or still at its old name, if its create/rename/unlink wasn't durable at kill N)
 * but STRICT about content: anything present must read back EXACTLY one recorded
 * historical version, and a file must never read another logical file's bytes
 * (cross-bleed = the INT-3/INT-4 corruption class).
 */
function assertIntegrity(
  vfs: OpfsVfs,
  world: World,
  ctx: { workload: string; killN: number; budget: KillBudget },
): Check[] {
  const failures: Check[] = [];
  const fail = (msg: string, detail?: string) => failures.push({ check: msg, pass: false, detail });
  const tail = ctx.budget.traceTail();
  const allVersions = world.allVersions();

  // 1. Every present file must read back a valid historical version, and the
  //    version must belong to a logical file that can legitimately own this name.
  const live = listFiles(vfs).filter((p) => !p.startsWith('/__probe__'));
  for (const name of live) {
    let content: Uint8Array;
    try {
      content = readAll(vfs, name);
    } catch (e) {
      fail(`read of ${name} threw`, `${(e as Error).message} | N=${ctx.killN} wl=${ctx.workload} | ${tail}`);
      continue;
    }

    // The spec(s) that could legitimately occupy this path (current owner + any
    // file that was ever reachable under this name via create/rename/link).
    const owners = [...world.specs.values()].filter((s) => s.names.has(name));
    const matchesOwner = owners.some((s) => s.versions.some((v) => eq(content, v)));
    if (matchesOwner) continue;

    // Not a valid version of any legitimate owner. Is it a FOREIGN file's bytes?
    const bleed = allVersions.find((p) => eq(content, p.bytes) && !owners.some((o) => o.id === p.id));
    const diag =
      `len=${content.length} owners=[${owners.map((o) => o.id).join(',') || 'none'}]` +
      (bleed
        ? ` — CROSS-BLEED: reads as logical file ${bleed.id}`
        : ` — TORN/GARBAGE head=${[...content.subarray(0, 8)].join(',')}`);
    fail(`${name} content is not a valid historical version`, `N=${ctx.killN} wl=${ctx.workload} | ${diag} | ${tail}`);
  }

  // 2. Pre-seeded files (synced before the window) must survive: readable as a
  //    valid version under at least one tracked name — UNLESS a namespace op in
  //    the killed window may have moved/removed it (then absence is acceptable,
  //    but if present it was already checked for content above).
  for (const spec of world.specs.values()) {
    if (!spec.preSeeded || spec.namespaceTouched) continue;
    const presentName = [...spec.names].find((n) => {
      try {
        return vfs.existsSync(n) && !vfs.statSync(n).is_dir;
      } catch {
        return false;
      }
    });
    if (!presentName) {
      fail(
        `pre-seeded file ${spec.id} missing after remount`,
        `N=${ctx.killN} wl=${ctx.workload} | names=[${[...spec.names].join(',')}] | ${tail}`,
      );
      continue;
    }
    const content = readAll(vfs, presentName);
    if (!spec.versions.some((v) => eq(content, v))) {
      fail(
        `pre-seeded file ${spec.id} not intact at ${presentName}`,
        `N=${ctx.killN} wl=${ctx.workload} | len=${content.length} | ${tail}`,
      );
    }
  }
  return failures;
}

// ── Sweep driver ──

let dbCounter = 0;
function freshDbName(workload: string): string {
  dbCounter += 1;
  const rnd = Math.random().toString(36).slice(2, 8);
  return `cc-${workload}-${dbCounter}-${rnd}.bin`;
}

function pickKillPoints(total: number): number[] {
  if (total <= 0) return [];
  if (total <= 150) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  // Stride-sample ~100 points evenly + first/last 10.
  const points = new Set<number>();
  for (let i = 1; i <= Math.min(10, total); i++) points.add(i);
  for (let i = Math.max(1, total - 9); i <= total; i++) points.add(i);
  const stride = Math.max(1, Math.floor(total / 100));
  for (let n = 1; n <= total; n += stride) points.add(n);
  return [...points].sort((a, b) => a - b);
}

async function newVfs(name: string, mode: BufferMode, budget?: KillBudget): Promise<OpfsVfs> {
  const opts: OpfsVfsOptions = { bufferMode: mode, localDurabilityMode: 'relaxed' };
  if (budget) opts._wrapSyncAccessHandle = wrapHook(budget);
  const vfs = new OpfsVfs(name, opts);
  await vfs.ready;
  return vfs;
}

/** Phase 1: learn the total mutation-op count T for a workload's seed+run. */
async function measureTotalOps(wl: Workload): Promise<number> {
  const name = freshDbName(`measure-${wl.name}`);
  const budget = new KillBudget(); // unlimited
  const vfs = await newVfs(name, wl.mode, budget);
  const world = new World();
  // Seed ops also count — but we kill only within the run window. We measure
  // ops from the start of `run` so kill points map to the mutating window.
  wl.seed(vfs, world);
  const opsAfterSeed = budget.count;
  wl.run(vfs, world);
  await vfs.closeVfs();
  return budget.count - opsAfterSeed;
}

/** Run one kill-at-N iteration on a fresh DB and assert invariants on remount. */
async function runKillIteration(wl: Workload, killWithinRun: number): Promise<Check[]> {
  const name = freshDbName(wl.name);
  const failures: Check[] = [];
  const seedBudget = new KillBudget(); // unlimited during seed
  const vfs = await newVfs(name, wl.mode, seedBudget);
  const world = new World();
  wl.seed(vfs, world);
  // The seed must complete without ever tripping the kill (it's the pre-state).
  // Now arm the budget: forward `seed ops + killWithinRun`, kill after.
  seedBudget.budget = seedBudget.count + killWithinRun;

  try {
    wl.run(vfs, world);
  } catch (e) {
    if (!isCrashSentinel(e)) {
      failures.push({
        check: `unexpected throw during run`,
        pass: false,
        detail: `N=${killWithinRun} wl=${wl.name} err=${(e as Error).name}: ${(e as Error).message} | ${seedBudget.traceTail()}`,
      });
      releaseAfterCrash(vfs);
      return failures;
    }
  }
  // Release real handles WITHOUT further flushes (simulated crash).
  releaseAfterCrash(vfs);

  // ── Remount with a fresh, un-proxied VFS and assert invariants ──
  let remount: OpfsVfs | undefined;
  try {
    remount = await newVfs(name, wl.mode);
  } catch (e) {
    if (isTypedCorruption(e)) {
      // Given INT-1..5, mounts should essentially always succeed. A typed
      // failure is unexpected-but-reportable — but it MUST be deterministic.
      let secondName: string | undefined;
      try {
        const second = await newVfs(name, wl.mode);
        await second.closeVfs();
        secondName = 'SECOND MOUNT SUCCEEDED (non-deterministic!)';
      } catch (e2) {
        secondName = isTypedCorruption(e2) ? 'deterministic typed failure' : `flaky: ${(e2 as Error).name}`;
      }
      failures.push({
        check: `remount raised typed corruption (${(e as Error).name})`,
        pass: false,
        detail: `N=${killWithinRun} wl=${wl.name} | ${secondName} | ${seedBudget.traceTail()}`,
      });
      return failures;
    }
    failures.push({
      check: `remount threw NON-corruption error`,
      pass: false,
      detail: `N=${killWithinRun} wl=${wl.name} err=${(e as Error).name}: ${(e as Error).message} | ${seedBudget.traceTail()}`,
    });
    return failures;
  }

  try {
    failures.push(...assertIntegrity(remount, world, { workload: wl.name, killN: killWithinRun, budget: seedBudget }));

    // Invariant: the remounted VFS must accept a write + syncSync + clean second remount.
    const probeName = '/__probe__.bin';
    const probe = pattern(probeName, 99, SMALL);
    doWrite(remount, probeName, probe);
    remount.syncSync();
    await remount.closeVfs();
    remount = undefined;

    const second = await newVfs(name, wl.mode);
    try {
      const got = readAll(second, probeName);
      if (!eq(got, probe)) {
        failures.push({
          check: `probe write not durable after second remount`,
          pass: false,
          detail: `N=${killWithinRun} wl=${wl.name} | ${seedBudget.traceTail()}`,
        });
      }
    } finally {
      await second.closeVfs();
    }
  } catch (e) {
    failures.push({
      check: `post-remount probe/recovery threw`,
      pass: false,
      detail: `N=${killWithinRun} wl=${wl.name} err=${(e as Error).name}: ${(e as Error).message} | ${seedBudget.traceTail()}`,
    });
    if (remount) {
      try {
        await remount.closeVfs();
      } catch {
        // ignore
      }
    }
  }
  return failures;
}

async function runSweep(wl: Workload): Promise<Check[]> {
  const results: Check[] = [];
  const total = await measureTotalOps(wl);
  results.push({ check: `${wl.name}: measured total mutation ops`, pass: total > 0, detail: `T=${total}` });
  if (total <= 0) return results;

  const killPoints = pickKillPoints(total);
  results.push({ check: `${wl.name}: kill points exercised`, pass: true, detail: `${killPoints.length} of ${total}` });

  let firstFailure: Check | undefined;
  for (const n of killPoints) {
    const failures = await runKillIteration(wl, n);
    if (failures.length > 0 && !firstFailure) {
      firstFailure = failures[0];
      // Surface the first real failure prominently; keep sweeping is pointless
      // once a corruption window is found — report it and stop this workload.
      break;
    }
  }
  if (firstFailure) {
    results.push(firstFailure);
  } else {
    results.push({
      check: `${wl.name}: all kill points clean`,
      pass: true,
      detail: `${killPoints.length} remounts verified`,
    });
  }
  return results;
}

// ── Worker message dispatch ──

self.onmessage = async (event: MessageEvent<{ type: string; workload?: string }>) => {
  const { type, workload } = event.data;
  if (type !== 'RUN_CRASH_SWEEP') return;
  try {
    const wl = buildWorkloads().find((w) => w.name === workload);
    if (!wl) {
      self.postMessage({ type: 'ERROR', error: `unknown workload: ${workload}` });
      return;
    }
    const results = await runSweep(wl);
    self.postMessage({ type: 'RESULT', results });
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      error: `${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}`,
    });
  }
};

// Exported for potential direct unit use / tree-shake friendliness.
export { buildWorkloads, KillBudget, makeFaultProxy, pattern, pickKillPoints };

/**
 * Worker harness for the Phase-4 close-path / WAL / init durability fixes
 * (INT-6, INT-7, INT-8). These scenarios need a real `FileSystemSyncAccessHandle`,
 * which is only available off the main thread, so they run here and report a
 * boolean Check[] back to the driving test (same protocol as
 * crash-consistency-worker.ts).
 */

import { OpenFlags, OpfsVfs, type OpfsVfsOptions, type SyncAccessHandleTag } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';

type Check = { check: string; pass: boolean; detail?: string };

const RDWR_CREATE = OpenFlags.O_RDWR | OpenFlags.O_CREAT;
type RawHandle = FileSystemSyncAccessHandle;
type FailingState = { armed: boolean; closed: Set<SyncAccessHandleTag>; injected?: boolean };

const volumes: string[] = [];
const uniqueName = (prefix: string) => {
  const name = `${prefix}-${crypto.randomUUID()}.bin`;
  volumes.push(name);
  return name;
};

/**
 * Wrap handles so that mutations (write/truncate/flush) on `failTag` throw while
 * `state.armed` is true. Reads forward; close forwards and is recorded in
 * `state.closed` so a test can assert handle release even on a throwing flush.
 */
function failingHook(
  failTag: SyncAccessHandleTag,
  state: FailingState,
): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  return (real: RawHandle, tag: SyncAccessHandleTag) => {
    const fail = (kind: string) => {
      if (tag === failTag && state.armed) {
        state.injected = true;
        throw new DOMException(`injected ${kind} failure on ${tag}`, 'QuotaExceededError');
      }
    };
    const proxy: Partial<RawHandle> & Record<string, unknown> = {
      read: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.read(b, o),
      getSize: () => real.getSize(),
      close: () => {
        state.closed.add(tag);
        real.close();
      },
      write: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => {
        fail('write');
        return real.write(b, o);
      },
      truncate: (n: number) => {
        fail('truncate');
        real.truncate(n);
      },
      flush: () => {
        fail('flush');
        real.flush();
      },
    };
    return proxy as unknown as RawHandle;
  };
}

/**
 * INT-8 follow-up: every handle is acquired SUCCESSFULLY, then a post-acquisition
 * init step (a `read` on `failTag`) throws. Proves the init cleanup covers the
 * steps that run after the acquisition guard, not just acquisition itself.
 */
function readFailHook(failTag: SyncAccessHandleTag): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  return (real: RawHandle, tag: SyncAccessHandleTag) => {
    if (tag !== failTag) return real;
    const proxy: Partial<RawHandle> & Record<string, unknown> = {
      // Report a non-empty size so init proceeds into the read path, then throw
      // there — simulating a post-acquisition failure (e.g. corrupt cache read).
      getSize: () => Math.max(real.getSize(), 8),
      read: () => {
        throw new DOMException('injected post-acquisition read failure', 'InvalidStateError');
      },
      write: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.write(b, o),
      truncate: (n: number) => real.truncate(n),
      flush: () => real.flush(),
      close: () => real.close(),
    };
    return proxy as unknown as RawHandle;
  };
}

/** Return one short write, then zero progress so writeAll must fail closed. */
function stalledShortWriteHook(failTag: SyncAccessHandleTag): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  let calls = 0;
  return (real: RawHandle, tag: SyncAccessHandleTag) => {
    if (tag !== failTag) return real;
    const proxy: Partial<RawHandle> & Record<string, unknown> = {
      read: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.read(b, o),
      getSize: () => real.getSize(),
      close: () => real.close(),
      write: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => {
        calls += 1;
        if (calls === 1) return real.write(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), o);
        if (calls === 2) return 0;
        return real.write(b, o);
      },
      truncate: (n: number) => real.truncate(n),
      flush: () => real.flush(),
    };
    return proxy as unknown as RawHandle;
  };
}

/** Throw at a selected mutation on one handle (write/truncate/flush). */
function failNthMutationHook(
  failTag: SyncAccessHandleTag,
  failAt: number,
): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  let mutations = 0;
  return (real: RawHandle, tag: SyncAccessHandleTag) => {
    if (tag !== failTag) return real;
    const mutate = () => {
      mutations += 1;
      if (mutations === failAt) {
        throw new DOMException(`injected mutation ${failAt} failure on ${tag}`, 'InvalidStateError');
      }
    };
    const proxy: Partial<RawHandle> & Record<string, unknown> = {
      read: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.read(b, o),
      getSize: () => real.getSize(),
      close: () => real.close(),
      write: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => {
        mutate();
        return real.write(b, o);
      },
      truncate: (n: number) => {
        mutate();
        real.truncate(n);
      },
      flush: () => {
        mutate();
        real.flush();
      },
    };
    return proxy as unknown as RawHandle;
  };
}

/**
 * Crash-harness follow-up: the wrap hook itself throws for `failTag` (handle was
 * acquired, but wrapping fails). For the 'commit' tag the production init catch
 * tolerates this — init must still succeed and the orphaned raw commit handle
 * must be released (acquire() closes it), so a clean remount succeeds.
 */
function wrapThrowHook(failTag: SyncAccessHandleTag): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  return (real: RawHandle, tag: SyncAccessHandleTag) => {
    if (tag === failTag) throw new DOMException(`injected wrap failure on ${tag}`, 'InvalidStateError');
    return real;
  };
}

/** A hook that throws on the Nth `createSyncAccessHandle` acquisition (INT-8). */
function acquireFailHook(failOnNth: number): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  let n = 0;
  return (real: RawHandle) => {
    n += 1;
    if (n === failOnNth) throw new DOMException('injected acquisition failure', 'NotAllowedError');
    return real;
  };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function simulateCrashClose(vfs: OpfsVfs): void {
  const state = vfs as unknown as {
    closed: boolean;
  };
  const handles = vfs as unknown as Record<string, { close(): void } | undefined>;
  state.closed = true;
  void (vfs as unknown as { releaseVolumeLock?: () => Promise<void> }).releaseVolumeLock?.();
  for (const key of [
    'logHandle',
    'dataLogHandle',
    'bitmapHandle',
    'metaHandleA',
    'metaHandleB',
    'bootstrapHandle',
    'dataHandle',
  ]) {
    try {
      handles[key]?.close();
    } catch {
      // Best-effort crash teardown; never flush.
    }
  }
}

async function overwriteSidecar(
  fileName: string,
  suffix: string,
  bytes: Uint8Array = new Uint8Array(0),
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  if (bytes.byteLength > 0) handle.write(bytes, { at: 0 });
  handle.flush();
  handle.close();
}

async function readSidecar(fileName: string, suffix: string): Promise<Uint8Array> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create: false });
  return new Uint8Array(await (await file.getFile()).arrayBuffer());
}

// ── INT-6: flush/close error handling ──────────────────────────────────────

async function int6(): Promise<Check[]> {
  const checks: Check[] = [];
  const name = uniqueName('int6');

  // (1) flushVfs must not mark `flushed` when the flush throws — a disarmed
  //     retry then succeeds, proving the flush was never treated as done.
  {
    const state = { armed: false, closed: new Set<SyncAccessHandleTag>() };
    const vfs = new OpfsVfs(name, {
      bufferMode: 'disk',
      localDurabilityMode: 'relaxed',
      _wrapSyncAccessHandle: failingHook('data', state),
    });
    await vfs.ready;
    const fd = vfs.openSync('/f.bin', RDWR_CREATE);
    vfs.writeSync(fd, new Uint8Array([1, 2, 3, 4]), 0);

    state.armed = true;
    let threw = false;
    try {
      vfs.flushVfs();
    } catch {
      threw = true;
    }
    const s1 = vfs.getLocalPersistenceStatusSync();
    checks.push({ check: 'INT-6 flushVfs throw propagates', pass: threw });
    checks.push({
      check: 'INT-6 failed flush sets error state + records lastError',
      pass: s1.localPersistenceState === 'error' && s1.lastError !== undefined,
      detail: `state=${s1.localPersistenceState} hasError=${s1.lastError !== undefined}`,
    });

    state.armed = false;
    let retryOk = false;
    try {
      vfs.flushVfs();
      retryOk = true;
    } catch {
      retryOk = false;
    }
    const s2 = vfs.getLocalPersistenceStatusSync();
    checks.push({
      check: 'INT-6 retry after failed flush succeeds (flushed not stuck true)',
      pass: retryOk && s2.localPersistenceState === 'clean',
      detail: `retryOk=${retryOk} state=${s2.localPersistenceState}`,
    });
    vfs.closeSync(fd);
    void vfs.closeVfs();
  }

  // (2) closeVfs must release ALL handles even when its implicit flush throws.
  {
    const state = { armed: false, closed: new Set<SyncAccessHandleTag>() };
    const vfs = new OpfsVfs(uniqueName('int6b'), {
      bufferMode: 'disk',
      localDurabilityMode: 'relaxed',
      _wrapSyncAccessHandle: failingHook('data', state),
    });
    await vfs.ready;
    const fd = vfs.openSync('/g.bin', RDWR_CREATE);
    vfs.writeSync(fd, new Uint8Array([9, 8, 7]), 0);
    vfs.closeSync(fd);

    state.armed = true;
    let closeThrew = false;
    try {
      void vfs.closeVfs();
    } catch {
      closeThrew = true;
    }
    const wanted: SyncAccessHandleTag[] = ['data', 'metaA', 'metaB', 'metaLog'];
    const allClosed = wanted.every((t) => state.closed.has(t));
    checks.push({ check: 'INT-6 throwing close flush still propagates', pass: closeThrew });
    checks.push({
      check: 'INT-6 closeVfs releases all handles in finally despite flush throw',
      pass: allClosed,
      detail: `closed=${[...state.closed].join(',')}`,
    });
    state.armed = false;
    let secondCloseOk = false;
    try {
      void vfs.closeVfs();
      secondCloseOk = true;
    } catch {
      secondCloseOk = false;
    }
    checks.push({ check: 'INT-6 second closeVfs is a no-op', pass: secondCloseOk });
  }

  // (3) balanced pagehide flush failure surfaces via the status API.
  {
    const state = { armed: false, closed: new Set<SyncAccessHandleTag>() };
    const events: Record<string, () => void> = {};
    const scope = globalThis as unknown as { addEventListener?: (e: string, cb: () => void) => void };
    const realAdd = scope.addEventListener?.bind(globalThis);
    scope.addEventListener = (e: string, cb: () => void) => {
      events[e] = cb;
    };
    let vfs: OpfsVfs;
    try {
      vfs = new OpfsVfs(uniqueName('int6c'), {
        bufferMode: 'disk',
        localDurabilityMode: 'balanced',
        _wrapSyncAccessHandle: failingHook('data', state),
      });
      await vfs.ready;
    } finally {
      scope.addEventListener = realAdd;
    }
    const fd = vfs.openSync('/h.bin', RDWR_CREATE);
    vfs.writeSync(fd, new Uint8Array([4, 5, 6]), 0);
    state.armed = true;
    let hookThrew = false;
    try {
      events.pagehide?.();
    } catch {
      hookThrew = true;
    }
    const s = vfs.getLocalPersistenceStatusSync();
    checks.push({ check: 'INT-6 pagehide hook swallows the throw', pass: !hookThrew });
    checks.push({
      check: 'INT-6 swallowed pagehide failure surfaces as error state',
      pass: s.localPersistenceState === 'error' && s.lastError !== undefined,
      detail: `state=${s.localPersistenceState} hasError=${s.lastError !== undefined}`,
    });
    state.armed = false;
    vfs.closeSync(fd);
    void vfs.closeVfs();
  }

  return checks;
}

// ── INT-7: mode-switch leaves a live data WAL ───────────────────────────────

async function int7(): Promise<Check[]> {
  const checks: Check[] = [];
  const name = uniqueName('int7');

  // Step 1: memory mode, write data. The data WAL gets uncheckpointed records.
  {
    const vfs = new OpfsVfs(name, { bufferMode: 'memory', localDurabilityMode: 'relaxed' });
    await vfs.ready;
    const fd = vfs.openSync('/m.bin', RDWR_CREATE);
    vfs.writeSync(fd, new Uint8Array([10, 20, 30, 40]), 0);
    vfs.closeSync(fd);
    // Crash-style release WITHOUT flush/checkpoint: leave the WAL live on disk.
    (vfs as unknown as { closed: boolean }).closed = true;
    void (vfs as unknown as { releaseVolumeLock?: () => Promise<void> }).releaseVolumeLock?.();
    const handles = vfs as unknown as Record<string, { close(): void } | undefined>;
    for (const key of [
      'dataHandle',
      'metaHandleA',
      'metaHandleB',
      'bitmapHandle',
      'logHandle',
      'dataLogHandle',
      'bootstrapHandle',
    ]) {
      try {
        handles[key]?.close();
      } catch {}
    }
  }

  // A nonempty memory WAL must be recovered in memory mode before switching.
  {
    const disk = new OpfsVfs(name, { bufferMode: 'disk' });
    let code: unknown;
    try {
      await disk.ready;
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    checks.push({ check: 'INT-7 disk mount requires memory recovery', pass: code === 'EBUSY' });
    void disk.closeVfs();
    const memory = new OpfsVfs(name, { bufferMode: 'memory' });
    await memory.ready;
    void memory.closeVfs();
  }
  // Step 2: after recovery, reopen in disk mode and write much-newer data.
  {
    const vfs = new OpfsVfs(name, { bufferMode: 'disk', localDurabilityMode: 'relaxed' });
    await vfs.ready;
    // The stale WAL targeted /m.bin's inode with [10,20,30,40]; overwrite with a
    // clearly-newer value and flush durably.
    const fd = vfs.openSync('/m.bin', RDWR_CREATE);
    vfs.writeSync(fd, new Uint8Array([99, 98, 97, 96]), 0);
    vfs.closeSync(fd);
    vfs.flushVfs();
    const dataLogSize = (vfs as unknown as { dataLogHandle: { getSize(): number } }).dataLogHandle.getSize();
    checks.push({
      check: 'INT-7 memory recovery left an empty data WAL for disk mode',
      pass: dataLogSize === 0,
      detail: `dataLogSize=${dataLogSize}`,
    });
    void vfs.closeVfs();
  }

  // Step 3: reopen in MEMORY mode again. The ancient WAL must NOT replay over
  // the newer disk-mode data — /m.bin must read [99,98,97,96], not [10,20,30,40].
  {
    const vfs = new OpfsVfs(name, { bufferMode: 'memory', localDurabilityMode: 'relaxed' });
    await vfs.ready;
    const fd = vfs.openSync('/m.bin', OpenFlags.O_RDONLY);
    const { buffer: buf } = vfs.readSync(fd, 4, 0);
    vfs.closeSync(fd);
    checks.push({
      check: 'INT-7 stale memory-mode WAL does not rewind disk-mode data',
      pass: eq(buf, new Uint8Array([99, 98, 97, 96])),
      detail: `read=${[...buf].join(',')}`,
    });
    void vfs.closeVfs();
  }

  return checks;
}

// ── INT-8: init failure must not leak acquired handles ──────────────────────

async function int8(): Promise<Check[]> {
  const checks: Check[] = [];
  const name = uniqueName('int8');

  // Force an acquisition failure mid-way (2nd handle: metaA). The data handle
  // was acquired and must be closed before init rethrows, or it stays exclusively
  // locked and blocks a retry.
  let initThrew = false;
  try {
    const vfs = new OpfsVfs(name, {
      bufferMode: 'disk',
      _wrapSyncAccessHandle: acquireFailHook(2),
    });
    await vfs.ready;
  } catch {
    initThrew = true;
  }
  checks.push({ check: 'INT-8 init failure propagates', pass: initThrew });

  // The proof of no-leak: a CLEAN remount of the same db (default exclusive
  // handles) must succeed. If init had leaked the earlier exclusive handles,
  // this second createSyncAccessHandle would throw "already locked".
  let remountOk = false;
  try {
    const vfs = new OpfsVfs(name, { bufferMode: 'disk' });
    await vfs.ready;
    remountOk = true;
    void vfs.closeVfs();
  } catch {
    remountOk = false;
  }
  checks.push({
    check: 'INT-8 clean remount after init failure (no leaked locked handles)',
    pass: remountOk,
  });

  // INT-8 follow-up: a failure in a POST-acquisition init step (all handles
  // acquired, then a read throws) must ALSO release every handle. Seed a real db
  // first so init has a populated snapshot and meta log to read.
  const name2 = uniqueName('int8b');
  const options: OpfsVfsOptions = {
    bufferMode: 'disk',
  };
  {
    const seed = new OpfsVfs(name2, options);
    await seed.ready;
    const fd = seed.openSync('/seed.bin', RDWR_CREATE);
    seed.writeSync(fd, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0);
    seed.closeSync(fd);
    seed.syncSync();
    void seed.closeVfs();
  }

  let postAcqThrew = false;
  let failedInitVfs: OpfsVfs | undefined;
  try {
    failedInitVfs = new OpfsVfs(name2, {
      ...options,
      _wrapSyncAccessHandle: readFailHook('metaLog'),
    });
    await failedInitVfs.ready;
  } catch {
    postAcqThrew = true;
  }
  checks.push({ check: 'INT-8 post-acquisition init failure propagates', pass: postAcqThrew });
  let failedInitCloseSafe = true;
  try {
    void failedInitVfs?.closeVfs();
    void failedInitVfs?.closeVfs();
  } catch {
    failedInitCloseSafe = false;
  }
  const failedInitState = failedInitVfs as unknown as { closed: boolean } | undefined;
  checks.push({
    check: 'INT-8 close after failed init is idempotent',
    pass: failedInitCloseSafe && failedInitState?.closed === true,
    detail: `closeSafe=${failedInitCloseSafe} closed=${failedInitState?.closed}`,
  });

  let remount2Ok = false;
  try {
    const vfs = new OpfsVfs(name2, options);
    await vfs.ready;
    remount2Ok = true;
    void vfs.closeVfs();
  } catch {
    remount2Ok = false;
  }
  checks.push({
    check: 'INT-8 clean remount after post-acquisition init failure (no leaked handles)',
    pass: remount2Ok,
  });

  const name3 = uniqueName('int8c');
  let wrapFailed = false;
  try {
    const vfs = new OpfsVfs(name3, {
      bufferMode: 'disk',
      _wrapSyncAccessHandle: wrapThrowHook('metaLog'),
    });
    await vfs.ready;
  } catch {
    wrapFailed = true;
  }
  checks.push({ check: 'meta-log wrap failure aborts init', pass: wrapFailed });

  let remount3Ok = false;
  try {
    const vfs = new OpfsVfs(name3, { bufferMode: 'disk' });
    await vfs.ready;
    remount3Ok = true;
    void vfs.closeVfs();
  } catch {
    remount3Ok = false;
  }
  checks.push({ check: 'clean remount after meta-log wrap failure', pass: remount3Ok });

  return checks;
}

// ── First mount: durable empty-root baseline before ready ───────────────────

async function firstMountBaseline(): Promise<Check[]> {
  const checks: Check[] = [];
  const options: OpfsVfsOptions = {
    bufferMode: 'disk',
    localDurabilityMode: 'strict',
  };

  const exerciseBootstrapFault = async (prefix: string, hook: NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']>) => {
    const faultName = uniqueName(prefix);
    let failedInit: OpfsVfs | undefined;
    let initThrew = false;
    try {
      failedInit = new OpfsVfs(faultName, { ...options, _wrapSyncAccessHandle: hook });
      await failedInit.ready;
    } catch {
      initThrew = true;
    }
    void failedInit?.closeVfs();

    let retryOk = false;
    let markerReady = false;
    try {
      const retry = new OpfsVfs(faultName, options);
      await retry.ready;
      retryOk = retry.existsSync('/') && retry.readdirNamesSync('/').length === 0;
      markerReady = (retry as unknown as { firstMountMarkerState(): number | null }).firstMountMarkerState() === 2;
      void retry.closeVfs();
    } catch {
      retryOk = false;
    }
    return { initThrew, retryOk, markerReady };
  };

  // Marker and first snapshot writes must not advance on a short write. The
  // baseline itself has no older A/B slot, so both pre-ready states must retry.
  const shortMarker = await exerciseBootstrapFault('first-mount-short-marker', stalledShortWriteHook('bootstrap'));
  checks.push({
    check: 'short first-mount marker fails before snapshot and retries cleanly',
    pass: shortMarker.initThrew && shortMarker.retryOk && shortMarker.markerReady,
  });
  const shortSnapshot = await exerciseBootstrapFault('first-mount-short-snapshot', stalledShortWriteHook('metaB'));
  checks.push({
    check: 'short first baseline preserves intent and retries cleanly',
    pass: shortSnapshot.initThrew && shortSnapshot.retryOk && shortSnapshot.markerReady,
  });

  // Snapshot+log may both be durable while the ACTIVE intent is still present.
  // That exact branch must normalize the log and retire the marker on retry.
  const staleIntent = await exerciseBootstrapFault('first-mount-stale-intent', failNthMutationHook('bootstrap', 4));
  checks.push({
    check: 'durable baseline with stale ACTIVE intent retires on retry',
    pass: staleIntent.initThrew && staleIntent.retryOk && staleIntent.markerReady,
  });

  // Restoring a previously captured ACTIVE frame after ready must not turn it
  // into authority over the real meta log. Replay committed log records first,
  // then retire the stale intent.
  const restoredIntentName = uniqueName('restored-active-with-live-log');
  let restoredActiveLogSurvives = false;
  try {
    const interrupted = new OpfsVfs(restoredIntentName, {
      ...options,
      _wrapSyncAccessHandle: failNthMutationHook('bootstrap', 4),
    });
    let interruptedThrew = false;
    try {
      await interrupted.ready;
    } catch {
      // Expected: ACTIVE is durable, as are the baseline snapshot and log stamp.
      interruptedThrew = true;
    }
    void interrupted.closeVfs();
    const capturedActive = await readSidecar(restoredIntentName, '.bootstrap');
    const capturedState = capturedActive.byteLength >= 12 ? new DataView(capturedActive.buffer).getUint32(8, true) : 0;

    const adopted = new OpfsVfs(restoredIntentName, options);
    await adopted.ready;
    void adopted.closeVfs();

    const withLog = new OpfsVfs(restoredIntentName, options);
    await withLog.ready;
    const logOnlyFd = withLog.openSync('/log-only.bin', RDWR_CREATE);
    withLog.closeSync(logOnlyFd);
    withLog.syncSync();
    simulateCrashClose(withLog);

    await overwriteSidecar(restoredIntentName, '.bootstrap', capturedActive);
    const recovered = new OpfsVfs(restoredIntentName, options);
    await recovered.ready;
    restoredActiveLogSurvives =
      interruptedThrew &&
      capturedState === 1 &&
      recovered.existsSync('/log-only.bin') &&
      (recovered as unknown as { firstMountMarkerState(): number | null }).firstMountMarkerState() === 2;
    void recovered.closeVfs();
  } catch {
    restoredActiveLogSurvives = false;
  }
  checks.push({
    check: 'restored ACTIVE frame preserves and replays committed meta-log records',
    pass: restoredActiveLogSurvives,
  });

  // A completed mount retains a framed READY tombstone, not an ACTIVE intent.
  // Even if every other empty-data recovery artifact is later damaged, invalid
  // A/B slots must remain fail-stop instead of being reset as bootstrap state.
  const damagedName = uniqueName('post-ready-corruption');
  const completed = new OpfsVfs(damagedName, options);
  await completed.ready;
  const completedMarkerReady =
    (completed as unknown as { firstMountMarkerState(): number | null }).firstMountMarkerState() === 2;
  completed.mkdirSync('/precious-empty-directory');
  completed.syncSync();
  void completed.closeVfs();
  const corrupt = new Uint8Array([0xba, 0xd0, 0xc0, 0xde]);
  await overwriteSidecar(damagedName, '.meta.a', corrupt);
  await overwriteSidecar(damagedName, '.meta.b', corrupt);
  for (const suffix of ['.meta', '.meta.log', '.data.log', '.bitmap']) {
    await overwriteSidecar(damagedName, suffix);
  }
  let postReadyFailedStop = false;
  try {
    const damaged = new OpfsVfs(damagedName, options);
    await damaged.ready;
    void damaged.closeVfs();
  } catch (error) {
    postReadyFailedStop = error instanceof Error && error.name === 'MetaSnapshotCorruptionError';
  }
  checks.push({
    check: 'post-ready empty-data snapshot damage remains fail-stop',
    pass: completedMarkerReady && postReadyFailedStop,
  });

  // Now kill the first application commit after data has flushed but before its
  // metadata-log record lands. The durable baseline must remain mountable.
  const name = uniqueName('first-mount-application-commit');
  const fault: FailingState = { armed: false, closed: new Set<SyncAccessHandleTag>() };
  const vfs = new OpfsVfs(name, {
    ...options,
    _wrapSyncAccessHandle: failingHook('metaLog', fault),
  });
  await vfs.ready;
  const internals = vfs as unknown as {
    metaHandleA: { getSize(): number };
    metaHandleB: { getSize(): number };
    dataHandle: { getSize(): number };
  };
  const baselineBytes = internals.metaHandleA.getSize() + internals.metaHandleB.getSize();
  checks.push({
    check: 'fresh disk mount persists an empty-root snapshot before ready',
    pass: baselineBytes > 0,
    detail: `snapshotBytes=${baselineBytes}`,
  });

  const interruptedBytes = new Uint8Array([11, 22, 33, 44]);
  const interruptedFd = vfs.openSync('/interrupted.bin', RDWR_CREATE);
  vfs.writeSync(interruptedFd, interruptedBytes, 0);
  vfs.closeSync(interruptedFd);
  fault.armed = true;
  let firstCommitThrew = false;
  try {
    vfs.syncSync();
  } catch {
    firstCommitThrew = true;
  }
  const durableDataBytes = internals.dataHandle.getSize();
  checks.push({
    check: 'first application commit faults after data but before metadata',
    pass: firstCommitThrew && fault.injected === true && durableDataBytes > 0,
    detail: `threw=${firstCommitThrew} injected=${fault.injected === true} dataBytes=${durableDataBytes}`,
  });
  simulateCrashClose(vfs);

  const probeBytes = new Uint8Array([9, 8, 7, 6, 5]);
  let crashRemountOk = false;
  try {
    const reopened = new OpfsVfs(name, options);
    await reopened.ready;
    crashRemountOk =
      reopened.existsSync('/') &&
      reopened.readdirNamesSync('/').length === 0 &&
      !reopened.existsSync('/interrupted.bin');
    const probeFd = reopened.openSync('/probe.bin', RDWR_CREATE);
    reopened.writeSync(probeFd, probeBytes, 0);
    reopened.closeSync(probeFd);
    reopened.syncSync();
    void reopened.closeVfs();
  } catch {
    crashRemountOk = false;
  }
  checks.push({
    check: 'first-commit crash remounts the durable empty baseline',
    pass: crashRemountOk,
  });

  let secondRemountOk = false;
  try {
    const final = new OpfsVfs(name, options);
    await final.ready;
    const probeFd = final.openSync('/probe.bin', OpenFlags.O_RDONLY);
    const { buffer, read } = final.readSync(probeFd, probeBytes.byteLength);
    final.closeSync(probeFd);
    secondRemountOk = read === probeBytes.byteLength && eq(buffer.subarray(0, read), probeBytes);
    void final.closeVfs();
  } catch {
    secondRemountOk = false;
  }
  checks.push({
    check: 'recovered baseline accepts a new commit and clean second remount',
    pass: secondRemountOk,
  });
  return checks;
}

const RUNNERS: Record<string, () => Promise<Check[]>> = {
  int6,
  int7,
  int8,
  firstMountBaseline,
};

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
    await Promise.all(volumes.map(deleteVolume));
    self.postMessage({ type: 'RESULT', results });
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error instanceof Error ? error.message : String(error) });
  }
};

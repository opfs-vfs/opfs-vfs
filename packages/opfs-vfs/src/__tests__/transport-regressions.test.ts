import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpfsVfsPGliteAdapter, type VfsSyncApi } from '../adapter';
import { OpfsVfsWorker } from '../index_internal';
import { SyncMessenger } from '../sync-messenger';
import { deleteVolume } from '../volume-files';
import type { OpfsVfsWorkerClient } from '../worker-client';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('transport did not reach the expected state');
    await sleep(5);
  }
}

type Internals = {
  worker: Worker | null;
  messenger: SyncMessenger;
  _spawnWorkerInner(): Promise<void>;
  beginLeaderShutdown(interrupt?: boolean): Promise<void>;
};
const internal = (vfs: OpfsVfsWorkerClient) => vfs as unknown as Internals;
const volume = (label: string) => `transport-${label}-${crypto.randomUUID()}.bin`;

/** Runs one blocking SyncMessenger.call() in a worker and reports how it settled. */
function callFromWorker(sab: SharedArrayBuffer, cmd: string, options?: { timeoutMs?: number }) {
  const worker = new Worker(new URL('./sync-messenger-caller-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<{ type: string; message?: string; code?: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('caller stayed blocked'));
    }, 5_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`worker error: ${event.message}`));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'READY') {
        worker.postMessage({ type: 'CALL', id: 1, cmd, payload: {}, options });
        return;
      }
      clearTimeout(timer);
      worker.terminate();
      resolve(data);
    };
    worker.postMessage({ type: 'INIT', sab });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('follower relay payloads', () => {
  it('relays only the written window of a view and accepts shared memory', async () => {
    const name = volume('relay-window');
    const leader = new OpfsVfsWorker(name);
    await leader.ready;
    const follower = new OpfsVfsWorker(name);
    const tap = new BroadcastChannel(`opfs-vfs-${name}`);
    const relayed: Uint8Array[] = [];
    tap.onmessage = ({ data }) => {
      if (data?.type === 'COMMAND' && data.payload?.type === 'WRITE') relayed.push(data.data);
    };
    try {
      await follower.ready;
      expect(follower.getStatus().role).toBe('follower');
      const fd = await follower.open('/window', true);

      const parent = new Uint8Array(1024 * 1024);
      const view = parent.subarray(16, 21);
      view.set([1, 2, 3, 4, 5]);
      expect(await follower.write(fd, view, 0)).toBe(5);
      await waitFor(() => relayed.length === 1);
      // The message carries five bytes, not a megabyte clone of the caller's buffer.
      expect(relayed[0]!.buffer.byteLength).toBe(5);
      expect(parent.byteLength).toBe(1024 * 1024);

      const shared = new Uint8Array(new SharedArrayBuffer(64));
      shared.set([9, 8, 7], 8);
      expect(await follower.write(fd, shared.subarray(8, 11), 5)).toBe(3);
      await waitFor(() => relayed.length === 2);
      expect(relayed[1]!.buffer).toBeInstanceOf(ArrayBuffer);

      const { buffer } = await follower.read(fd, 8, 0);
      expect([...buffer]).toEqual([1, 2, 3, 4, 5, 9, 8, 7]);
      await follower.close(fd);
    } finally {
      tap.close();
      follower.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
      await deleteVolume(name).catch(() => {});
    }
  });
});

describe('takeover mount', () => {
  it('retries a promoted follower mount while the previous owner still holds the volume', async () => {
    const name = volume('takeover-busy');
    const leader = new OpfsVfsWorker(name);
    await leader.ready;
    const follower = new OpfsVfsWorker(name);
    let release: (() => void) | undefined;
    let holding: Promise<unknown> | undefined;
    try {
      await follower.ready;
      await follower.mkdir('/kept');
      const spawn = vi.spyOn(internal(follower), '_spawnWorkerInner');
      // Stand in for the old worker's teardown: this request queues behind the owner's volume lock and
      // keeps it after the owner closes, so the promoted follower's first mount is refused with EBUSY.
      holding = navigator.locks.request(`opfs-vfs-volume-${name}`, async () => {
        await new Promise<void>((resolve) => (release = resolve));
      });
      await leader.closeVfs();
      await waitFor(() => release !== undefined);
      await waitFor(() => spawn.mock.calls.length >= 2);
      expect(follower.getStatus().state).not.toBe('failed');
      release!();
      await holding;
      await waitFor(() => follower.getStatus().state === 'ready' && follower.getStatus().role === 'leader');
      expect((await follower.stat('/kept')).is_dir).toBe(true);
    } finally {
      release?.();
      await holding;
      await follower.closeVfs().catch(() => follower.dispose());
      leader.dispose();
      await deleteVolume(name).catch(() => {});
    }
  });
});

describe('transport deadlines', () => {
  const silentWorker = () => {
    const posted: { type?: string }[] = [];
    const worker = {
      posted,
      postMessage: (message: { type?: string }) => void posted.push(message),
      addEventListener() {},
      removeEventListener() {},
      terminate() {},
      onmessage: null,
      onerror: null,
    };
    return worker;
  };

  it('gives worker startup the initialization timeout, never less than five seconds', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    for (const [initTimeout, expected] of [
      [20_000, 20_000],
      [100, 5_000],
    ]) {
      timers.mockClear();
      const worker = silentWorker();
      const vfs = new OpfsVfsWorker(volume('ping'), {
        forceLeader: true,
        initTimeout,
        worker: () => worker as unknown as Worker,
      });
      try {
        await waitFor(() => worker.posted.some(({ type }) => type === 'PING'));
        expect(timers.mock.calls.map(([, ms]) => ms)).toContain(expected);
        if (expected !== 5_000) expect(timers.mock.calls.map(([, ms]) => ms)).not.toContain(5_000);
      } finally {
        vfs.dispose();
      }
    }
  });

  it('honours a caller-supplied SyncMessenger deadline', async () => {
    const sab = new SharedArrayBuffer(2048 + 64);
    const started = performance.now();
    // Nobody listens on this buffer, so only the deadline can end the call.
    const outcome = await callFromWorker(sab, 'SYNC', { timeoutMs: 50 });
    expect(outcome.type).toBe('CALL_ERROR');
    expect(outcome.message).toContain('did not respond within 0.05s (command: SYNC)');
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  it('keeps a relayed SHUTDOWN_LEADER pending past thirty seconds', async () => {
    const name = volume('shutdown-deadline');
    const leader = new OpfsVfsWorker(name);
    await leader.ready;
    const follower = new OpfsVfsWorker(name);
    await follower.ready;
    let releaseShutdown!: () => void;
    let started!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (releaseShutdown = resolve));
    vi.spyOn(internal(leader), 'beginLeaderShutdown').mockImplementation(async () => {
      started();
      await gate;
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled = false;
      const shutdown = follower
        .shutdownSharedVfs()
        .catch(() => {})
        .finally(() => (settled = true));
      await shutdownStarted;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      releaseShutdown();
      await shutdown;
      expect(follower.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
      releaseShutdown();
      follower.dispose();
      leader.dispose();
      await sleep(20);
      await deleteVolume(name).catch(() => {});
    }
  });
});

describe('oversized synchronous results', () => {
  it('reports a result that exceeds the bridge as EOVERFLOW', async () => {
    const sab = new SharedArrayBuffer(2048 + 64);
    const controller = new AbortController();
    new SyncMessenger(sab).listen(async () => ({ result: 'x'.repeat(5000) }), { signal: controller.signal });
    try {
      const outcome = await callFromWorker(sab, 'READDIR');
      expect(outcome.type).toBe('CALL_ERROR');
      expect(outcome.code).toBe('EOVERFLOW');
      expect(outcome.message).toMatch(/exceeds SAB capacity/);
    } finally {
      controller.abort();
    }
  });

  it('maps EOVERFLOW in the PGlite adapter instead of reporting a missing directory', () => {
    const adapter = new OpfsVfsPGliteAdapter({
      readdirSync() {
        throw Object.assign(new Error('SyncMessenger.listen response header exceeds SAB capacity'), {
          code: 'EOVERFLOW',
        });
      },
    } as unknown as VfsSyncApi);
    expect(() => adapter.readdir('/huge')).toThrow(expect.objectContaining({ code: 61 }));
  });
});

describe('worker boundary validation', () => {
  it('accepts fractional timestamps and rejects ones the volume cannot store', async () => {
    const name = volume('utimes');
    const vfs = new OpfsVfsWorker(name, { forceLeader: true });
    try {
      await vfs.ready;
      const fd = await vfs.open('/stamped', true);
      await vfs.close(fd);
      await vfs.utimes('/stamped', 1_700_000_000_000.5, 1_500.25);
      const stat = await vfs.stat('/stamped');
      expect(stat.atimeMs).toBe(1_700_000_000_000.5);
      expect(stat.mtimeMs).toBe(1_500.25);
      await expect(vfs.utimes('/stamped', 0, -1)).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(vfs.utimes('/stamped', 2 ** 32 * 1000, 0)).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(vfs.utimes('/stamped', Number.NaN, 0)).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(vfs.utimes('/stamped', 0, Number.POSITIVE_INFINITY)).rejects.toMatchObject({ code: 'EINVAL' });
    } finally {
      await vfs.closeVfs().catch(() => vfs.dispose());
      await deleteVolume(name).catch(() => {});
    }
  });
});

describe('unsupported pages', () => {
  it('refuses construction with VFS_UNSUPPORTED when SharedArrayBuffer is unavailable', () => {
    vi.stubGlobal('SharedArrayBuffer', undefined);
    let thrown: unknown;
    try {
      new OpfsVfsWorker(volume('no-sab')).dispose();
    } catch (error) {
      thrown = error;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(thrown).toMatchObject({ code: 'VFS_UNSUPPORTED' });
    expect((thrown as { missing: string[] }).missing).toContain('shared-array-buffer');
  });
});

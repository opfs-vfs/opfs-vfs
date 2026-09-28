import { describe, expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';
import { OpenFlags } from '../opfs-vfs';
import { Status } from '../sync-messenger';
import { OpfsVfsWorkerClient } from '../worker-client';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('worker did not reach expected state');
    await sleep(5);
  }
}

async function boundedRejection(promise: Promise<unknown>) {
  const outcome = promise.then(
    () => ({ resolved: true }),
    (error: unknown) => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      outcome,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('request stayed pending')), 1000);
      }),
    ]);
    expect(result).toHaveProperty('error');
    return (result as { error: unknown }).error;
  } finally {
    clearTimeout(timer);
  }
}

type WorkerInternals = {
  worker: Worker;
  workerReady: Promise<void>;
  leaderReady: boolean;
  generation: string;
  attachmentId: string;
  clientFds: Map<string, Set<number>>;
  clientRequests: Map<string, Set<Promise<unknown>>>;
  clientChecks: Map<string, Promise<boolean>>;
  deadClients: Set<string>;
  pendingOpens: Map<string, { cancelled: boolean }>;
  cancelledRelays: Set<string>;
  spawnWorker(): Promise<void>;
  pendingRequests: Map<number, unknown>;
  channel: BroadcastChannel;
  sendToWorker(type: string, payload: Record<string, unknown>): Promise<unknown>;
};
const internal = (vfs: OpfsVfsWorkerClient) => vfs as unknown as WorkerInternals;

describe('Worker audit regressions', () => {
  for (const blocking of [false, true]) {
    const badFrames = [
      ...['{', 'null', '[]', '{"type":42}', '{}'].map((header) => ({ header, lengths: undefined })),
      { header: '{}', lengths: [-1, 0] },
      { header: '{}', lengths: [2, -1] },
      { header: '{}', lengths: [2049, 0] },
    ];
    for (const { header, lengths } of badFrames) {
      it(`blocking=${blocking}: rejects malformed frame ${header}/${String(lengths)} and serves the next call`, async () => {
        const sab = new SharedArrayBuffer(2112);
        const words = new Int32Array(sab);
        const worker = new Worker(new URL('./sync-messenger-listener-worker.ts', import.meta.url), { type: 'module' });
        const send = (text: string, id: number) => {
          const bytes = new TextEncoder().encode(text);
          new Uint8Array(sab, 64).set(bytes);
          words[1] = id === 1 ? (lengths?.[0] ?? bytes.length) : bytes.length;
          words[2] = id === 1 ? (lengths?.[1] ?? 0) : 0;
          words[3] = id;
          Atomics.store(words, 0, Status.COMMAND);
          Atomics.notify(words, 0);
        };
        try {
          worker.postMessage({ sab, blocking });
          send(header, 1);
          await waitFor(() => Atomics.load(words, 0) === Status.ERROR);
          const error = JSON.parse(new TextDecoder().decode(new Uint8Array(sab, 64, words[1]).slice()));
          expect(error.error).toBeTypeOf('string');
          expect(words[3]).toBe(1);
          Atomics.store(words, 0, Status.IDLE);
          Atomics.notify(words, 0);
          send('{"type":"PING","payload":7}', 2);
          await waitFor(() => Atomics.load(words, 0) === Status.RESULT);
          const response = JSON.parse(new TextDecoder().decode(new Uint8Array(sab, 64, words[1]).slice()));
          expect(response.result).toEqual({ calls: 1, type: 'PING', payload: 7 });
          expect(words[3]).toBe(2);
        } finally {
          worker.terminate();
        }
      }, 6000);
    }
    it(`blocking=${blocking}: reclaims an unknown status without spinning`, async () => {
      const sab = new SharedArrayBuffer(2112);
      const words = new Int32Array(sab);
      Atomics.store(words, 0, 77);
      const worker = new Worker(new URL('./sync-messenger-listener-worker.ts', import.meta.url), { type: 'module' });
      try {
        worker.postMessage({ sab, blocking });
        await waitFor(() => Atomics.load(words, 0) === Status.IDLE, 7000);
      } finally {
        worker.terminate();
      }
    }, 8000);
    it(`blocking=${blocking}: keeps an unconsumed error after a redundant notification`, async () => {
      const sab = new SharedArrayBuffer(2112);
      const words = new Int32Array(sab);
      Atomics.store(words, 0, Status.ERROR);
      const worker = new Worker(new URL('./sync-messenger-listener-worker.ts', import.meta.url), { type: 'module' });
      try {
        const started = new Promise<void>((resolve) => {
          worker.onmessage = () => resolve();
        });
        worker.postMessage({ sab, blocking });
        await started;
        await sleep(20);
        Atomics.notify(words, 0);
        await sleep(20);
        expect(Atomics.load(words, 0)).toBe(Status.ERROR);
      } finally {
        worker.terminate();
      }
    });
  }

  for (const eventType of ['error', 'messageerror']) {
    it(`rejects pending and future calls after worker ${eventType}`, async () => {
      const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
      try {
        await vfs.ready;
        const { worker, pendingRequests } = internal(vfs);
        const send = vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
        const pending = boundedRejection(vfs.stat('/'));
        await waitFor(() => pendingRequests.size === 1);
        worker.dispatchEvent(
          eventType === 'error'
            ? new ErrorEvent('error', { message: 'injected crash' })
            : new MessageEvent('messageerror'),
        );
        expect(await pending).toMatchObject({ code: 'VFS_WORKER_FAILED' });
        expect(pendingRequests.size).toBe(0);
        expect(await boundedRejection(vfs.stat('/'))).toMatchObject({ code: 'VFS_WORKER_FAILED' });
        expect(() => vfs.statSync('/')).toThrowError(expect.objectContaining({ code: 'VFS_WORKER_FAILED' }));
        send.mockRestore();
        await vfs.closeVfs();
      } finally {
        vfs.dispose();
      }
    });
  }

  for (const type of ['STAT', 'ERROR']) {
    it(`clears the deadline after a ${type} response`, async () => {
      const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
      try {
        await vfs.ready;
        const { worker, pendingRequests } = internal(vfs);
        const post = vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
        const terminate = vi.spyOn(worker, 'terminate');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = vfs.stat('/').catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        const id = post.mock.calls[0][0].id;
        worker.dispatchEvent(
          new MessageEvent('message', {
            data: { id, type, result: type === 'ERROR' ? { error: 'injected' } : { is_dir: true } },
          }),
        );
        await pending;
        expect(pendingRequests.size).toBe(0);
        // A cloning failure must also cancel its deadline.
        post.mockRestore();
        await expect(internal(vfs).sendToWorker('STAT', { path: () => {} })).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(30000);
        expect(terminate).not.toHaveBeenCalled();
        expect(internal(vfs).worker).toBe(worker);
      } finally {
        vi.useRealTimers();
        vfs.dispose();
      }
    });
  }

  it('removes a pending request when postMessage throws without killing the worker', async () => {
    const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
    try {
      await vfs.ready;
      await expect(internal(vfs).sendToWorker('STAT', { path: () => {} })).rejects.toThrow();
      expect(internal(vfs).pendingRequests.size).toBe(0);
      expect((await vfs.stat('/')).is_dir).toBe(true);
    } finally {
      await vfs.closeVfs();
    }
  });

  it('rejects synchronous calls until INIT completes', async () => {
    const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
    try {
      expect(() => vfs.statSync('/')).toThrowError(expect.objectContaining({ code: 'VFS_LEADER_NOT_READY' }));
      await vfs.ready;
    } finally {
      vfs.dispose();
    }
  });

  it('rejects readiness when the worker fails during startup', async () => {
    const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
    const ready = boundedRejection(vfs.ready);
    await waitFor(() => internal(vfs).worker !== null);
    internal(vfs).worker.dispatchEvent(new ErrorEvent('error', { message: 'startup crash' }));
    expect(await ready).toMatchObject({ code: 'VFS_WORKER_FAILED' });
    expect(internal(vfs).pendingRequests.size).toBe(0);
    vfs.dispose();
  });

  it('waits for the new worker INIT after an already-ready instance changes workers', async () => {
    const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
    try {
      await vfs.ready;
      const state = internal(vfs);
      state.worker.terminate();
      state.leaderReady = false;
      const started = state.spawnWorker();
      const worker = state.worker;
      const originalPost = worker.postMessage.bind(worker);
      let initMessage: unknown;
      const post = vi.spyOn(worker, 'postMessage').mockImplementation((message) => {
        if (message.type === 'INIT') initMessage = message;
        else originalPost(message);
      });
      await waitFor(() => initMessage !== undefined);
      const request = vfs.stat('/').catch((error: unknown) => error);
      await sleep(20);
      expect(post.mock.calls.some(([message]) => message.type === 'STAT')).toBe(false);
      originalPost(initMessage);
      await started;
      expect(await request).toMatchObject({ is_dir: true });
      post.mockRestore();
    } finally {
      vfs.dispose();
    }
  });

  for (const closing of [false, true]) {
    it(`terminates an unresponsive worker, including shutdown=${closing}`, async () => {
      const vfs = new OpfsVfsWorker(`worker-audit-${crypto.randomUUID()}.bin`, { forceLeader: true });
      try {
        await vfs.ready;
        const { worker, pendingRequests } = internal(vfs);
        const post = vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
        const terminate = vi.spyOn(worker, 'terminate');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const first = vfs.stat('/').catch((error: unknown) => error);
        const second = (closing ? vfs.closeVfs() : vfs.stat('/')).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        // Closing may reject the first request before it is sent, depending on
        // the await-ready continuation; the CLOSE itself must have a deadline.
        expect(pendingRequests.size).toBeGreaterThan(0);
        const id = post.mock.calls.at(-1)![0].id;
        // A close is a durability barrier and gets the longer deadline.
        await vi.advanceTimersByTimeAsync(closing ? 300_000 : 30000);
        const error = await second;
        expect(error).toMatchObject({ code: 'VFS_WORKER_FAILED' });
        expect((error as Error).message).toContain(closing ? 'CLOSE_VFS' : 'STAT');
        expect(await first).toBeInstanceOf(Error);
        expect(pendingRequests.size).toBe(0);
        expect(terminate).toHaveBeenCalledOnce();
        worker.dispatchEvent(new MessageEvent('message', { data: { id, type: 'STAT', result: {} } }));
        await expect(vfs.stat('/')).rejects.toBe(error);
        await vfs.closeVfs();
        expect(terminate).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        vfs.dispose();
      }
    });
  }

  it('joins a ready leader within 500ms without spawning another worker', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      const start = performance.now();
      follower = new OpfsVfsWorker(name);
      await follower.ready;
      expect(performance.now() - start).toBeLessThan(500);
      expect(internal(follower).worker).toBeNull();
      expect((await follower.stat('/')).is_dir).toBe(true);
    } finally {
      follower?.dispose();
      await leader.closeVfs();
    }
  });

  for (const [replyType, replyGeneration] of [
    ['RESPONSE', 'stale'],
    ['RESPONSE_ERROR', undefined],
  ] as const) {
    it(`rejects a ${replyType} with ${replyGeneration ?? 'missing'} generation and cancels an uncertain mutation`, async () => {
      const name = `worker-audit-${crypto.randomUUID()}.bin`;
      const leader = new OpfsVfsWorker(name);
      const follower = new OpfsVfsWorker(name);
      try {
        await Promise.all([leader.ready, follower.ready]);
        const leaderState = internal(leader);
        const followerState = internal(follower);
        const workerPost = vi.spyOn(leaderState.worker, 'postMessage');
        const post = leaderState.channel.postMessage.bind(leaderState.channel);
        let dropped!: (message: { id: number; tabId: string }) => void;
        const responseDropped = new Promise<{ id: number; tabId: string }>((resolve) => (dropped = resolve));
        const ownerPost = vi.spyOn(leaderState.channel, 'postMessage').mockImplementation((message) => {
          if (message.type === 'RESPONSE' && message.tabId === followerState.attachmentId) {
            dropped(message);
          } else post(message);
        });
        const followerPost = vi.spyOn(followerState.channel, 'postMessage');
        try {
          const path = '/one-mutation';
          const result = boundedRejection(follower.mkdir(path));
          const { id, tabId } = await responseDropped;
          followerState.channel.dispatchEvent(
            new MessageEvent('message', {
              data: {
                id,
                tabId,
                type: replyType,
                result: replyType === 'RESPONSE_ERROR' ? { error: 'forged error' } : undefined,
                generation: replyGeneration,
              },
            }),
          );
          expect(await result).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
          expect(followerPost).toHaveBeenCalledWith({ type: 'CANCEL', id, clientId: followerState.attachmentId });
          expect((await leader.stat(path)).is_dir).toBe(true);
          expect(workerPost.mock.calls.filter(([message]) => message.type === 'MKDIR')).toHaveLength(1);
          expect(followerState.pendingRequests.size).toBe(0);
        } finally {
          ownerPost.mockRestore();
          followerPost.mockRestore();
          workerPost.mockRestore();
        }
      } finally {
        follower.dispose();
        await leader.closeVfs();
      }
    });
  }

  it('closes an OPEN when a stale-generation reply makes the follower cancel', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    await Promise.all([leader.ready, follower.ready]);
    const leaderState = internal(leader);
    const followerState = internal(follower);
    const post = leaderState.channel.postMessage.bind(leaderState.channel);
    let fd!: number;
    let dropped!: (message: { id: number; tabId: string }) => void;
    const responseDropped = new Promise<{ id: number; tabId: string }>((resolve) => (dropped = resolve));
    const ownerPost = vi.spyOn(leaderState.channel, 'postMessage').mockImplementation((message) => {
      if (
        message.type === 'RESPONSE' &&
        message.tabId === followerState.attachmentId &&
        typeof message.result === 'number'
      ) {
        fd = message.result;
        dropped(message);
      } else post(message);
    });
    const followerPost = vi.spyOn(followerState.channel, 'postMessage');
    try {
      const result = boundedRejection(follower.open('/stale-open', true));
      const { id, tabId } = await responseDropped;
      expect((await leader.fstat(fd)).is_file).toBe(true);
      followerState.channel.dispatchEvent(
        new MessageEvent('message', {
          data: { id, tabId, type: 'RESPONSE', result: fd, generation: 'stale' },
        }),
      );
      expect(await result).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      expect(followerPost).toHaveBeenCalledWith({ type: 'CANCEL', id, clientId: followerState.attachmentId });
      await vi.waitFor(async () => {
        await expect(leader.fstat(fd)).rejects.toMatchObject({ code: 'EBADF' });
      });
    } finally {
      ownerPost.mockRestore();
      followerPost.mockRestore();
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('rejects an old-generation command before dispatch during takeover', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const next = new OpfsVfsWorker(name);
    const stale = new OpfsVfsWorker(name);
    try {
      await Promise.all([leader.ready, next.ready, stale.ready]);
      const oldGeneration = internal(leader).generation;
      const nextState = internal(next);
      const post = nextState.channel.postMessage.bind(nextState.channel);
      const nextPost = vi.spyOn(nextState.channel, 'postMessage').mockImplementation((message) => {
        if (message.type !== 'LEADER_READY') post(message);
      });
      try {
        await leader.closeVfs();
        await waitFor(() => nextState.worker !== null && nextState.leaderReady);
        expect(nextState.generation).not.toBe(oldGeneration);
        const workerPost = vi.spyOn(nextState.worker, 'postMessage');
        try {
          const result = boundedRejection(stale.mkdir('/stale-mutation'));
          expect(await result).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
          expect(workerPost.mock.calls.filter(([message]) => message.type === 'MKDIR')).toHaveLength(0);
          await expect(next.stat('/stale-mutation')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          workerPost.mockRestore();
        }
      } finally {
        nextPost.mockRestore();
      }
    } finally {
      stale.dispose();
      next.dispose();
      leader.dispose();
    }
  });

  it('does not dispatch a relayed mutation if the generation changes while waiting for the worker', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    try {
      await Promise.all([leader.ready, follower.ready]);
      const state = internal(leader);
      const originalReady = state.workerReady;
      const originalGeneration = state.generation;
      let release!: () => void;
      state.workerReady = new Promise<void>((resolve) => (release = resolve));
      const workerPost = vi.spyOn(state.worker, 'postMessage');
      try {
        const result = boundedRejection(follower.mkdir('/generation-window'));
        await waitFor(() => state.clientRequests.get(internal(follower).attachmentId)?.size === 1);
        state.generation = crypto.randomUUID();
        release();
        expect(await result).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
        expect(workerPost.mock.calls.filter(([message]) => message.type === 'MKDIR')).toHaveLength(0);
        await expect(leader.stat('/generation-window')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        state.generation = originalGeneration;
        state.workerReady = originalReady;
        release();
        workerPost.mockRestore();
      }
    } finally {
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('keeps a follower pending until the leader completes INIT', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const originalPost = Worker.prototype.postMessage;
    let releaseInit: (() => void) | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      options,
    ) {
      if (message.type === 'INIT') {
        releaseInit = () => originalPost.call(this, message, options as StructuredSerializeOptions);
      } else {
        originalPost.call(this, message, options as StructuredSerializeOptions);
      }
    });
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    let followerReady = false;
    const ready = follower.ready.then(() => {
      followerReady = true;
    });
    try {
      await waitFor(() => releaseInit !== undefined);
      await sleep(50);
      expect(followerReady).toBe(false);
      expect(internal(follower).worker).toBeNull();
      post.mockRestore();
      releaseInit!();
      await Promise.all([leader.ready, ready]);
      expect((await follower.stat('/')).is_dir).toBe(true);
    } finally {
      post.mockRestore();
      follower.dispose();
      leader.dispose();
    }
  });

  it('cancels a timed-out follower before it can acquire the leader lock', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    let releaseLock: (() => void) | undefined;
    const held = navigator.locks.request(
      `opfs-vfs-lock-${name}`,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    await waitFor(() => releaseLock !== undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const follower = new OpfsVfsWorker(name, { debug: true, initTimeout: 50 });
    const close = vi.spyOn(internal(follower).channel, 'close');
    try {
      await expect(follower.ready).rejects.toThrow('VFS Initialization Timeout');
      expect(close).toHaveBeenCalledOnce();
      const records = info.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string' && line.startsWith('[opfs-vfs:diag] '))
        .map((line) => JSON.parse(line.slice('[opfs-vfs:diag] '.length)) as Record<string, unknown>);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'owner-lock-requested' }),
          expect.objectContaining({ event: 'leader-ping-sent' }),
          expect.objectContaining({ event: 'initialization-timeout', detail: 'VFS_INITIALIZATION_TIMEOUT' }),
          expect.objectContaining({ event: 'terminal-dispose', detail: 'failed' }),
        ]),
      );
      expect(JSON.stringify(records)).not.toContain(name);
      releaseLock!();
      await held;
      // A subsequent acquisition also waits for any incorrectly queued leader.
      await navigator.locks.request(`opfs-vfs-lock-${name}`, () => {});
      expect(internal(follower).worker).toBeNull();
      expect(internal(follower).pendingRequests.size).toBe(0);
    } finally {
      releaseLock!();
      follower.dispose();
      await held;
      info.mockRestore();
    }
  });

  it('emits payload-free debug handshake traces and removes debug listeners on disposal', async () => {
    const name = `diagnostic-secret-${crypto.randomUUID()}.bin`;
    const note = '/diagnostic-secret-note.txt';
    const contents = 'diagnostic-secret-contents';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const removePageListener = vi.spyOn(globalThis, 'removeEventListener');
    let leader: OpfsVfsWorker | undefined;
    let follower: OpfsVfsWorker | undefined;
    try {
      leader = new OpfsVfsWorker(name, { debug: true });
      await leader.ready;
      follower = new OpfsVfsWorker(name, { debug: true });
      await follower.ready;
      await follower.writeFileBuffer(note, new TextEncoder().encode(contents));
      await follower.sync();

      const records = info.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string' && line.startsWith('[opfs-vfs:diag] '))
        .map((line) => JSON.parse(line.slice('[opfs-vfs:diag] '.length)) as Record<string, unknown>);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record).toMatchObject({
          at: expect.any(String),
          elapsedMs: expect.any(Number),
          client: expect.any(String),
          event: expect.any(String),
          role: expect.any(String),
          state: expect.any(String),
          visibility: expect.any(String),
        });
        expect(Object.hasOwn(record, 'ownerGeneration')).toBe(true);
      }
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'leader-ping-sent' }),
          expect.objectContaining({ event: 'leader-ping-received' }),
          expect.objectContaining({ event: 'leader-ready-sent' }),
          expect.objectContaining({ event: 'leader-ready-received', ownerGeneration: expect.any(String) }),
          expect.objectContaining({ event: 'follower-client-lock-requested' }),
          expect.objectContaining({ event: 'follower-client-lock-acquired' }),
          expect.objectContaining({ event: 'client-created', userAgent: expect.any(String) }),
        ]),
      );
      const readySent = records.find((record) => record.event === 'leader-ready-sent');
      const readyReceived = records.find((record) => record.event === 'leader-ready-received');
      expect(readySent?.ownerGeneration).toEqual(expect.any(String));
      expect(readyReceived?.ownerGeneration).toBe(readySent?.ownerGeneration);
      expect(JSON.stringify(records)).not.toContain(name);
      expect(JSON.stringify(records)).not.toContain(note);
      expect(JSON.stringify(records)).not.toContain(contents);

      follower.dispose();
      leader.dispose();
      expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(removeDocumentListener).toHaveBeenCalledWith('freeze', expect.any(Function));
      expect(removePageListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    } finally {
      follower?.dispose();
      leader?.dispose();
      info.mockRestore();
      removeDocumentListener.mockRestore();
      removePageListener.mockRestore();
    }
  });

  it('emits no diagnostic lines with debug off', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const silent = new OpfsVfsWorker(`silent-${crypto.randomUUID()}.bin`, { forceLeader: true });
    try {
      await silent.ready;
      silent.dispose();
      await sleep(0);
      expect(info.mock.calls.some(([line]) => typeof line === 'string' && line.startsWith('[opfs-vfs:diag] '))).toBe(
        false,
      );
    } finally {
      silent.dispose();
      info.mockRestore();
    }
  });

  it('rejects an in-flight follower request on disposal and removes its listener', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(name);
      await follower.ready;
      const send = vi.spyOn(internal(leader).worker, 'postMessage').mockImplementation(() => {});
      const remove = vi.spyOn(internal(follower).channel, 'removeEventListener');
      const pending = boundedRejection(follower.stat('/'));
      await sleep(20);
      follower.dispose();
      expect(await pending).toBeInstanceOf(Error);
      expect(remove).toHaveBeenCalled();
      send.mockRestore();
    } finally {
      follower?.dispose();
      leader.dispose();
    }
  });

  for (const method of ['dispose', 'closeVfs'] as const) {
    it(`closes only the ${method} follower's descriptors`, async () => {
      const name = `worker-audit-${crypto.randomUUID()}.bin`;
      const leader = new OpfsVfsWorker(name);
      const first = new OpfsVfsWorker(name);
      const second = new OpfsVfsWorker(name);
      try {
        await Promise.all([leader.ready, first.ready, second.ready]);
        const [firstFd, closedFd] = await Promise.all([first.open('/first', true), first.open('/closed', true)]);
        const secondFd = await second.open('/second', true);
        expect(internal(leader).clientFds.get(internal(first).attachmentId)?.has(firstFd)).toBe(true);
        expect(internal(leader).clientFds.get(internal(second).attachmentId)?.has(secondFd)).toBe(true);
        await first.close(closedFd);
        expect(internal(leader).clientFds.get(internal(first).attachmentId)?.has(closedFd)).toBe(false);
        if (method === 'dispose') first.dispose();
        else await first.closeVfs();
        await vi.waitFor(() => expect(internal(leader).clientFds.has(internal(first).attachmentId)).toBe(false));
        await expect(leader.fstat(firstFd)).rejects.toMatchObject({ code: 'EBADF' });
        expect(await second.fstat(secondFd)).toMatchObject({ is_file: true });
      } finally {
        first.dispose();
        second.dispose();
        await leader.closeVfs();
      }
    });
  }

  it('lets follower cleanup wait behind a long worker command', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    await Promise.all([leader.ready, follower.ready]);
    const fd = await follower.open('/cleanup', true);
    const state = internal(leader);
    const post = state.worker.postMessage.bind(state.worker);
    const queued: unknown[] = [];
    let syncQueued!: () => void;
    let closeQueued!: () => void;
    const syncSent = new Promise<void>((resolve) => (syncQueued = resolve));
    const closeSent = new Promise<void>((resolve) => (closeQueued = resolve));
    const send = vi.spyOn(state.worker, 'postMessage').mockImplementation((message) => {
      if (message.type === 'SYNC' || message.type === 'CLOSE') {
        queued.push(message);
        if (message.type === 'SYNC') syncQueued();
        else closeQueued();
      } else post(message);
    });
    const terminate = vi.spyOn(state.worker, 'terminate');
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const synced = leader.sync().then(
        () => true,
        () => false,
      );
      await syncSent;
      follower.dispose();
      await closeSent;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(terminate).not.toHaveBeenCalled();
      expect(state.pendingRequests.size).toBe(2);
      vi.useRealTimers();
      send.mockRestore();
      for (const message of queued) post(message);
      expect(await synced).toBe(true);
      await waitFor(() => !state.clientFds.has(internal(follower).attachmentId));
      await expect(leader.fstat(fd)).rejects.toMatchObject({ code: 'EBADF' });
      expect((await leader.stat('/')).is_dir).toBe(true);
    } finally {
      vi.useRealTimers();
      send.mockRestore();
      terminate.mockRestore();
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('rejects queued OPENs during and after follower cleanup and closes an in-flight OPEN', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    await Promise.all([leader.ready, follower.ready]);
    const state = internal(leader);
    const clientId = internal(follower).attachmentId;
    const send = state.sendToWorker.bind(leader);
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => (releaseOpen = resolve));
    let lateFd: number | undefined;
    const mock = vi.spyOn(state, 'sendToWorker').mockImplementation(async (type, payload) => {
      if (type !== 'OPEN') return send(type, payload);
      await gate;
      lateFd = (await send(type, payload)) as number;
      return lateFd;
    });
    const replies = vi.spyOn(state.channel, 'postMessage');
    try {
      const pending = follower.open('/in-flight', true).catch((error: unknown) => error);
      await waitFor(() => mock.mock.calls.length === 1);
      follower.dispose();
      expect(await pending).toBeInstanceOf(Error);
      await waitFor(() => state.deadClients.has(clientId));
      const rejectQueuedOpen = async (id: number) => {
        // Deliver an already-queued command even though the follower channel is closed.
        state.channel.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'COMMAND',
              id,
              clientId,
              tabId: clientId,
              generation: state.generation,
              payload: { type: 'OPEN', payload: { path: '/queued', flags: OpenFlags.O_CREAT | OpenFlags.O_RDWR } },
            },
          }),
        );
        await vi.waitFor(() =>
          expect(replies).toHaveBeenCalledWith({
            id,
            tabId: clientId,
            generation: state.generation,
            type: 'RESPONSE_ERROR',
            result: expect.objectContaining({ code: 'VFS_ATTACHMENT_LOST' }),
          }),
        );
        expect(mock.mock.calls.filter(([type]) => type === 'OPEN')).toHaveLength(1);
      };
      await rejectQueuedOpen(1000);
      releaseOpen();
      await waitFor(() => !state.clientFds.has(clientId));
      expect(lateFd).toBeTypeOf('number');
      await expect(leader.fstat(lateFd!)).rejects.toMatchObject({ code: 'EBADF' });
      expect(state.deadClients.size).toBe(0);
      expect(state.clientRequests.size).toBe(0);
      expect(state.clientChecks.size).toBe(0);
      await rejectQueuedOpen(1001);
      expect(state.clientFds.size).toBe(0);
      expect(state.deadClients.size).toBe(0);
      expect(state.clientChecks.size).toBe(0);
    } finally {
      releaseOpen();
      mock.mockRestore();
      replies.mockRestore();
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('keeps a late OPEN cancelled when unmatched cancellations overflow', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    await Promise.all([leader.ready, follower.ready]);
    const state = internal(leader);
    const send = state.sendToWorker.bind(leader);
    let releaseOpen!: () => void;
    let started!: () => void;
    const openStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (releaseOpen = resolve));
    let lateFd: number | undefined;
    const mock = vi.spyOn(state, 'sendToWorker').mockImplementation(async (type, payload) => {
      if (type !== 'OPEN') return send(type, payload);
      started();
      await gate;
      lateFd = (await send(type, payload)) as number;
      return lateFd;
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = follower.open('/late', true).catch((error: unknown) => error);
      await openStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ code: 'LEADER_RESPONSE_TIMEOUT' });
      vi.useRealTimers();
      await waitFor(() => [...state.pendingOpens.values()].some((opening) => opening.cancelled));
      for (let id = 1000; id < 2025; id++) {
        state.channel.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'CANCEL', id, clientId: internal(follower).attachmentId },
          }),
        );
      }
      expect(state.cancelledRelays.size).toBe(1024);
      releaseOpen();
      await vi.waitFor(() => expect(lateFd).toBeTypeOf('number'));
      await vi.waitFor(async () => {
        await expect(leader.fstat(lateFd!)).rejects.toMatchObject({ code: 'EBADF' });
      });
      expect(state.clientFds.get(internal(follower).attachmentId)?.size).toBe(0);
      expect(state.pendingOpens.size).toBe(0);
    } finally {
      vi.useRealTimers();
      releaseOpen();
      mock.mockRestore();
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('closes a completed OPEN when its response is lost and the follower cancels', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    await Promise.all([leader.ready, follower.ready]);
    const state = internal(leader);
    const post = state.channel.postMessage.bind(state.channel);
    let fd!: number;
    let responseDropped!: () => void;
    const droppedResponse = new Promise<void>((resolve) => (responseDropped = resolve));
    const drop = vi.spyOn(state.channel, 'postMessage').mockImplementation((message) => {
      if (message.type === 'RESPONSE' && typeof message.result === 'number') {
        fd = message.result;
        responseDropped();
      } else post(message);
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = follower.open('/lost-response', true).catch((error: unknown) => error);
      await droppedResponse;
      expect((await leader.fstat(fd)).is_file).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ code: 'LEADER_RESPONSE_TIMEOUT' });
      vi.useRealTimers();
      await vi.waitFor(async () => {
        await expect(leader.fstat(fd)).rejects.toMatchObject({ code: 'EBADF' });
      });
      expect(state.clientFds.get(internal(follower).attachmentId)?.size).toBe(0);
    } finally {
      vi.useRealTimers();
      drop.mockRestore();
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('keeps a relayed SYNC pending past five seconds', async () => {
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    const follower = new OpfsVfsWorker(name);
    await Promise.all([leader.ready, follower.ready]);
    const state = internal(leader);
    let releaseSync!: () => void;
    let started!: () => void;
    const syncStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (releaseSync = resolve));
    const mock = vi.spyOn(state, 'sendToWorker').mockImplementation(async (type) => {
      if (type !== 'SYNC') throw new Error(`Unexpected ${type}`);
      started();
      await gate;
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled = false;
      const sync = follower.sync().finally(() => (settled = true));
      await syncStarted;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      releaseSync();
      await sync;
    } finally {
      vi.useRealTimers();
      releaseSync();
      mock.mockRestore();
      follower.dispose();
      await leader.closeVfs();
    }
  });

  it('rejects old descriptors after failover until a fresh OPEN reuses the number', async () => {
    class FixedFdWorker extends Worker {
      constructor() {
        super(new URL('./fixed-fd-worker.ts', import.meta.url), { type: 'module' });
      }
    }
    const name = `worker-audit-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorkerClient(name, {}, () => new FixedFdWorker());
    const next = new OpfsVfsWorkerClient(name, {}, () => new FixedFdWorker());
    const stale = new OpfsVfsWorkerClient(name, {}, () => new FixedFdWorker());
    try {
      await Promise.all([leader.ready, next.ready, stale.ready]);
      const promotedFd = await next.open('/promoted-old', true);
      const fd = await stale.open('/old', true);
      const oldGeneration = internal(leader).generation;
      await leader.closeVfs();
      await waitFor(() => internal(next).worker !== null && internal(next).leaderReady);
      expect(internal(next).generation).not.toBe(oldGeneration);
      await expect(stale.fstat(fd)).rejects.toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      const post = vi.spyOn(internal(next).worker, 'postMessage');
      try {
        await expect(next.fstat(promotedFd)).rejects.toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
        await expect(next.write(promotedFd, new Uint8Array([1]))).rejects.toMatchObject({
          code: 'VFS_ATTACHMENT_LOST',
        });
        await expect(next.close(promotedFd)).rejects.toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
        expect(() => next.writeSync(promotedFd, new Uint8Array([1]))).toThrowError(
          expect.objectContaining({ code: 'VFS_ATTACHMENT_LOST' }),
        );
        expect(post).not.toHaveBeenCalled();
      } finally {
        post.mockRestore();
      }
      const freshFd = await next.open('/fresh', true);
      expect(freshFd).toBe(promotedFd);
      expect(await next.write(freshFd, new Uint8Array([2]))).toBe(1);
      expect((await next.fstat(freshFd)).size).toBe(1);
      await next.close(freshFd);
    } finally {
      stale.dispose();
      next.dispose();
      leader.dispose();
    }
  });
});

for (const failure of [false, true]) {
  it(`waits for a delayed shared-shutdown acknowledgement before takeover, failure=${failure}`, async () => {
    const name = `shutdown-ack-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    await leader.ready;
    await leader.mkdir('/kept');
    const request = navigator.locks.request.bind(navigator.locks);
    let acquired!: () => void;
    const election = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const locks = vi.spyOn(navigator.locks, 'request').mockImplementation(((
      lockName: string,
      options: LockOptions | LockGrantedCallback<unknown>,
      callback?: LockGrantedCallback<unknown>,
    ) => {
      const grant = typeof options === 'function' ? options : callback!;
      const observe: LockGrantedCallback<unknown> = (lock) => {
        if (lockName === `opfs-vfs-lock-${name}` && lock) acquired();
        return grant(lock);
      };
      return typeof options === 'function' ? request(lockName, observe) : request(lockName, options, observe);
    }) as typeof navigator.locks.request);
    const follower = new OpfsVfsWorker(name);
    const sender = new BroadcastChannel(`opfs-vfs-${name}`);
    let acknowledgement: Record<string, unknown> | undefined;
    const channel = internal(leader).channel;
    const post = channel.postMessage.bind(channel);
    const hold = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
      if (message.type === 'RESPONSE') acknowledgement = message;
      else post(message);
    });
    const spawn = vi.spyOn(internal(follower), 'spawnWorker');
    const followerPost = vi.spyOn(internal(follower).channel, 'postMessage');
    try {
      await follower.ready;
      const shutdown = Promise.all([follower.shutdownSharedVfs(), follower.shutdownSharedVfs()]).then(
        () => 'closed',
        (error: unknown) => error,
      );
      await election; // The owner has closed, but its acknowledgement is still withheld.
      expect(acknowledgement?.generation).toBe(internal(leader).generation);
      expect(spawn).not.toHaveBeenCalled();
      expect(followerPost.mock.calls.filter(([message]) => message.payload?.type === 'SHUTDOWN_LEADER')).toHaveLength(
        1,
      );
      sender.postMessage(
        failure
          ? { ...acknowledgement, type: 'RESPONSE_ERROR', result: { error: 'Shutdown failed', code: 'EIO' } }
          : acknowledgement,
      );
      if (failure) {
        expect(await shutdown).toMatchObject({ code: 'EIO' });
        expect(follower.disposed).toBe(false);
        await waitFor(() => internal(follower).leaderReady, 5000);
        expect(await follower.exists('/kept')).toBe(true);
        expect(spawn).toHaveBeenCalledOnce();
        await follower.closeVfs();
      } else {
        expect(await shutdown).toBe('closed');
        expect(follower.disposed).toBe(true);
        expect(spawn).not.toHaveBeenCalled();
      }
      const file = await (await navigator.storage.getDirectory()).getFileHandle(name);
      const writable = await file.createWritable();
      await writable.close();
    } finally {
      locks.mockRestore();
      hold.mockRestore();
      spawn.mockRestore();
      followerPost.mockRestore();
      sender.close();
      follower.dispose();
      leader.dispose();
    }
  });
}

it('takes over after a missing shared-shutdown acknowledgement', async () => {
  const name = `shutdown-missing-ack-${crypto.randomUUID()}.bin`;
  const leader = new OpfsVfsWorker(name);
  await leader.ready;
  const follower = new OpfsVfsWorker(name);
  const channel = internal(leader).channel;
  const post = channel.postMessage.bind(channel);
  const hold = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
    if (message.type !== 'RESPONSE') post(message);
  });
  const spawn = vi.spyOn(internal(follower), 'spawnWorker');
  try {
    await follower.ready;
    void follower.shutdownSharedVfs().catch(() => {});
    await waitFor(() => internal(follower).leaderReady, 5_000);
    expect(spawn).toHaveBeenCalledOnce();
  } finally {
    hold.mockRestore();
    spawn.mockRestore();
    follower.dispose();
    leader.dispose();
  }
});

it('shares a leader shutdown and releases its handles before resolving', async () => {
  const name = `shutdown-owner-${crypto.randomUUID()}.bin`;
  const leader = new OpfsVfsWorker(name);
  try {
    await leader.ready;
    await leader.mkdir('/kept');
    await Promise.all([leader.shutdownSharedVfs(), leader.shutdownSharedVfs()]);
    expect(leader.disposed).toBe(true);
    const file = await (await navigator.storage.getDirectory()).getFileHandle(name);
    const writable = await file.createWritable();
    await writable.close();
  } finally {
    leader.dispose();
  }
});

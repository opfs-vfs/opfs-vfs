import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';
import { OpfsVfsWorkerClient } from '../worker-client';
import { changesTransportRequest } from './changes-transport-plugin';
import { registryTestRequest } from './registry-test-plugin';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
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

async function boundedResolution(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('request stayed pending')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type WorkerInternals = {
  worker: Worker | null;
  workerReady: Promise<void>;
  isLeader: boolean;
  leaderReady: boolean;
  generation: string;
  leaderGeneration?: string;
  attachmentId: string;
  channel: BroadcastChannel;
  pendingRequests: Map<number, unknown>;
};
const internal = (vfs: OpfsVfsWorkerClient) => vfs as unknown as WorkerInternals;
const name = () => `close-admission-${crypto.randomUUID()}.bin`;
const options = { initTimeout: 60_000 };
const changeOptions = {
  ...options,
  worker: () => new Worker(new URL('./changes-transport-worker.ts', import.meta.url), { type: 'module' }),
  plugins: [changesTransportRequest()],
};
const shutdownCode = 'VFS_SHUTTING_DOWN';

async function lockIsFree(fileName: string) {
  return navigator.locks.request(`opfs-vfs-lock-${fileName}`, { ifAvailable: true }, (lock) => lock !== null);
}

describe('close admission', () => {
  it('handles ready rejections before callers await them', async () => {
    const initError = new Error('worker factory failed');
    const rejections: unknown[] = [];
    const unhandled = (event: PromiseRejectionEvent) => {
      if (event.reason === initError || (event.reason as Error)?.message === 'VFS worker disposed') {
        rejections.push(event.reason);
        event.preventDefault();
      }
    };
    addEventListener('unhandledrejection', unhandled);
    const failed = new OpfsVfsWorker(name(), {
      forceLeader: true,
      worker: () => {
        throw initError;
      },
    });
    const disposed = new OpfsVfsWorker(name(), options);
    try {
      disposed.dispose();
      await waitFor(() => failed.disposed);
      await sleep(20);
      await expect(failed.ready).rejects.toBe(initError);
      await expect(disposed.ready).rejects.toThrow('VFS worker disposed');
      expect(rejections).toEqual([]);
    } finally {
      removeEventListener('unhandledrejection', unhandled);
      failed.dispose();
      disposed.dispose();
    }
  });

  it('handles its own ready rejection when close starts during initialization', async () => {
    const original = Worker.prototype.postMessage;
    let held: { worker: Worker; message: unknown; options: StructuredSerializeOptions } | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      if ((message as { type?: string }).type === 'PING')
        held = { worker: this, message, options: postOptions as StructuredSerializeOptions };
      else original.call(this, message, postOptions as StructuredSerializeOptions);
    });
    const rejections: unknown[] = [];
    const unhandled = (event: PromiseRejectionEvent) => {
      if ((event.reason as { code?: unknown })?.code === shutdownCode) {
        rejections.push(event.reason);
        event.preventDefault();
      }
    };
    addEventListener('unhandledrejection', unhandled);
    const vfs = new OpfsVfsWorker(name(), options);
    try {
      await waitFor(() => held !== undefined);
      await boundedResolution(vfs.closeVfs());
      await sleep(20);
      expect(rejections).toEqual([]);
    } finally {
      removeEventListener('unhandledrejection', unhandled);
      post.mockRestore();
      vfs.dispose();
    }
  });

  it('stops leader admission while INIT is held and closes the late mount', async () => {
    const fileName = name();
    const original = Worker.prototype.postMessage;
    let held:
      | { worker: Worker; message: { id: number; type: string }; options: StructuredSerializeOptions | Transferable[] }
      | undefined;
    let afterClose = false;
    const afterCloseTypes: string[] = [];
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      const typed = message as { id: number; type: string };
      if (afterClose) afterCloseTypes.push(typed.type);
      if (typed.type === 'INIT')
        held = { worker: this, message: typed, options: postOptions as StructuredSerializeOptions };
      else original.call(this, message, postOptions as StructuredSerializeOptions);
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const vfs = new OpfsVfsWorker(fileName, options);
    const states: string[] = [];
    vfs.subscribeStatus(() => states.push(vfs.getStatus().state));
    void vfs.ready.catch(() => {});
    try {
      await waitFor(() => held !== undefined);
      expect(await lockIsFree(fileName)).toBe(false);
      expect(vfs.getStatus().state).toBe('opening');
      const pending = boundedRejection(vfs.stat('/'));
      afterClose = true;
      const close = vfs.closeVfs();
      expect(vfs.getStatus().state).toBe('closing');
      await waitFor(() => states.includes('closing'));
      expect(vfs.closeVfs()).toBe(close);
      expect(await boundedRejection(vfs.ready)).toMatchObject({ code: shutdownCode });
      expect(await pending).toMatchObject({ code: shutdownCode });
      expect(await boundedRejection(vfs.stat('/'))).toMatchObject({ code: shutdownCode });
      afterCloseTypes.push('INIT');
      original.call(held!.worker, held!.message);
      await boundedResolution(close);
      expect(afterCloseTypes).toEqual(['INIT', 'CLOSE_VFS']);
      expect(terminate).toHaveBeenCalled();
      expect(internal(vfs).worker).toBeNull();
      expect(await lockIsFree(fileName)).toBe(true);
      expect(vfs.getStatus()).toMatchObject({ state: 'closed', error: null });
      await waitFor(() => states.includes('closed'));
      await expect(vfs.closeVfs()).resolves.toBeUndefined();
    } finally {
      post.mockRestore();
      terminate.mockRestore();
      vfs.dispose();
    }
  });

  it('does not mount when close starts while PING is held', async () => {
    const fileName = name();
    const original = Worker.prototype.postMessage;
    let held: { worker: Worker; message: unknown; options: StructuredSerializeOptions } | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      if ((message as { type?: string }).type === 'PING')
        held = { worker: this, message, options: postOptions as StructuredSerializeOptions };
      else original.call(this, message, postOptions as StructuredSerializeOptions);
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const vfs = new OpfsVfsWorker(fileName, options);
    void vfs.ready.catch(() => {});
    try {
      await waitFor(() => held !== undefined);
      expect(await lockIsFree(fileName)).toBe(false);
      await boundedResolution(vfs.closeVfs());
      expect(terminate).toHaveBeenCalled();
      expect(await lockIsFree(fileName)).toBe(true);
      expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'INIT')).toHaveLength(0);
      original.call(held!.worker, held!.message);
      await sleep(20);
      expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'INIT')).toHaveLength(0);
    } finally {
      post.mockRestore();
      terminate.mockRestore();
      vfs.dispose();
    }
  });

  it('reports late CLOSE_VFS failure but still releases a leader', async () => {
    const fileName = name();
    const original = Worker.prototype.postMessage;
    let held:
      | { worker: Worker; message: { id: number; type: string }; options: StructuredSerializeOptions }
      | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      const typed = message as { id: number; type: string };
      if (typed.type === 'INIT')
        held = { worker: this, message: typed, options: postOptions as StructuredSerializeOptions };
      else if (typed.type === 'CLOSE_VFS') {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { id: typed.id, type: 'ERROR', result: { error: 'close failed', code: 'EIO' } },
          }),
        );
      } else original.call(this, message, postOptions as StructuredSerializeOptions);
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const vfs = new OpfsVfsWorker(fileName, options);
    void vfs.ready.catch(() => {});
    try {
      await waitFor(() => held !== undefined);
      expect(await lockIsFree(fileName)).toBe(false);
      const close = vfs.closeVfs();
      original.call(held!.worker, held!.message);
      expect(await boundedRejection(close)).toMatchObject({ code: 'EIO' });
      expect(terminate).toHaveBeenCalled();
      expect(await lockIsFree(fileName)).toBe(true);
      expect(vfs.getStatus()).toMatchObject({
        state: 'closed',
        error: { code: 'EIO', message: 'close failed' },
      });
    } finally {
      post.mockRestore();
      terminate.mockRestore();
      vfs.dispose();
    }
  });

  it('releases a leader after late INIT failure without sending CLOSE_VFS', async () => {
    const fileName = name();
    const original = Worker.prototype.postMessage;
    let held: { worker: Worker; message: { id: number; type: string } } | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      const typed = message as { id: number; type: string };
      if (typed.type === 'INIT') held = { worker: this, message: typed };
      else original.call(this, message, postOptions as StructuredSerializeOptions);
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const vfs = new OpfsVfsWorker(fileName, options);
    void vfs.ready.catch(() => {});
    try {
      await waitFor(() => held !== undefined);
      expect(await lockIsFree(fileName)).toBe(false);
      const close = vfs.closeVfs();
      held!.worker.dispatchEvent(
        new MessageEvent('message', {
          data: { id: held!.message.id, type: 'ERROR', result: { error: 'init failed', code: 'EIO' } },
        }),
      );
      await boundedResolution(close);
      expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'CLOSE_VFS')).toHaveLength(
        0,
      );
      expect(terminate).toHaveBeenCalled();
      expect(await lockIsFree(fileName)).toBe(true);
      expect(vfs.getStatus()).toMatchObject({ state: 'closed', error: { code: 'EIO', message: 'init failed' } });
    } finally {
      post.mockRestore();
      terminate.mockRestore();
      vfs.dispose();
    }
  });

  it('keeps worker crash details when CLOSE_VFS is in flight', async () => {
    const vfs = new OpfsVfsWorker(name(), options);
    let post: MockInstance | undefined;
    try {
      await vfs.ready;
      const worker = internal(vfs).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'CLOSE_VFS') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const close = vfs.closeVfs();
      await waitFor(() => held);
      worker.dispatchEvent(new ErrorEvent('error', { error: new Error('close crash') }));
      expect(await boundedRejection(close)).toMatchObject({ code: 'VFS_WORKER_FAILED' });
      expect(vfs.getStatus()).toMatchObject({ state: 'closed', error: { code: 'VFS_WORKER_FAILED' } });
    } finally {
      post?.mockRestore();
      vfs.dispose();
    }
  });

  it('closes a follower during leader readiness without relaying a command', async () => {
    const fileName = name();
    const original = Worker.prototype.postMessage;
    let held: { worker: Worker; message: unknown; options: StructuredSerializeOptions } | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      if ((message as { type?: string }).type === 'INIT')
        held = { worker: this, message, options: postOptions as StructuredSerializeOptions };
      else original.call(this, message, postOptions as StructuredSerializeOptions);
    });
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    let followerPost: MockInstance | undefined;
    let leaderPost: MockInstance | undefined;
    try {
      await waitFor(() => held !== undefined);
      follower = new OpfsVfsWorker(fileName, options);
      followerPost = vi.spyOn(internal(follower).channel, 'postMessage');
      leaderPost = vi.spyOn(held!.worker, 'postMessage');
      await waitFor(async () => {
        const locks = await navigator.locks.query();
        return (locks.pending ?? []).some((lock) => lock.name === `opfs-vfs-lock-${fileName}`);
      });
      const stat = boundedRejection(follower.stat('/'));
      const close = follower.closeVfs();
      expect(await boundedRejection(follower.ready)).toMatchObject({ code: shutdownCode });
      expect(await stat).toMatchObject({ code: shutdownCode });
      await boundedResolution(close);
      expect(await lockIsFree(fileName)).toBe(false);
      const locks = await navigator.locks.query();
      expect((locks.pending ?? []).filter((lock) => lock.name === `opfs-vfs-lock-${fileName}`)).toHaveLength(0);
      expect(
        (locks.held ?? []).filter(
          (lock) => lock.name === `opfs-vfs-client-${fileName}-${internal(follower!).attachmentId}`,
        ),
      ).toHaveLength(0);
      expect(
        (locks.pending ?? []).filter(
          (lock) => lock.name === `opfs-vfs-client-${fileName}-${internal(follower!).attachmentId}`,
        ),
      ).toHaveLength(0);
      expect(
        followerPost.mock.calls.filter((call: unknown[]) => (call[0] as { type?: string }).type === 'COMMAND'),
      ).toHaveLength(0);
      original.call(held!.worker, held!.message);
      await leader.ready;
      expect(
        leaderPost.mock.calls.filter((call: unknown[]) =>
          ['STAT', 'FLUSH'].includes((call[0] as { type?: string }).type ?? ''),
        ),
      ).toHaveLength(0);
    } finally {
      followerPost?.mockRestore();
      leaderPost?.mockRestore();
      post.mockRestore();
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('rejects takeover commands when close starts before INIT completes', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    await leader.ready;
    const follower = new OpfsVfsWorker(fileName, options);
    const original = Worker.prototype.postMessage;
    let held: { worker: Worker; message: unknown; options: StructuredSerializeOptions } | undefined;
    let holdTakeover = false;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      postOptions,
    ) {
      if (holdTakeover && (message as { type?: string }).type === 'INIT') {
        held = { worker: this, message, options: postOptions as StructuredSerializeOptions };
      } else {
        original.call(this, message, postOptions as StructuredSerializeOptions);
      }
    });
    try {
      await follower.ready;
      leader.dispose();
      holdTakeover = true;
      await waitFor(() => held !== undefined && internal(follower).isLeader);
      const pending = follower.stat('/');
      await sleep(20);
      const close = follower.closeVfs();
      expect(await boundedRejection(pending)).toMatchObject({ code: shutdownCode });
      expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'STAT')).toHaveLength(0);
      original.call(held!.worker, held!.message, held!.options);
      await boundedResolution(close);
      expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'CLOSE_VFS')).toHaveLength(
        1,
      );
      expect(await lockIsFree(fileName)).toBe(true);
    } finally {
      post.mockRestore();
      follower.dispose();
      leader.dispose();
    }
  });

  it('closes a pending passive attachment probe on close', async () => {
    const fileName = name();
    const post = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
    const probeChannel = () =>
      post.mock.contexts[post.mock.calls.findIndex(([message]) => message?.type === 'OBSERVER_PROBE')] as
        | BroadcastChannel
        | undefined;
    const close = vi.spyOn(BroadcastChannel.prototype, 'close');
    const passive = new OpfsVfsWorker(fileName, { attachTo: crypto.randomUUID(), initTimeout: 60_000 });
    void passive.ready.catch(() => {});
    try {
      await waitFor(() => probeChannel() !== undefined);
      await boundedResolution(passive.closeVfs());
      expect(await boundedRejection(passive.ready)).toMatchObject({ code: shutdownCode });
      expect(close.mock.instances).toContain(probeChannel());
    } finally {
      post.mockRestore();
      close.mockRestore();
      passive.dispose();
    }
  });

  it('uses one captured FLUSH for a ready follower and rejects same-tick work', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await Promise.all([leader.ready, follower.ready]);
      expect(follower.getStatus()).toMatchObject({ state: 'ready', role: 'follower' });
      const followerPost = vi.spyOn(internal(follower).channel, 'postMessage');
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held: { message: unknown; options: StructuredSerializeOptions } | undefined;
      const leaderPost = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'FLUSH')
          held = { message, options: postOptions as StructuredSerializeOptions };
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const states: string[] = [];
      follower.subscribeStatus(() => states.push(follower!.getStatus().state));
      try {
        const pending = follower.stat('/');
        const close = follower.closeVfs();
        expect(await boundedRejection(pending)).toMatchObject({ code: shutdownCode });
        await waitFor(() => held !== undefined);
        expect(follower.getStatus()).toMatchObject({
          state: 'closing',
          role: 'follower',
          ownerGeneration: internal(leader).generation,
          error: null,
        });
        await waitFor(() => states.includes('closing'));
        original(held!.message, held!.options);
        await boundedResolution(close);
        await waitFor(() => states.includes('closed'));
        expect(follower.getStatus()).toMatchObject({ state: 'closed', error: null });
        const commands = followerPost.mock.calls.map(
          ([message]) => message as { type?: string; payload?: { type?: string }; generation?: string },
        );
        expect(commands.filter((message) => message.type === 'COMMAND' && message.payload?.type === 'FLUSH')).toEqual([
          expect.objectContaining({ generation: internal(leader).generation }),
        ]);
        expect(
          leaderPost.mock.calls.filter(([message]) => (message as { type?: string }).type === 'STAT'),
        ).toHaveLength(0);
      } finally {
        followerPost.mockRestore();
        leaderPost.mockRestore();
      }
    } finally {
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('disposes a follower when its captured FLUSH fails', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await Promise.all([leader.ready, follower.ready]);
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      const post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        const typed = message as { id: number; type: string };
        if (typed.type === 'FLUSH') {
          worker.dispatchEvent(
            new MessageEvent('message', {
              data: { id: typed.id, type: 'ERROR', result: { error: 'flush failed', code: 'EIO' } },
            }),
          );
        } else original(message, postOptions as StructuredSerializeOptions);
      });
      try {
        expect(await boundedRejection(follower.closeVfs())).toMatchObject({ code: 'EIO' });
        expect(follower.disposed).toBe(true);
        expect(follower.getStatus()).toMatchObject({
          state: 'closed',
          error: { code: 'EIO', message: 'flush failed' },
        });
      } finally {
        post.mockRestore();
      }
    } finally {
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('never moves a captured follower FLUSH to a successor', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    let next: OpfsVfsWorker | undefined;
    let hold: MockInstance | undefined;
    let allPost: MockInstance | undefined;
    let followerPost: MockInstance | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await Promise.all([leader.ready, follower.ready]);
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      hold = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'FLUSH') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const ownerGeneration = internal(leader).generation;
      followerPost = vi.spyOn(internal(follower).channel, 'postMessage');
      const close = follower.closeVfs();
      await waitFor(() => held);
      const originalPost = Worker.prototype.postMessage;
      const messages: { worker: Worker; type?: string }[] = [];
      allPost = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        message,
        postOptions,
      ) {
        messages.push({ worker: this, type: (message as { type?: string }).type });
        originalPost.call(this, message, postOptions);
      });
      leader.dispose();
      hold.mockRestore();
      next = new OpfsVfsWorker(fileName, options);
      await next.ready;
      expect(await boundedRejection(close)).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      expect(
        messages.filter(({ worker: sentBy, type }) => type === 'PING' && sentBy !== internal(next!).worker),
      ).toHaveLength(0);
      const routed = followerPost.mock.calls.map(
        ([message]) => message as { type?: string; payload?: { type?: string } },
      );
      expect(routed.filter(({ type }) => type === 'COMMAND')).toEqual([
        expect.objectContaining({ generation: ownerGeneration, payload: expect.objectContaining({ type: 'FLUSH' }) }),
      ]);
      expect(routed.filter(({ type }) => type === 'LEADER_PING')).toHaveLength(0);
      expect(messages.filter(({ type }) => type === 'FLUSH')).toHaveLength(0);
    } finally {
      allPost?.mockRestore();
      followerPost?.mockRestore();
      hold?.mockRestore();
      follower?.dispose();
      if (next) await next.closeVfs().catch(() => next!.dispose());
      leader.dispose();
    }
  });

  it('keeps a closing follower status when owner loss invalidates its held FLUSH', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    let hold: MockInstance | undefined;
    let releaseFlush: (() => void) | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await Promise.all([leader.ready, follower.ready]);
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      hold = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'FLUSH') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const states = [follower.getStatus().state];
      follower.subscribeStatus(() => states.push(follower!.getStatus().state));

      const close = follower.closeVfs();
      await waitFor(() => held);
      await waitFor(() => states.includes('closing'));
      const pending = [...internal(follower).pendingRequests.values()] as { reject(error: unknown): void }[];
      expect(pending).toHaveLength(1);
      const flush = pending[0]!;
      const reject = flush.reject.bind(flush);
      let flushError: unknown;
      flush.reject = (error) => {
        flushError = error;
      };
      releaseFlush = () => {
        if (flushError !== undefined) reject(flushError);
      };

      leader.dispose();
      await waitFor(() => flushError !== undefined);
      expect(follower.getStatus().state).toBe('closing');
      expect(states.slice(states.lastIndexOf('closing'))).not.toEqual(
        expect.arrayContaining(['recovering', 'opening', 'ready']),
      );

      releaseFlush();
      releaseFlush = undefined;
      expect(await boundedRejection(close)).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      await waitFor(() => states.includes('closed'));
      expect(follower.getStatus().state).toBe('closed');
    } finally {
      releaseFlush?.();
      hold?.mockRestore();
      follower?.dispose();
      leader.dispose();
    }
  });

  it('rejects a captured follower FLUSH when its owner closes without a successor', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    let hold: MockInstance | undefined;
    let post: MockInstance | undefined;
    let followerPost: MockInstance | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await Promise.all([leader.ready, follower.ready]);
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      hold = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'FLUSH') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const ownerGeneration = internal(leader).generation;
      followerPost = vi.spyOn(internal(follower).channel, 'postMessage');
      const close = follower.closeVfs();
      await waitFor(() => held);
      const originalPost = Worker.prototype.postMessage;
      const messages: { worker: Worker; type?: string }[] = [];
      post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        message,
        postOptions,
      ) {
        messages.push({ worker: this, type: (message as { type?: string }).type });
        originalPost.call(this, message, postOptions);
      });
      leader.dispose();
      expect(await boundedRejection(close)).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      expect(follower.disposed).toBe(true);
      expect(messages.filter(({ type }) => type === 'PING')).toHaveLength(0);
      const routed = followerPost.mock.calls.map(
        ([message]) => message as { type?: string; payload?: { type?: string } },
      );
      expect(routed.filter(({ type }) => type === 'COMMAND')).toEqual([
        expect.objectContaining({ generation: ownerGeneration, payload: expect.objectContaining({ type: 'FLUSH' }) }),
      ]);
      expect(routed.filter(({ type }) => type === 'LEADER_PING')).toHaveLength(0);
      expect(messages.filter(({ type }) => type === 'FLUSH')).toHaveLength(0);
      expect(await lockIsFree(fileName)).toBe(true);
    } finally {
      post?.mockRestore();
      followerPost?.mockRestore();
      hold?.mockRestore();
      follower?.dispose();
      leader.dispose();
    }
  });

  it('settles close after external disposal', async () => {
    const first = new OpfsVfsWorker(name(), options);
    try {
      void first.ready.catch(() => {});
      first.dispose();
      await expect(first.closeVfs()).resolves.toBeUndefined();
    } finally {
      first.dispose();
    }

    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await Promise.all([leader.ready, follower.ready]);
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      const post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'FLUSH') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      try {
        const close = follower.closeVfs();
        await waitFor(() => held);
        follower.dispose();
        await boundedRejection(close);
        expect(follower.getStatus()).toMatchObject({ state: 'closed', error: expect.anything() });
      } finally {
        post.mockRestore();
      }
    } finally {
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }

    const local = new OpfsVfsWorker(name(), options);
    let localPost: MockInstance | undefined;
    try {
      await local.ready;
      const worker = internal(local).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      localPost = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'CLOSE_VFS') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const close = local.closeVfs();
      await waitFor(() => held);
      local.dispose();
      await boundedRejection(close);
      expect(local.getStatus()).toMatchObject({ state: 'closed', error: expect.anything() });
    } finally {
      localPost?.mockRestore();
      local.dispose();
    }
  });

  it('reports a held leader shutdown failure after disposal', async () => {
    const leader = new OpfsVfsWorker(name(), options);
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'CLOSE_VFS') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const shutdown = leader.shutdownSharedVfs();
      await waitFor(() => held);
      leader.dispose();
      await boundedRejection(shutdown);
      expect(leader.getStatus()).toMatchObject({ state: 'closed', error: expect.anything() });
    } finally {
      post?.mockRestore();
      leader.dispose();
    }
  });

  it('reports a held follower shutdown failure after disposal', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, options);
    let follower: OpfsVfsWorker | undefined;
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, options);
      await follower.ready;
      const channel = internal(follower).channel;
      const original = channel.postMessage.bind(channel);
      let held = false;
      post = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
        if ((message as { payload?: { type?: string } }).payload?.type === 'SHUTDOWN_LEADER') held = true;
        else original(message);
      });
      const shutdown = follower.shutdownSharedVfs();
      await waitFor(() => held);
      follower.dispose();
      await boundedRejection(shutdown);
      expect(follower.getStatus()).toMatchObject({ state: 'closed', error: expect.anything() });
    } finally {
      post?.mockRestore();
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('keeps a profile mismatch when a held follower FLUSH loses its owner', async () => {
    const fileName = name();
    const pluginOptions = {
      ...options,
      worker: () => new Worker(new URL('./registry-test-worker.ts', import.meta.url), { type: 'module' }),
      plugins: [registryTestRequest()],
    };
    const leader = new OpfsVfsWorker(fileName, pluginOptions);
    let follower: OpfsVfsWorker | undefined;
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, pluginOptions);
      await follower.ready;
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held = false;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'FLUSH') held = true;
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const close = follower.closeVfs();
      await waitFor(() => held);
      internal(follower).channel.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'LEADER_READY',
            generation: crypto.randomUUID(),
            profile: {
              version: 2,
              capabilities: ['error-details', 'persistence-status'],
              plugins: [{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'registry-test:b' }],
            },
          },
        }),
      );
      expect(await boundedRejection(close)).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      expect(follower.getStatus()).toMatchObject({ state: 'closed', error: { code: 'VFS_PLUGIN_MISMATCH' } });
    } finally {
      post?.mockRestore();
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('settles an already-sent write and leaves no partial file after reopen', async () => {
    const fileName = name();
    const bytes = new Uint8Array([1, 2, 3]);
    const leader = new OpfsVfsWorker(fileName, options);
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held: { message: unknown; options: StructuredSerializeOptions } | undefined;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'WRITE_FILE_BUFFER')
          held = { message, options: postOptions as StructuredSerializeOptions };
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const write = leader.writeFileBuffer('/a', bytes);
      await waitFor(() => held !== undefined);
      const close = leader.closeVfs();
      original(held!.message, held!.options);
      await boundedResolution(write);
      await boundedResolution(close);
      const types = post.mock.calls.map(([message]) => (message as { type?: string }).type);
      expect(types.indexOf('CLOSE_VFS')).toBeGreaterThan(types.indexOf('WRITE_FILE_BUFFER'));
      const reopened = new OpfsVfsWorker(fileName, options);
      try {
        await reopened.ready;
        expect(await reopened.readFileBuffer('/a')).toEqual(bytes);
      } finally {
        await reopened.closeVfs();
      }
    } finally {
      post?.mockRestore();
      leader.dispose();
    }
  });

  it('refuses relayed file-change opens while the owner is closing', async () => {
    const fileName = name();
    const leader = new OpfsVfsWorker(fileName, changeOptions);
    let follower: OpfsVfsWorker | undefined;
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(fileName, changeOptions);
      await follower.ready;
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held: { message: unknown; options: StructuredSerializeOptions } | undefined;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'CLOSE_VFS')
          held = { message, options: postOptions as StructuredSerializeOptions };
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const close = leader.closeVfs();
      await waitFor(() => held !== undefined);
      expect(
        await boundedRejection(
          follower.openFileChangeChannel(
            () => {},
            () => {},
            () => {},
          ),
        ),
      ).toMatchObject({ code: shutdownCode });
      expect(
        post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'FILE_CHANGES_OPEN'),
      ).toHaveLength(0);
      original(held!.message, held!.options);
      await boundedResolution(close);
    } finally {
      post?.mockRestore();
      follower?.dispose();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('keeps channel close local while closeVfs is in progress', async () => {
    const leader = new OpfsVfsWorker(name(), changeOptions);
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      const channel = await leader.openFileChangeChannel(
        () => {},
        () => {},
        () => {},
      );
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held: { message: unknown; options: StructuredSerializeOptions } | undefined;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'CLOSE_VFS')
          held = { message, options: postOptions as StructuredSerializeOptions };
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const close = leader.closeVfs();
      await waitFor(() => held !== undefined);
      channel.close();
      await sleep(20);
      expect(
        post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'FILE_CHANGES_CLOSE'),
      ).toHaveLength(0);
      original(held!.message, held!.options);
      await boundedResolution(close);
    } finally {
      post?.mockRestore();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('rejects file-change channel requests once close starts', async () => {
    const leader = new OpfsVfsWorker(name(), changeOptions);
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      const channel = await leader.openFileChangeChannel(
        () => {},
        () => {},
        () => {},
      );
      const worker = internal(leader).worker!;
      const original = worker.postMessage.bind(worker);
      let held: { message: unknown; options: StructuredSerializeOptions } | undefined;
      post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
        if ((message as { type?: string }).type === 'CLOSE_VFS')
          held = { message, options: postOptions as StructuredSerializeOptions };
        else original(message, postOptions as StructuredSerializeOptions);
      });
      const close = leader.closeVfs();
      await waitFor(() => held !== undefined);
      expect(
        await boundedRejection(
          channel.request({
            type: 'register',
            subscriptionId: 's1',
            options: {
              path: '/',
              scope: 'directory',
              recursive: true,
              events: ['create'],
              content: false,
            },
          }),
        ),
      ).toMatchObject({ code: shutdownCode });
      await sleep(20);
      expect(
        post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'FILE_CHANGES_COMMAND'),
      ).toHaveLength(0);
      original(held!.message, held!.options);
      await boundedResolution(close);
    } finally {
      post?.mockRestore();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });

  it('rejects file-change requests when option getters start close', async () => {
    const leader = new OpfsVfsWorker(name(), changeOptions);
    let post: MockInstance | undefined;
    try {
      await leader.ready;
      const channel = await leader.openFileChangeChannel(
        () => {},
        () => {},
        () => {},
      );
      const worker = internal(leader).worker!;
      post = vi.spyOn(worker, 'postMessage');
      expect(
        await boundedRejection(
          channel.request({
            type: 'register',
            subscriptionId: 's1',
            options: {
              get path() {
                void leader.closeVfs();
                return '/';
              },
              scope: 'directory',
              recursive: true,
              events: ['create'],
              content: false,
            },
          }),
        ),
      ).toMatchObject({ code: shutdownCode });
      await sleep(20);
      expect(
        post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'FILE_CHANGES_COMMAND'),
      ).toHaveLength(0);
      await boundedResolution(leader.closeVfs());
    } finally {
      post?.mockRestore();
      await leader.closeVfs().catch(() => leader.dispose());
    }
  });
});

import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { ChangeReply, WireSubscribeOptions } from '@opfs-vfs/opfs-vfs/changes';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subscribe, type SubscribeOptions } from '../client';
import { subscriptionsRequest } from '../config';

const options: SubscribeOptions = {
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create', 'update', 'delete'],
  content: false,
  onError() {},
};
const wire: WireSubscribeOptions = {
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create', 'update', 'delete'],
  content: false,
};
const worker = () => new Worker(new URL('./subscription-registration-worker.ts', import.meta.url), { type: 'module' });
const sleep = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bounded<T>(promise: Promise<T>, description: string, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('owner reservation count did not reach zero');
    await sleep(5);
  }
}

type WorkerControl = {
  readonly attachmentId: string;
  readonly generation: string;
  requestWorker<T>(type: string, payload: object): Promise<T>;
};

async function ownerReservationCount(owner: OpfsVfsWorker, client: OpfsVfsWorker): Promise<number> {
  const ownerControl = owner as unknown as WorkerControl;
  const clientId = (client as unknown as WorkerControl).attachmentId;
  const channelId = `probe-${crypto.randomUUID()}`;
  const envelope = { version: 1, generation: ownerControl.generation, clientId, channelId, route: 'local' as const };
  await ownerControl.requestWorker<{ generation: string }>('FILE_CHANGES_OPEN', envelope);
  let successes = 0;
  try {
    for (; successes < 32; successes++)
      await ownerControl.requestWorker<ChangeReply>('FILE_CHANGES_COMMAND', {
        ...envelope,
        command: { type: 'register', subscriptionId: crypto.randomUUID(), options: wire },
      });
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOSPC') throw error;
  } finally {
    await ownerControl.requestWorker('FILE_CHANGES_CLOSE', envelope);
  }
  return 32 - successes;
}

let unhandled: PromiseRejectionEvent[];
let onUnhandled: (event: PromiseRejectionEvent) => void;

beforeEach(() => {
  unhandled = [];
  onUnhandled = (event) => {
    event.preventDefault();
    unhandled.push(event);
  };
  addEventListener('unhandledrejection', onUnhandled);
});

afterEach(async () => {
  await sleep();
  removeEventListener('unhandledrejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('subscription close integration', () => {
  it('settles leader subscriptions when the owner mount closes', async () => {
    const name = `subscription-close-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await leader.ready;
      const handles = await Promise.all(Array.from({ length: 3 }, () => subscribe(leader, options, () => {})));
      const close = leader.closeVfs();
      await expect(bounded(close, 'leader close')).resolves.toBeUndefined();
      const retirements = await bounded(
        Promise.all(handles.map((handle) => handle.closed)),
        'leader subscription retirement',
      );
      expect(retirements.every(({ status }) => status === 'released' || status === 'unknown')).toBe(true);
    } finally {
      await Promise.allSettled([bounded(leader.closeVfs(), 'leader cleanup close')]);
      leader.dispose();
      await deleteVolume(name);
    }
  });

  it('settles synchronous leader cancellations racing close admission', async () => {
    const name = `subscription-close-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await leader.ready;
      const handles = await Promise.all(Array.from({ length: 3 }, () => subscribe(leader, options, () => {})));
      expect(() => handles.forEach((handle) => handle.unsubscribe())).not.toThrow();
      const close = leader.closeVfs();
      await expect(bounded(close, 'leader close')).resolves.toBeUndefined();
      const retirements = await bounded(
        Promise.all(handles.map((handle) => handle.closed)),
        'racing subscription retirement',
      );
      expect(retirements.every(({ status }) => status === 'released' || status === 'unknown')).toBe(true);
    } finally {
      await Promise.allSettled([bounded(leader.closeVfs(), 'leader cleanup close')]);
      leader.dispose();
      await deleteVolume(name);
    }
  });

  it('releases follower reservations while the leader remains open', async () => {
    const name = `subscription-close-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      follower = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
      await follower.ready;
      const handles = await Promise.all(Array.from({ length: 2 }, () => subscribe(follower!, options, () => {})));
      await expect(bounded(follower.closeVfs(), 'follower close')).resolves.toBeUndefined();
      const retirements = await bounded(
        Promise.all(handles.map((handle) => handle.closed)),
        'follower subscription retirement',
      );
      expect(retirements.every(({ status }) => status === 'released' || status === 'unknown')).toBe(true);
      await waitFor(async () => (await ownerReservationCount(leader, follower!)) === 0);
      const replacements = await Promise.all(Array.from({ length: 2 }, () => subscribe(leader, options, () => {})));
      replacements.forEach((handle) => handle.unsubscribe());
      await bounded(Promise.all(replacements.map((handle) => handle.closed)), 'replacement subscription retirement');
    } finally {
      await Promise.allSettled([bounded(follower?.closeVfs() ?? Promise.resolve(), 'follower cleanup close')]);
      follower?.dispose();
      await Promise.allSettled([bounded(leader.closeVfs(), 'leader cleanup close')]);
      leader.dispose();
      await deleteVolume(name);
    }
  });
});

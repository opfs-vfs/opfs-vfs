import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { describe, expect, it, vi } from 'vitest';
import { clientStore, sameBytes, type FileInfo } from '../resources';
import { volumeName, waitFor, worker } from './harness';

const terminalControls = vi.hoisted(() => new WeakMap<object, any>());

it('compares aligned and unaligned byte views without losing tail differences', () => {
  const bytes = Uint8Array.from({ length: 11 }, (_, index) => index);
  expect(sameBytes(bytes, bytes.slice())).toBe(true);
  const early = bytes.slice();
  early[0]++;
  expect(sameBytes(bytes, early)).toBe(false);
  const last = bytes.slice();
  last[10]++;
  expect(sameBytes(bytes, last)).toBe(false);
  expect(sameBytes(bytes, bytes.subarray(0, 10))).toBe(false);
  const unaligned = Uint8Array.from([99, ...bytes, 99]).subarray(1, 12);
  expect(sameBytes(bytes, unaligned)).toBe(true);
  unaligned[10]++;
  expect(sameBytes(bytes, unaligned)).toBe(false);
});

vi.mock('@opfs-vfs/plugin-subscriptions/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opfs-vfs/plugin-subscriptions/client')>();
  return {
    ...actual,
    subscribe: (source: object, options: any, listener: any) =>
      terminalControls.get(source)?.subscribe(options, listener) ?? actual.subscribe(source as any, options, listener),
  };
});

describe('live read resources', () => {
  it('keeps unchanged byte content by identity without a per-byte callback', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire<Uint8Array | null>> | undefined;
    let restoreEvery = () => {};
    try {
      await client.ready;
      await client.writeFileBuffer(
        '/bytes',
        Uint8Array.from({ length: 11 }, (_, index) => index),
      );
      entry = store.acquire(client.getStatus().ownerGeneration!, 'content-bytes', '/bytes');
      await waitFor(() => entry!.snapshot.status === 'success', 'initial bytes');
      const initial = entry.snapshot.data;
      const every = vi.spyOn(Uint8Array.prototype, 'every');
      restoreEvery = () => every.mockRestore();
      await entry.snapshot.refresh();
      expect(entry.snapshot.data).toBe(initial);
      expect(every).not.toHaveBeenCalled();
    } finally {
      restoreEvery();
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('paces repeated overflow recovery without letting refresh bypass it', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let registrations = 0;
    terminalControls.set(client, {
      subscribe() {
        registrations++;
        if (registrations <= 7)
          return Promise.reject(Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' }));
        return Promise.resolve({ closed: new Promise<{ status: 'released' }>(() => {}), unsubscribe() {} });
      },
    });
    let entry: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      vi.useFakeTimers();
      entry = store.acquire(client.getStatus().ownerGeneration!, 'folder', '/');
      await vi.advanceTimersByTimeAsync(0);
      for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
        const joined = entry.snapshot.refresh();
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(registrations).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        await joined;
        expect(registrations).toBe(index + 2);
      }
      expect(registrations).toBe(8);
    } finally {
      vi.useRealTimers();
      if (entry) store.release(entry);
      terminalControls.delete(client);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('resets overflow pacing after a settled scan stays healthy for 60 seconds', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    const roots: { report: (cause: Error) => void; close: (value: { status: 'released' }) => void }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    let settleDelay: ((delay: number) => void) | null = null;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const [, delay] = args;
      const settle = settleDelay;
      settleDelay = null;
      settle?.(Number(delay));
      return realSetTimeout(...args);
    }) as typeof setTimeout);
    const nextDelay = () =>
      new Promise<number>((resolve) => {
        settleDelay = resolve;
      });
    terminalControls.set(client, {
      subscribe(options: { onError: (cause: Error) => void }) {
        let close!: (value: { status: 'released' }) => void;
        const closed = new Promise<{ status: 'released' }>((resolve) => (close = resolve));
        roots.push({ report: options.onError, close });
        return Promise.resolve({ closed, unsubscribe() {} });
      },
    });
    let entry: ReturnType<typeof store.acquire> | undefined;
    const snapshot = (check: () => boolean) =>
      new Promise<void>((resolve) => {
        const stop = store.subscribe(entry!, () => {
          if (!check()) return;
          stop();
          resolve();
        });
        if (check()) {
          stop();
          resolve();
        }
      });
    const overflow = async (index: number) => {
      const failed = snapshot(() => entry!.snapshot.status === 'error');
      roots[index]!.report(Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' }));
      roots[index]!.close({ status: 'released' });
      await failed;
    };
    let now: { mockRestore(): void } | undefined;
    try {
      await client.ready;
      entry = store.acquire(client.getStatus().ownerGeneration!, 'folder', '/');
      await snapshot(() => entry!.snapshot.status === 'success' && roots.length === 1);

      const firstDelay = nextDelay();
      await overflow(0);
      expect(await firstDelay).toBe(1_000);
      await snapshot(() => entry!.snapshot.status === 'success' && roots.length === 2);
      const secondDelay = nextDelay();
      await overflow(1);
      expect(await secondDelay).toBe(2_000);
      await snapshot(() => entry!.snapshot.status === 'success' && roots.length === 3);

      const healthyNow = Date.now();
      now = vi.spyOn(Date, 'now').mockReturnValue(healthyNow + 60_001);
      const resetDelay = nextDelay();
      await overflow(2);
      expect(await resetDelay).toBe(1_000);
      await snapshot(() => entry!.snapshot.status === 'success' && roots.length === 4);
    } finally {
      now?.mockRestore();
      timer.mockRestore();
      if (entry) store.release(entry);
      terminalControls.delete(client);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('resets overflow pacing when a follower takes a new owner generation', async () => {
    const fileName = volumeName();
    const owner = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const follower = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(follower);
    const roots: { report: (cause: Error) => void; close: (value: { status: 'released' }) => void }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    let settleDelay: ((delay: number) => void) | null = null;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const [, delay] = args;
      const settle = settleDelay;
      settleDelay = null;
      settle?.(Number(delay));
      return realSetTimeout(...args);
    }) as typeof setTimeout);
    const nextDelay = () =>
      new Promise<number>((resolve) => {
        settleDelay = resolve;
      });
    terminalControls.set(follower, {
      subscribe(options: { onError: (cause: Error) => void }) {
        let close!: (value: { status: 'released' }) => void;
        const closed = new Promise<{ status: 'released' }>((resolve) => (close = resolve));
        roots.push({ report: options.onError, close });
        return Promise.resolve({ closed, unsubscribe() {} });
      },
    });
    let oldEntry: ReturnType<typeof store.acquire> | undefined;
    let newEntry: ReturnType<typeof store.acquire> | undefined;
    const snapshot = (entry: ReturnType<typeof store.acquire>, check: () => boolean) =>
      new Promise<void>((resolve) => {
        const stop = store.subscribe(entry, () => {
          if (!check()) return;
          stop();
          resolve();
        });
        if (check()) {
          stop();
          resolve();
        }
      });
    try {
      await Promise.all([owner.ready, follower.ready]);
      const oldGeneration = follower.getStatus().ownerGeneration!;
      oldEntry = store.acquire(oldGeneration, 'folder', '/');
      await snapshot(oldEntry, () => oldEntry!.snapshot.status === 'success' && roots.length === 1);

      const oldDelay = nextDelay();
      const failed = snapshot(oldEntry, () => oldEntry!.snapshot.status === 'error');
      roots[0]!.report(Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' }));
      roots[0]!.close({ status: 'released' });
      await failed;
      expect(await oldDelay).toBe(1_000);
      const newGeneration = await new Promise<string>((resolve) => {
        const stop = follower.subscribeStatus(() => {
          const status = follower.getStatus();
          if (status.state !== 'ready' || status.role !== 'leader' || status.ownerGeneration === oldGeneration) return;
          stop();
          resolve(status.ownerGeneration!);
        });
        void owner.closeVfs();
      });

      newEntry = store.acquire(newGeneration, 'folder', '/');
      await snapshot(newEntry, () => newEntry!.snapshot.status === 'success' && roots.length === 2);
      const resetDelay = nextDelay();
      const newFailed = snapshot(newEntry, () => newEntry!.snapshot.status === 'error');
      roots[1]!.report(Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' }));
      roots[1]!.close({ status: 'released' });
      await newFailed;
      expect(await resetDelay).toBe(1_000);
      await snapshot(newEntry, () => newEntry!.snapshot.status === 'success' && roots.length === 3);
    } finally {
      timer.mockRestore();
      if (oldEntry) store.release(oldEntry);
      if (newEntry) store.release(newEntry);
      terminalControls.delete(follower);
      await Promise.allSettled([owner.closeVfs(), follower.closeVfs()]);
      owner.dispose();
      follower.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('reports a terminal whether its callback arrives before or after confirmed close', async () => {
    for (const order of ['error-first', 'closed-first'] as const) {
      const fileName = volumeName();
      const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
      const store = clientStore(client);
      let settle!: (value: { status: 'released' }) => void;
      let reportTerminal!: (cause: Error) => void;
      const closed = new Promise<{ status: 'released' }>((resolve) => {
        settle = resolve;
      });
      let registrations = 0;
      terminalControls.set(client, {
        subscribe(options: { onError: (cause: Error) => void }) {
          registrations++;
          if (registrations === 1) reportTerminal = options.onError;
          return Promise.resolve({
            closed: registrations === 1 ? closed : new Promise<{ status: 'released' }>(() => {}),
            unsubscribe() {},
          });
        },
      });
      let resource: ReturnType<typeof store.acquire> | undefined;
      try {
        await client.ready;
        resource = store.acquire(client.getStatus().ownerGeneration!, 'folder', '/');
        await waitFor(() => resource!.snapshot.status === 'success', `${order} initial read`);
        const terminal = Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' });
        if (order === 'error-first') reportTerminal(terminal);
        settle({ status: 'released' });
        if (order === 'closed-first') await new Promise((resolve) => setTimeout(resolve, 10));
        if (order === 'closed-first') reportTerminal(terminal);
        await waitFor(() => resource!.snapshot.status === 'error', `${order} terminal error`);
        expect(resource.snapshot).toMatchObject({ error: { details: { code: 'SUBSCRIPTION_OVERFLOW' } } });
        await waitFor(() => registrations === 2 && resource!.snapshot.status === 'success', `${order} paced recovery`);
      } finally {
        if (resource) store.release(resource);
        terminalControls.delete(client);
        await client.closeVfs().catch(() => {});
        client.dispose();
        await deleteVolume(fileName).catch(() => {});
      }
    }
  });

  it('ignores a delayed terminal after a replacement root watch starts', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let settle!: (value: { status: 'released' }) => void;
    let reportTerminal!: (cause: Error) => void;
    let registrations = 0;
    const closed = new Promise<{ status: 'released' }>((resolve) => {
      settle = resolve;
    });
    terminalControls.set(client, {
      subscribe(options: { onError: (cause: Error) => void }) {
        registrations++;
        if (registrations === 1) reportTerminal = options.onError;
        return Promise.resolve({
          closed: registrations === 1 ? closed : new Promise<{ status: 'released' }>(() => {}),
          unsubscribe() {},
        });
      },
    });
    let resource: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      resource = store.acquire(client.getStatus().ownerGeneration!, 'folder', '/');
      await waitFor(() => resource!.snapshot.status === 'success', 'initial read');
      settle({ status: 'released' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await resource.snapshot.refresh();
      await waitFor(() => registrations === 2 && resource!.snapshot.status === 'success', 'replacement root');
      reportTerminal(Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(registrations).toBe(2);
      expect(resource.snapshot.status).toBe('success');
    } finally {
      if (resource) store.release(resource);
      terminalControls.delete(client);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('waits for delayed retirement before opening a replacement root', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let settle!: (value: { status: 'released' }) => void;
    const closed = new Promise<{ status: 'released' }>((resolve) => (settle = resolve));
    let registrations = 0;
    terminalControls.set(client, {
      subscribe() {
        registrations++;
        return Promise.resolve({
          closed: registrations === 1 ? closed : new Promise<{ status: 'released' }>(() => {}),
          unsubscribe() {},
        });
      },
    });
    let first: ReturnType<typeof store.acquire> | undefined;
    let second: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      first = store.acquire(generation, 'folder', '/');
      await waitFor(() => first!.snapshot.status === 'success', 'first root read');
      store.release(first);
      second = store.acquire(generation, 'folder', '/');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(registrations).toBe(1);
      settle({ status: 'released' });
      await waitFor(() => registrations === 2 && second!.snapshot.status === 'success', 'replacement after retirement');
    } finally {
      if (second) store.release(second);
      terminalControls.delete(client);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('shares one initial listing and root watch across 100 consumers', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    const entries: ReturnType<typeof store.acquire>[] = [];
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const open = client.openFileChangeChannel.bind(client);
      let roots = 0;
      Object.defineProperty(client, 'openFileChangeChannel', {
        value: (...args: Parameters<typeof open>) => {
          roots++;
          return open(...args);
        },
      });
      for (let index = 0; index < 100; index++) entries.push(store.acquire(generation, 'folder', '/'));
      await waitFor(() => entries[0]!.snapshot.status === 'success', 'shared initial folder listing');
      expect(new Set(entries).size).toBe(1);
      expect(roots).toBe(1);
    } finally {
      for (const entry of entries) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('shares one root watch across 100 distinct active keys', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    const entries: ReturnType<typeof store.acquire>[] = [];
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const open = client.openFileChangeChannel.bind(client);
      let roots = 0;
      Object.defineProperty(client, 'openFileChangeChannel', {
        value: (...args: Parameters<typeof open>) => {
          roots++;
          return open(...args);
        },
      });
      for (let index = 0; index < 100; index++) entries.push(store.acquire(generation, 'file', `/missing-${index}`));
      await waitFor(() => entries.every((entry) => entry.snapshot.status === 'success'), '100 active key reads');
      expect(roots).toBe(1);
    } finally {
      for (const entry of entries) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('does not reread 100 resolved content resources for an unrelated update', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    const entries: ReturnType<typeof store.acquire>[] = [];
    let root: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const fs = client.forGeneration(generation);
      const payload = new Uint8Array(1024 * 1024);
      for (let index = 0; index < 100; index++) {
        payload[0] = index;
        await fs.writeFileBuffer(`/item-${index}`, payload);
      }
      await fs.writeFileBuffer('/unrelated', new Uint8Array([0]));
      const forGeneration = client.forGeneration.bind(client);
      let reads = 0;
      let listings = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const facade = forGeneration(owner);
          return Object.freeze({
            ...facade,
            readdirEntries: async (...args: Parameters<typeof facade.readdirEntries>) => {
              listings++;
              return facade.readdirEntries(...args);
            },
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              if (args[0].startsWith('/item-')) reads++;
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      for (let index = 0; index < 100; index++)
        entries.push(store.acquire(generation, 'content-bytes', `/item-${index}`));
      root = store.acquire(generation, 'folder', '/');
      await waitFor(
        () => entries.every((entry) => entry.snapshot.status === 'success') && root!.snapshot.status === 'success',
        '100 resolved content reads',
      );
      expect(reads).toBe(100);
      expect(listings).toBe(1);
      await fs.writeFileBuffer('/unrelated', new Uint8Array([1]));
      await waitFor(() => listings === 2, 'unrelated update reaches the root folder resource');
      expect(reads).toBe(100);
      await fs.writeFileBuffer('/item-0', new Uint8Array(1024 * 1024).fill(9));
      await waitFor(() => reads === 101, 'targeted content update');
    } finally {
      for (const entry of entries) store.release(entry);
      if (root) store.release(root);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('follows link aliases, metadata updates, and parent renames through real subscription events', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let alias: ReturnType<typeof store.acquire<string | null>> | undefined;
    let hard: ReturnType<typeof store.acquire<string | null>> | undefined;
    let metadata: ReturnType<typeof store.acquire<FileInfo | null>> | undefined;
    let parent: ReturnType<typeof store.acquire> | undefined;
    let nested: ReturnType<typeof store.acquire<string | null>> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const fs = client.forGeneration(generation);
      await fs.writeFileBuffer('/target', new TextEncoder().encode('one'));
      await fs.symlink('/target', '/alias');
      await fs.link('/target', '/hard');
      await fs.mkdir('/parent');
      await fs.writeFileBuffer('/parent/note', new Uint8Array([1]));
      alias = store.acquire(generation, 'content-text', '/alias');
      hard = store.acquire(generation, 'content-text', '/hard');
      metadata = store.acquire(generation, 'file', '/target');
      parent = store.acquire(generation, 'folder', '/parent');
      nested = store.acquire(generation, 'content-text', '/parent/note');
      await waitFor(
        () =>
          alias!.snapshot.status === 'success' &&
          hard!.snapshot.status === 'success' &&
          metadata!.snapshot.status === 'success' &&
          parent!.snapshot.status === 'success' &&
          nested!.snapshot.status === 'success',
        'link and metadata reads',
      );
      await fs.writeFileBuffer('/target', new TextEncoder().encode('two'));
      await waitFor(
        () => alias!.snapshot.data === 'two' && hard!.snapshot.data === 'two',
        'symlink and hard-link refresh',
      );
      const priorMode = metadata.snapshot.status === 'success' ? metadata.snapshot.data?.mode : undefined;
      await fs.chmod('/target', 0o100600);
      await waitFor(
        () => metadata!.snapshot.status === 'success' && metadata!.snapshot.data?.mode !== priorMode,
        'chmod refresh',
      );
      const priorMtime = metadata.snapshot.status === 'success' ? metadata.snapshot.data?.mtimeMs : undefined;
      await fs.utimes('/target', 1_000, 2_000);
      await waitFor(
        () => metadata!.snapshot.status === 'success' && metadata!.snapshot.data?.mtimeMs !== priorMtime,
        'utimes refresh',
      );
      await fs.rename('/parent', '/moved');
      await waitFor(
        () =>
          parent!.snapshot.status === 'error' &&
          nested!.snapshot.status === 'success' &&
          nested!.snapshot.data === null,
        'parent rename refresh',
      );
    } finally {
      if (alias) store.release(alias);
      if (hard) store.release(hard);
      if (metadata) store.release(metadata);
      if (parent) store.release(parent);
      if (nested) store.release(nested);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('observes a compatible follower write through the owner root watch', async () => {
    const fileName = volumeName();
    const owner = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const follower = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(owner);
    let entry: ReturnType<typeof store.acquire<string | null>> | undefined;
    try {
      await Promise.all([owner.ready, follower.ready]);
      const generation = owner.getStatus().ownerGeneration!;
      await owner.forGeneration(generation).writeFileBuffer('/note', new TextEncoder().encode('owner'));
      entry = store.acquire(generation, 'content-text', '/note');
      await waitFor(() => entry!.snapshot.status === 'success' && entry!.snapshot.data === 'owner', 'owner content');
      await follower
        .forGeneration(follower.getStatus().ownerGeneration!)
        .writeFileBuffer('/note', new TextEncoder().encode('follower'));
      await waitFor(
        () => entry!.snapshot.status === 'success' && entry!.snapshot.data === 'follower',
        'follower update',
      );
    } finally {
      if (entry) store.release(entry);
      await Promise.allSettled([owner.closeVfs(), follower.closeVfs()]);
      owner.dispose();
      follower.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('shares the root watch, refreshes changed content, and releases before reacquiring', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const subscribeStatus = client.subscribeStatus.bind(client);
    let statusObservers = 0;
    let stoppedObservers = 0;
    Object.defineProperty(client, 'subscribeStatus', {
      value: (...args: Parameters<typeof subscribeStatus>) => {
        statusObservers++;
        const stop = subscribeStatus(...args);
        return () => {
          stoppedObservers++;
          stop();
        };
      },
    });
    const store = clientStore(client);
    const open = client.openFileChangeChannel.bind(client);
    let rootChannels = 0;
    Object.defineProperty(client, 'openFileChangeChannel', {
      value: (...args: Parameters<typeof open>) => {
        rootChannels++;
        return open(...args);
      },
    });
    let first: ReturnType<typeof store.acquire<string | null>> | undefined;
    let second: ReturnType<typeof store.acquire<Uint8Array | null>> | undefined;
    let again: ReturnType<typeof store.acquire<string | null>> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const fs = client.forGeneration(generation);
      await fs.writeFileBuffer('/note', new TextEncoder().encode('one'));
      first = store.acquire(generation, 'content-text', '/note');
      second = store.acquire(generation, 'content-bytes', '/note');
      expect(statusObservers).toBe(1);
      await waitFor(
        () => first!.snapshot.status === 'success' && second!.snapshot.status === 'success',
        'initial live reads',
      );
      expect(first.snapshot.data).toBe('one');
      expect(new TextDecoder().decode(second.snapshot.data!)).toBe('one');
      expect(rootChannels).toBe(1);

      await fs.writeFileBuffer('/note', new TextEncoder().encode('two'));
      await waitFor(() => first!.snapshot.status === 'success' && first!.snapshot.data === 'two', 'watch refresh');

      store.release(first);
      expect(first.snapshot.data).toBeUndefined();
      store.release(second);
      expect(stoppedObservers).toBe(1);
      again = store.acquire(generation, 'content-text', '/note');
      await waitFor(() => again!.snapshot.status === 'success', 'reacquired live read');
      expect(again.snapshot.data).toBe('two');
      expect(rootChannels).toBe(2);
      expect(statusObservers).toBe(2);
    } finally {
      if (again) store.release(again);
      else {
        if (first) store.release(first);
        if (second) store.release(second);
      }
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('does not read when released while root registration is pending', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire> | undefined;
    let releaseOpen!: () => void;
    const heldOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const open = client.openFileChangeChannel.bind(client);
      Object.defineProperty(client, 'openFileChangeChannel', {
        value: async (...args: Parameters<typeof open>) => {
          opened();
          await heldOpen;
          return open(...args);
        },
      });
      const forGeneration = client.forGeneration.bind(client);
      let reads = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const facade = forGeneration(owner);
          return Object.freeze({
            ...facade,
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              reads++;
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      entry = store.acquire(generation, 'content-bytes', '/missing');
      await opening;
      store.release(entry);
      releaseOpen();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reads).toBe(0);
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('does not publish a released read into a same-key reacquisition', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let hold = true;
    let first: ReturnType<typeof store.acquire<Uint8Array | null>> | undefined;
    let second: ReturnType<typeof store.acquire<Uint8Array | null>> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      await client.forGeneration(generation).writeFileBuffer('/note', new Uint8Array([7]));
      const forGeneration = client.forGeneration.bind(client);
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const fs = forGeneration(owner);
          return Object.freeze({
            ...fs,
            readFileBuffer: async (...args: Parameters<typeof fs.readFileBuffer>) => {
              markReadStarted();
              if (hold) await heldRead;
              return fs.readFileBuffer(...args);
            },
          });
        },
      });
      first = store.acquire(generation, 'content-bytes', '/note');
      await waitFor(() => first!.snapshot.status === 'pending', 'held initial read');
      await readStarted;
      store.release(first);
      second = store.acquire(generation, 'content-bytes', '/note');
      hold = false;
      releaseRead();
      await waitFor(() => second!.snapshot.status === 'success', 'same-key reacquisition');
      expect(first.snapshot.data).toBeUndefined();
      expect(second.snapshot.data).toEqual(new Uint8Array([7]));
    } finally {
      if (first) store.release(first);
      if (second) store.release(second);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('runs a following read when another event arrives during a read', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire<string | null>> | undefined;
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let startedRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const fs = client.forGeneration(generation);
      await fs.writeFileBuffer('/note', new TextEncoder().encode('one'));
      const forGeneration = client.forGeneration.bind(client);
      let reads = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const facade = forGeneration(owner);
          return Object.freeze({
            ...facade,
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              reads++;
              if (reads === 2) {
                startedRead();
                await heldRead;
              }
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      entry = store.acquire(generation, 'content-text', '/note');
      await waitFor(() => entry!.snapshot.status === 'success', 'initial content');
      await fs.writeFileBuffer('/note', new TextEncoder().encode('two'));
      await readStarted;
      await fs.writeFileBuffer('/note', new TextEncoder().encode('three'));
      releaseRead();
      await waitFor(
        () => reads === 3 && entry!.snapshot.status === 'success' && entry!.snapshot.data === 'three',
        'following read',
      );
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('discards an old dependency and follows a namespace event during realpath', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire<string | null>> | undefined;
    let releaseResolution!: () => void;
    const heldResolution = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let resolutionStarted!: () => void;
    const resolutionStartedPromise = new Promise<void>((resolve) => {
      resolutionStarted = resolve;
    });
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const fs = client.forGeneration(generation);
      await fs.writeFileBuffer('/note', new TextEncoder().encode('one'));
      const forGeneration = client.forGeneration.bind(client);
      let resolutions = 0;
      let reads = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const facade = forGeneration(owner);
          return Object.freeze({
            ...facade,
            realpath: async (...args: Parameters<typeof facade.realpath>) => {
              resolutions++;
              if (resolutions === 2) {
                resolutionStarted();
                await heldResolution;
              }
              return facade.realpath(...args);
            },
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              reads++;
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      entry = store.acquire(generation, 'content-text', '/note');
      await waitFor(() => entry!.snapshot.status === 'success', 'initial resolved content');
      const refresh = entry.snapshot.refresh();
      await resolutionStartedPromise;
      await fs.mkdir('/namespace');
      releaseResolution();
      await refresh;
      await waitFor(
        () => resolutions === 3 && reads === 3 && entry!.snapshot.status === 'success',
        'namespace replacement read',
      );
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('reports EISDIR for a file resource', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      await client.forGeneration(generation).mkdir('/directory');
      entry = store.acquire(generation, 'file', '/directory');
      await waitFor(() => entry!.snapshot.status === 'error', 'directory file error');
      if (entry.snapshot.status !== 'error') throw new Error('expected file resource failure');
      expect(entry.snapshot.error.details).toMatchObject({ code: 'EISDIR' });
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('latches a normal root-registration failure until an explicit refresh', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let first: ReturnType<typeof store.acquire> | undefined;
    let second: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const open = client.openFileChangeChannel.bind(client);
      let registrations = 0;
      let reject = true;
      const forGeneration = client.forGeneration.bind(client);
      let listings = 0;
      let contents = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const facade = forGeneration(owner);
          return Object.freeze({
            ...facade,
            readdirEntries: async (...args: Parameters<typeof facade.readdirEntries>) => {
              listings++;
              return facade.readdirEntries(...args);
            },
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              contents++;
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      Object.defineProperty(client, 'openFileChangeChannel', {
        value: (...args: Parameters<typeof open>) => {
          registrations++;
          if (reject) return Promise.reject(Object.assign(new Error('subscription unavailable'), { code: 'EIO' }));
          return open(...args);
        },
      });
      first = store.acquire(generation, 'folder', '/');
      second = store.acquire(generation, 'content-bytes', '/missing');
      await waitFor(
        () => first!.snapshot.status === 'error' && second!.snapshot.status === 'error',
        'shared registration failure',
      );
      expect(registrations).toBe(1);

      reject = false;
      await first.snapshot.refresh();
      await waitFor(
        () => first!.snapshot.status === 'success' && second!.snapshot.status === 'success',
        'manual shared root retry',
      );
      expect(registrations).toBe(2);
      expect(listings).toBe(1);
      expect(contents).toBe(1);
    } finally {
      if (first) store.release(first);
      if (second) store.release(second);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('paces an overflow replacement and lets refresh join it', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const open = client.openFileChangeChannel.bind(client);
      let registrations = 0;
      Object.defineProperty(client, 'openFileChangeChannel', {
        value: (...args: Parameters<typeof open>) => {
          registrations++;
          if (registrations === 1)
            return Promise.reject(Object.assign(new Error('overflow'), { code: 'SUBSCRIPTION_OVERFLOW' }));
          return open(...args);
        },
      });
      entry = store.acquire(generation, 'folder', '/');
      await waitFor(() => entry!.snapshot.status === 'error', 'overflow result');
      const joined = entry.snapshot.refresh();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(registrations).toBe(1);
      await joined;
      await waitFor(() => entry!.snapshot.status === 'success', 'paced replacement scan');
      expect(registrations).toBe(2);
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('targets resolved file updates and rescans after namespace changes', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const fs = client.forGeneration(generation);
      await fs.writeFileBuffer('/note', new Uint8Array([1]));
      await fs.writeFileBuffer('/other', new Uint8Array([2]));
      const forGeneration = client.forGeneration.bind(client);
      let reads = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const facade = forGeneration(owner);
          return Object.freeze({
            ...facade,
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              if (args[0] === '/note') reads++;
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      entry = store.acquire(generation, 'content-bytes', '/note');
      await waitFor(() => entry!.snapshot.status === 'success', 'initial resolved read');
      expect(reads).toBe(1);
      await fs.writeFileBuffer('/other', new Uint8Array([3]));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reads).toBe(1);
      await fs.mkdir('/directory');
      await waitFor(() => reads === 2, 'namespace rescan');
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('does not turn an EACCES message mentioning ENOENT into missing content', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire> | undefined;
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const forGeneration = client.forGeneration.bind(client);
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const fs = forGeneration(owner);
          return Object.freeze({
            ...fs,
            readFileBuffer: async () => {
              throw Object.assign(new Error('EACCES while checking ENOENT'), { code: 'EACCES' });
            },
          });
        },
      });
      entry = store.acquire(generation, 'content-bytes', '/private');
      await waitFor(() => entry!.snapshot.status === 'error', 'EACCES content error');
      if (entry.snapshot.status !== 'error') throw new Error('expected content error');
      expect(entry.snapshot.error.details).toMatchObject({ code: 'EACCES' });
    } finally {
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('reports each failed attempt once per active binding without replaying history', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(client);
    let entry: ReturnType<typeof store.acquire> | undefined;
    let stopFirst = () => {};
    let stopSecond = () => {};
    let stopLate = () => {};
    try {
      await client.ready;
      const generation = client.getStatus().ownerGeneration!;
      const forGeneration = client.forGeneration.bind(client);
      Object.defineProperty(client, 'forGeneration', {
        value: (owner: string) => {
          const fs = forGeneration(owner);
          return Object.freeze({
            ...fs,
            readFileBuffer: async () => {
              throw Object.assign(new Error('denied'), { code: 'EACCES' });
            },
          });
        },
      });
      entry = store.acquire(generation, 'content-bytes', '/private');
      const reports: string[] = [];
      const binding = {};
      stopFirst = store.reportFailures(entry, binding, (error) => reports.push(error.details?.code ?? 'unknown'));
      stopSecond = store.reportFailures(entry, binding, (error) => reports.push(error.details?.code ?? 'unknown'));
      await waitFor(() => entry!.snapshot.status === 'error' && reports.length === 1, 'first provider report');
      stopFirst();
      await entry.snapshot.refresh();
      await waitFor(() => reports.length === 2, 'remaining hook provider report');

      const lateReports: string[] = [];
      stopLate = store.reportFailures(entry, {}, (error) => lateReports.push(error.details?.code ?? 'unknown'));
      await Promise.resolve();
      expect(lateReports).toEqual([]);
      await entry.snapshot.refresh();
      await waitFor(() => reports.length === 3 && lateReports.length === 1, 'new failure reports active bindings');
    } finally {
      stopFirst();
      stopSecond();
      stopLate();
      if (entry) store.release(entry);
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('exposes an actionable error when follower resume leaves retirement unknown', async () => {
    const fileName = volumeName();
    const owner = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const follower = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const store = clientStore(follower);
    let entry: ReturnType<typeof store.acquire> | undefined;
    try {
      await owner.ready;
      await follower.ready;
      const generation = follower.getStatus().ownerGeneration!;
      entry = store.acquire(generation, 'folder', '/');
      await waitFor(() => entry!.snapshot.status === 'success', 'follower initial read');
      document.dispatchEvent(new Event('resume'));
      await waitFor(() => follower.getStatus().state === 'recovering', 'follower recovering');
      await waitFor(
        () => follower.getStatus().state === 'ready' && follower.getStatus().ownerGeneration === generation,
        'same generation ready',
      );
      await waitFor(() => entry!.snapshot.status === 'error', 'follower resume result');
      if (entry.snapshot.status !== 'error') throw new Error('expected subscription error');
      expect(entry.snapshot.error).toMatchObject({
        kind: 'subscription',
        operation: 'readdirEntries',
        details: { code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN' },
      });
      await expect(entry.snapshot.refresh()).resolves.toBeUndefined();
    } finally {
      if (entry) store.release(entry);
      await Promise.allSettled([owner.closeVfs(), follower.closeVfs()]);
      owner.dispose();
      follower.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });
});

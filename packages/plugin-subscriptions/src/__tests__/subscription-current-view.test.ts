import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { ChangeFrame, FileChangeChannel } from '@opfs-vfs/opfs-vfs/changes';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { describe, expect, it, vi } from 'vitest';
import { startCurrentView } from '../../examples/current-view';
import { subscribe, type Subscription } from '@opfs-vfs/plugin-subscriptions/client';
import { subscriptionsRequest } from '../config';

const worker = () => new Worker(new URL('./subscription-content-worker.ts', import.meta.url), { type: 'module' });

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('current view timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function wrapped(fs: OpfsVfsWorker) {
  let hold = false;
  let holdInitialRead = false;
  let holdScan = false;
  let holdStat = false;
  let holdIncluded: string | undefined;
  let fail: Error | undefined;
  let failHeld: { code: string } | undefined;
  let release!: () => void;
  let allowInitialRead!: () => void;
  let started!: () => void;
  let releaseScan!: () => void;
  let scanned!: () => void;
  let continueStat!: () => void;
  let stated!: () => void;
  let deliverIncluded!: () => void;
  let interruptChannel!: () => void;
  let finished!: () => void;
  const readStarted = new Promise<void>((resolve) => (started = resolve));
  let readFinished = new Promise<void>((resolve) => (finished = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const initialReadGate = new Promise<void>((resolve) => (allowInitialRead = resolve));
  const scanGate = new Promise<void>((resolve) => (releaseScan = resolve));
  const scanStarted = new Promise<void>((resolve) => (scanned = resolve));
  const statGate = new Promise<void>((resolve) => (continueStat = resolve));
  const statStarted = new Promise<void>((resolve) => (stated = resolve));
  let heldIncluded = 0;
  const includedWaiters: { target: number; resolve: () => void }[] = [];
  const deliveryPaths = new Map<number, string>();
  const acknowledgements = new Map<string, number>();
  const ackWaiters = new Map<string, { target: number; resolve: () => void }[]>();
  const acknowledged = (path: string) => {
    const count = (acknowledgements.get(path) ?? 0) + 1;
    acknowledgements.set(path, count);
    const waiters = ackWaiters.get(path) ?? [];
    ackWaiters.set(
      path,
      waiters.filter((waiter) => {
        if (waiter.target > count) return true;
        waiter.resolve();
        return false;
      }),
    );
  };
  const included = () => {
    heldIncluded++;
    for (const waiter of includedWaiters.splice(0)) {
      if (waiter.target <= heldIncluded) waiter.resolve();
      else includedWaiters.push(waiter);
    }
  };
  let reads = 0;
  let activeReads = 0;
  let maxReads = 0;
  return {
    fs: {
      openFileChangeChannel(
        receive: (frame: ChangeFrame) => void,
        interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
        closed: () => void,
      ): Promise<FileChangeChannel> {
        interruptChannel = () => interrupted('SUBSCRIPTION_INTERRUPTED');
        return fs
          .openFileChangeChannel(
            (frame) => {
              if (frame.type === 'event') {
                deliveryPaths.set(frame.deliveryId, frame.change.path);
                if (holdIncluded === frame.change.path && frame.change.content.status === 'included') {
                  holdIncluded = undefined;
                  deliverIncluded = () => receive(frame);
                  included();
                  return;
                }
              }
              receive(frame);
            },
            interrupted,
            closed,
          )
          .then(
            (channel) =>
              ({
                generation: channel.generation,
                request(command) {
                  return channel.request(command).then((reply) => {
                    if (command.type === 'ack') {
                      const path = deliveryPaths.get(command.deliveryId);
                      if (path) acknowledged(path);
                    }
                    return reply;
                  });
                },
                close() {
                  channel.close();
                },
              }) as FileChangeChannel,
          );
      },
      async lstat(path: string) {
        if (holdInitialRead && path === '/') {
          holdInitialRead = false;
          await initialReadGate;
        }
        const stat = await fs.lstat(path);
        if (holdStat && path === '/document') {
          holdStat = false;
          stated();
          await statGate;
        }
        return stat;
      },
      async readdir(path: string) {
        const names = await fs.readdir(path);
        if (holdScan && path === '/') {
          holdScan = false;
          scanned();
          await scanGate;
        }
        return names;
      },
      async readFileBuffer(path: string) {
        reads++;
        activeReads++;
        maxReads = Math.max(maxReads, activeReads);
        try {
          const bytes = await fs.readFileBuffer(path);
          if (fail && path === '/document') {
            const cause = fail;
            fail = undefined;
            throw cause;
          }
          if (hold && path === '/document') {
            hold = false;
            started();
            await gate;
            if (failHeld) throw failHeld;
          }
          return bytes;
        } finally {
          activeReads--;
          finished();
        }
      },
    },
    holdRead() {
      hold = true;
      readFinished = new Promise<void>((resolve) => (finished = resolve));
    },
    holdInitialRead() {
      holdInitialRead = true;
    },
    holdInitialScan() {
      holdScan = true;
    },
    holdNextIncluded(path: string) {
      holdIncluded = path;
    },
    holdNextStat() {
      holdStat = true;
    },
    rejectHeldAsMissing() {
      failHeld = { code: 'ENOENT' };
    },
    failRead() {
      fail = new Error('controlled read failure');
    },
    releaseRead() {
      release();
    },
    releaseInitialRead() {
      allowInitialRead();
    },
    releaseInitialScan() {
      releaseScan();
    },
    releaseIncluded() {
      deliverIncluded();
    },
    releaseStat() {
      continueStat();
    },
    interrupt() {
      interruptChannel();
    },
    includedAfter() {
      const target = heldIncluded + 1;
      return new Promise<void>((resolve) => includedWaiters.push({ target, resolve }));
    },
    ackAfter(path: string) {
      const target = (acknowledgements.get(path) ?? 0) + 1;
      return new Promise<void>((resolve) => {
        const waiters = ackWaiters.get(path) ?? [];
        waiters.push({ target, resolve });
        ackWaiters.set(path, waiters);
      });
    },
    readStarted,
    readFinished: () => readFinished,
    scanStarted,
    statStarted,
    reads: () => reads,
    maxReads: () => maxReads,
  };
}

describe('current-view recovery example', () => {
  it('collects a write delivered after registration while the initial scan is held', async () => {
    const name = `current-view-scan-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      const controlled = wrapped(fs);
      controlled.holdInitialScan();
      const attempt = await startCurrentView(controlled.fs, { root: '/', onError() {} });
      await controlled.scanStarted;
      const acknowledged = controlled.ackAfter('/during-scan');
      await fs.writeFileBuffer('/during-scan', new Uint8Array([7]));
      await acknowledged;
      controlled.releaseInitialScan();
      await attempt.ready;
      await waitFor(() => attempt.files.get('/during-scan')?.[0] === 7);
      expect([...attempt.files.get('/during-scan')!]).toEqual([7]);
      attempt.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('collects a write made after registration before initial enumeration starts', async () => {
    const name = `current-view-before-scan-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      const controlled = wrapped(fs);
      controlled.holdInitialRead();
      const attempt = await startCurrentView(controlled.fs, { root: '/', onError() {} });
      await fs.writeFileBuffer('/before-scan', new Uint8Array([8]));
      controlled.releaseInitialRead();
      await attempt.ready;
      expect([...attempt.files.get('/before-scan')!]).toEqual([8]);
      attempt.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('keeps the last value visible while a reread is held', async () => {
    const name = `current-view-held-read-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.writeFileBuffer('/document', new Uint8Array([1]));
      const controlled = wrapped(fs);
      const attempt = await startCurrentView(controlled.fs, { root: '/', onError() {} });
      await attempt.ready;
      controlled.holdRead();
      await fs.writeFileBuffer('/document', new Uint8Array([2]));
      await controlled.readStarted;
      expect([...attempt.files.get('/document')!]).toEqual([1]);
      controlled.releaseRead();
      await waitFor(() => attempt.files.get('/document')?.[0] === 2);
      attempt.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('does not leave an unhandled ready rejection when stopped during the scan', async () => {
    const name = `current-view-stop-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    const rejections: PromiseRejectionEvent[] = [];
    const rejected = (event: PromiseRejectionEvent) => rejections.push(event);
    addEventListener('unhandledrejection', rejected);
    try {
      await fs.ready;
      const controlled = wrapped(fs);
      controlled.holdInitialScan();
      const attempt = await startCurrentView(controlled.fs, { root: '/', onError() {} });
      await controlled.scanStarted;
      attempt.stop();
      await new Promise((resolve) => setTimeout(resolve));
      expect(rejections).toEqual([]);
      await expect(attempt.ready).rejects.toThrow('Current view stopped');
      controlled.releaseInitialScan();
    } finally {
      removeEventListener('unhandledrejection', rejected);
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('uses filesystem rereads instead of delayed historical payloads', async () => {
    const name = `current-view-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.writeFileBuffer('/document', new Uint8Array([0]));
      const controlled = wrapped(fs);
      const errors: unknown[] = [];
      controlled.holdInitialScan();
      controlled.holdNextIncluded('/document');
      const attempt = await startCurrentView(controlled.fs, {
        root: '/',
        content: { maxBytes: 16 },
        onError: (cause) => {
          errors.push(cause);
        },
      });
      await controlled.scanStarted;
      const heldA = controlled.includedAfter();
      await fs.writeFileBuffer('/document', new Uint8Array([1]));
      await heldA;
      await fs.writeFileBuffer('/document', new Uint8Array([2]));
      controlled.releaseInitialScan();
      await attempt.ready;
      expect([...attempt.files.get('/document')!]).toEqual([2]);

      controlled.holdNextStat();
      const heldB = controlled.includedAfter();
      const acknowledgedA = controlled.ackAfter('/document');
      controlled.holdNextIncluded('/document');
      controlled.releaseIncluded();
      await acknowledgedA;
      await Promise.all([heldB, controlled.statStarted]);
      expect([...attempt.files.get('/document')!]).toEqual([2]);
      const acknowledgedB = controlled.ackAfter('/document');
      controlled.releaseIncluded();
      controlled.releaseStat();
      await acknowledgedB;
      await waitFor(() => attempt.files.get('/document')?.[0] === 2);

      const readsBefore = controlled.reads();
      controlled.holdRead();
      const acknowledgedC = controlled.ackAfter('/document');
      await fs.writeFileBuffer('/document', new Uint8Array([3]));
      await controlled.readStarted;
      expect([...attempt.files.get('/document')!]).toEqual([2]);
      await acknowledgedC;
      const acknowledgedD = controlled.ackAfter('/document');
      await fs.writeFileBuffer('/document', new Uint8Array([4]));
      await acknowledgedD;
      controlled.releaseRead();
      await waitFor(() => controlled.reads() >= readsBefore + 2 && attempt.files.get('/document')?.[0] === 4);
      expect([...attempt.files.get('/document')!]).toEqual([4]);
      expect(controlled.maxReads()).toBe(1);

      await fs.unlink('/document');
      await waitFor(() => !attempt.files.has('/document'));
      expect(errors).toEqual([]);
      attempt.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('abandons a bounded pending set and fences an old held read from an independent restart', async () => {
    const name = `current-view-restart-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.writeFileBuffer('/document', new Uint8Array([1]));
      const controlled = wrapped(fs);
      const errors: unknown[] = [];
      const first = await startCurrentView(controlled.fs, {
        root: '/',
        maxPending: 1,
        onError: (cause) => {
          errors.push(cause);
        },
      });
      await first.ready;
      controlled.holdRead();
      await fs.writeFileBuffer('/document', new Uint8Array([2]));
      await controlled.readStarted;
      await fs.writeFileBuffer('/other', new Uint8Array([3]));
      await fs.writeFileBuffer('/third', new Uint8Array([4]));
      await waitFor(() => errors.length === 1 && first.files.size === 0);

      const replacement = await first.restart();
      await replacement.ready;
      expect([...replacement.files.get('/document')!]).toEqual([2]);
      expect([...replacement.files.get('/other')!]).toEqual([3]);
      expect([...replacement.files.get('/third')!]).toEqual([4]);

      controlled.releaseRead();
      await controlled.readFinished();
      await fs.stat('/document');
      expect(first.files.size).toBe(0);
      replacement.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('fences a late ENOENT from an abandoned attempt', async () => {
    const name = `current-view-enoent-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.writeFileBuffer('/document', new Uint8Array([1]));
      const controlled = wrapped(fs);
      const first = await startCurrentView(controlled.fs, { root: '/', maxPending: 1, onError() {} });
      await first.ready;
      controlled.holdRead();
      await fs.writeFileBuffer('/document', new Uint8Array([2]));
      await controlled.readStarted;
      await fs.writeFileBuffer('/other', new Uint8Array([3]));
      await fs.writeFileBuffer('/third', new Uint8Array([4]));
      const replacement = await first.restart();
      await replacement.ready;
      const staleDeletes = vi.spyOn(first.files as Map<string, Uint8Array>, 'delete');
      controlled.rejectHeldAsMissing();
      controlled.releaseRead();
      await controlled.readFinished();
      await fs.stat('/document');
      expect(staleDeletes).not.toHaveBeenCalled();
      expect(first.files.size).toBe(0);
      expect([...replacement.files.get('/document')!]).toEqual([2]);
      replacement.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('abandons the candidate when its channel is interrupted', async () => {
    const name = `current-view-interrupted-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.writeFileBuffer('/document', new Uint8Array([1]));
      const controlled = wrapped(fs);
      const errors: unknown[] = [];
      const attempt = await startCurrentView(controlled.fs, {
        root: '/',
        onError: (cause) => {
          errors.push(cause);
        },
      });
      await attempt.ready;
      controlled.interrupt();
      await waitFor(() => errors.length === 1 && attempt.files.size === 0);
      expect(errors[0]).toMatchObject({ code: 'SUBSCRIPTION_INTERRUPTED' });
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('refreshes renamed directories and never follows a directory symlink while scanning', async () => {
    const name = `current-view-directory-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.mkdir('/folder');
      await fs.writeFileBuffer('/folder/a', new Uint8Array([1]));
      await fs.symlink('/folder', '/cycle');
      const errors: unknown[] = [];
      const attempt = await startCurrentView(fs, {
        root: '/./',
        onError: (cause) => {
          errors.push(cause);
        },
      });
      await attempt.ready;
      expect([...attempt.files.get('/folder/a')!]).toEqual([1]);
      expect(attempt.files.has('/cycle/a')).toBe(false);

      await fs.rename('/folder', '/renamed');
      await waitFor(() => !attempt.files.has('/folder/a') && attempt.files.get('/renamed/a')?.[0] === 1);

      await fs.writeFileBuffer('/switch', new Uint8Array([2]));
      await waitFor(() => attempt.files.get('/switch')?.[0] === 2);
      await fs.unlink('/switch');
      await fs.mkdir('/switch');
      await fs.writeFileBuffer('/switch/child', new Uint8Array([3]));
      await waitFor(() => !attempt.files.has('/switch') && attempt.files.get('/switch/child')?.[0] === 3);
      await fs.unlink('/switch/child');
      await fs.rmdir('/switch');
      await fs.writeFileBuffer('/switch', new Uint8Array([4]));
      await waitFor(() => attempt.files.get('/switch')?.[0] === 4 && !attempt.files.has('/switch/child'));
      expect(errors).toEqual([]);
      attempt.stop();
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('reports a post-ready non-ENOENT read failure and discards the candidate', async () => {
    const name = `current-view-error-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    try {
      await fs.ready;
      await fs.writeFileBuffer('/document', new Uint8Array([1]));
      const controlled = wrapped(fs);
      const errors: unknown[] = [];
      const attempt = await startCurrentView(controlled.fs, {
        root: '/',
        onError: (cause) => {
          errors.push(cause);
        },
      });
      await attempt.ready;
      controlled.failRead();
      await fs.writeFileBuffer('/document', new Uint8Array([2]));
      await waitFor(() => errors.length === 1 && attempt.files.size === 0);
    } finally {
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  });

  it('abandons on a real staging-limit terminal while an unrelated watcher remains live', async () => {
    const name = `current-view-terminal-${crypto.randomUUID()}.bin`;
    const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    let unrelated: Subscription | undefined;
    try {
      await fs.ready;
      await fs.mkdir('/source');
      await fs.mkdir('/unrelated');
      for (let index = 0; index < 2048; index++)
        await fs.writeFileBuffer(`/source/${index}`, new Uint8Array([index & 255]));
      const errors: unknown[] = [];
      const attempt = await startCurrentView(fs, {
        root: '/',
        maxPending: 8192,
        onError: (cause) => {
          errors.push(cause);
        },
      });
      await attempt.ready;
      let unrelatedEvents = 0;
      const unrelatedErrors: unknown[] = [];
      unrelated = await subscribe(
        fs,
        {
          path: '/unrelated',
          scope: 'directory',
          recursive: true,
          onError: (cause) => {
            unrelatedErrors.push(cause);
          },
        },
        () => {
          unrelatedEvents++;
        },
      );
      await fs.rename('/source', '/destination');
      await waitFor(() => errors.length === 1 && attempt.files.size === 0, 30000);
      expect(errors[0]).toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' });
      const replacement = await attempt.restart();
      await replacement.ready;
      expect([...replacement.files.get('/destination/0')!]).toEqual([0]);
      expect([...replacement.files.get('/destination/2047')!]).toEqual([255]);
      await fs.writeFileBuffer('/unrelated/ok', new Uint8Array([1]));
      await waitFor(() => unrelatedEvents === 1);
      await waitFor(() => replacement.files.get('/unrelated/ok')?.[0] === 1);
      expect(unrelatedErrors).toEqual([]);
      replacement.stop();
      unrelated.unsubscribe();
    } finally {
      unrelated?.unsubscribe();
      await fs.closeVfs().catch(() => fs.dispose());
      fs.dispose();
      await deleteVolume(name);
    }
  }, 60000);
});

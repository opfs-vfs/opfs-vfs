import { describe, expect, it, vi } from 'vitest';
import { deleteVolume } from '../index';
import { OpfsVfsWorker } from '../index_internal';
import { peekVolume } from '../peek-volume';
import { closeVolume } from '../volume-files';
import { CURRENT_BINARY_VERSION } from '../binary-metadata';

function run(payload: Record<string, unknown>) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./volume-audit-worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string) => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timer = setTimeout(() => finish('volume worker timed out'), 15000);
    worker.onerror = (event) => finish(event.message);
    worker.onmessage = ({ data }) => finish(data.error);
    worker.postMessage(payload);
  });
}

describe('Volume audit regressions', () => {
  it('awaits ownership release before reporting a failed close to another realm', async () => {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const error = new Error('flush failed');
    let calls = 0;
    let settled = false;
    const outcome = closeVolume({
      closeVfs() {
        if (++calls === 1) throw error;
        return completion;
      },
    }).then(
      () => undefined,
      (caught) => {
        settled = true;
        return caught;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await outcome).toBe(error);
    expect(calls).toBe(2);
  });
  it('acknowledges worker close only after another realm can delete the volume', async () => {
    const name = `worker-close-${crypto.randomUUID()}.bin`;
    const vfs = new OpfsVfsWorker(name, { forceLeader: true });
    try {
      await vfs.ready;
      await vfs.closeVfs();
      expect(await peekVolume(name)).toMatchObject({
        exists: true,
        encrypted: false,
        metadataVersion: CURRENT_BINARY_VERSION,
        compatible: true,
      });
      await deleteVolume(name);
      expect((await peekVolume(name)).exists).toBe(false);
    } finally {
      vfs.dispose();
    }
  });
  it('can re-INIT the same worker and volume immediately', async () => {
    const name = `worker-reinit-${crypto.randomUUID()}.bin`;
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    let id = 0;
    const send = (type: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker request timed out')), 10000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          if (data.type === 'ERROR') reject(new Error(data.result.error));
          else resolve();
        };
        worker.postMessage({
          id: ++id,
          type,
          payload: type === 'INIT' ? { fileName: name, generation: crypto.randomUUID() } : { fileName: name },
        });
      });
    try {
      await send('INIT');
      await send('INIT');
      await send('CLOSE_VFS');
      await deleteVolume(name);
    } finally {
      worker.terminate();
    }
  });
  for (const synchronous of [false, true]) {
    it(`propagates failed Web Lock requests without accessing OPFS, synchronous=${synchronous}`, async () => {
      const error = new DOMException('locks denied', 'SecurityError');
      const request = vi.spyOn(navigator.locks, 'request').mockImplementation(() => {
        if (synchronous) throw error;
        return Promise.reject(error);
      });
      const directory = vi.spyOn(navigator.storage, 'getDirectory');
      try {
        await expect(deleteVolume('denied.bin')).rejects.toBe(error);
        expect(directory).not.toHaveBeenCalled();
      } finally {
        request.mockRestore();
        directory.mockRestore();
      }
    });
  }
  it('does not join an existing leader or later promote when create-new is requested', async () => {
    const name = `worker-volume-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name);
    let follower: OpfsVfsWorker | undefined;
    try {
      await leader.ready;
      await leader.mkdir('/kept');
      follower = new OpfsVfsWorker(name, { openMode: 'create-new' });
      await expect(follower.ready).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await leader.exists('/kept')).toBe(true);
      await leader.closeVfs();
      await expect(follower.mkdir('/unexpected')).rejects.toThrow();
      expect((follower as unknown as { worker: Worker | null }).worker).toBeNull();
    } finally {
      follower?.dispose();
      leader.dispose();
      await deleteVolume(name);
    }
  }, 10000);
  it('forwards open modes to the worker and validates names before creating files', async () => {
    const name = `worker-volume-${crypto.randomUUID()}.bin`;
    const missing = new OpfsVfsWorker(name, { forceLeader: true, openMode: 'open-existing' });
    await expect(missing.ready).rejects.toThrow();
    missing.dispose();
    expect((await peekVolume(name)).exists).toBe(false);
    const created = new OpfsVfsWorker(name, { forceLeader: true, openMode: 'create-new' });
    await created.ready;
    await created.closeVfs();
    const occupied = new OpfsVfsWorker(name, { forceLeader: true, openMode: 'create-new' });
    await expect(occupied.ready).rejects.toMatchObject({ code: 'EEXIST' });
    occupied.dispose();
    const invalid = new OpfsVfsWorker(name.slice(0, -4), { forceLeader: true });
    await expect(invalid.ready).rejects.toMatchObject({ code: 'EINVAL' });
    invalid.dispose();
    await expect(peekVolume(name.slice(0, -4))).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(deleteVolume(name.slice(0, -4))).rejects.toMatchObject({ code: 'EINVAL' });
    const root = await navigator.storage.getDirectory();
    await expect(root.getFileHandle(name.slice(0, -4))).rejects.toMatchObject({ name: 'NotFoundError' });
    await deleteVolume(name);
  });

  it('propagates unreadable sidecar errors', async () => {
    const root = await navigator.storage.getDirectory();
    const error = new DOMException('lookup denied', 'SecurityError');
    const get = vi.spyOn(navigator.storage, 'getDirectory').mockResolvedValue(
      new Proxy(root, {
        get(target, key) {
          if (key === 'getFileHandle')
            return async () => {
              throw error;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    try {
      await expect(peekVolume('unreadable.bin')).rejects.toBe(error);
    } finally {
      get.mockRestore();
    }
  });

  it('stops deletion at the first non-missing sidecar error', async () => {
    const removed: string[] = [];
    const error = new DOMException('locked sidecar', 'NoModificationAllowedError');
    const root = await navigator.storage.getDirectory();
    const get = vi.spyOn(navigator.storage, 'getDirectory').mockResolvedValue(
      new Proxy(root, {
        get(target, key) {
          if (key === 'removeEntry')
            return async (name: string) => {
              removed.push(name);
              if (name.endsWith('.meta.b')) throw error;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    try {
      await expect(deleteVolume('delete-audit.bin')).rejects.toBe(error);
      // Metadata goes first so an interrupted delete can never mount over an empty .bin.
      expect(removed).toEqual(['delete-audit.meta.a', 'delete-audit.meta.b']);
    } finally {
      get.mockRestore();
    }
  });
  it('rejects deletion of a mounted volume and deletes it after close', () => run({ scenario: 'delete' }), 20000);
  it(
    'retains ownership until cancelled initialization finishes',
    () => run({ scenario: 'delayed', closeDuringInit: true }),
    20000,
  );
  it(
    'closes before initialization without creating files or leaking ownership',
    () => run({ scenario: 'earlyClose' }),
    20000,
  );
  it('holds ownership while initialization is paused', () => run({ scenario: 'delayed' }), 20000);
  it('allows only one concurrent creator', () => run({ scenario: 'concurrent' }), 20000);

  for (const suffix of [
    '.bin',
    '.meta.a',
    '.meta.b',
    '.bitmap',
    '.meta.log',
    '.data.log',
    '.bootstrap',
    '.vault',
    '.crypt',
    '.crypt.log',
    '.meta',
    '.importing',
  ]) {
    for (const size of [0, 3]) {
      it(`peek recognizes an isolated ${size}-byte ${suffix}`, async () => {
        const base = `peek-audit-${crypto.randomUUID()}`;
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(base + suffix, { create: true });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(size));
        await writer.close();
        try {
          expect(await peekVolume(base + '.bin')).toMatchObject({
            exists: true,
            encrypted: ['.vault', '.crypt', '.crypt.log'].includes(suffix),
            importing: suffix === '.importing',
            compatible: 'unknown',
          });
        } finally {
          await root.removeEntry(base + suffix);
        }
      });
    }
  }
  it('reports importing and encryption independently for damaged protection markers', async () => {
    const base = `peek-import-${crypto.randomUUID()}`;
    const root = await navigator.storage.getDirectory();
    for (const suffix of ['.importing', '.vault']) {
      const handle = await root.getFileHandle(base + suffix, { create: true });
      const writer = await handle.createWritable();
      await writer.write(new Uint8Array(suffix === '.importing' ? 3 : 0));
      await writer.close();
    }
    try {
      expect(await peekVolume(base + '.bin')).toMatchObject({
        exists: true,
        encrypted: true,
        importing: true,
        compatible: 'unknown',
      });
    } finally {
      await deleteVolume(base + '.bin');
    }
  });
  it('deletes import reservations after metadata and data', async () => {
    const removed: string[] = [];
    const root = await navigator.storage.getDirectory();
    const get = vi.spyOn(navigator.storage, 'getDirectory').mockResolvedValue(
      new Proxy(root, {
        get(target, key) {
          if (key === 'removeEntry')
            return async (name: string) => {
              removed.push(name);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    try {
      await deleteVolume('order.bin');
      expect(removed.slice(0, 3)).toEqual(['order.meta.a', 'order.meta.b', 'order.meta.log']);
      expect(removed.at(-1)).toBe('order.importing');
    } finally {
      get.mockRestore();
    }
  });
  it('propagates unavailable OPFS instead of claiming a fresh volume', async () => {
    const error = new DOMException('access denied', 'SecurityError');
    const get = vi.spyOn(navigator.storage, 'getDirectory').mockRejectedValue(error);
    try {
      await expect(peekVolume('missing.bin')).rejects.toBe(error);
    } finally {
      get.mockRestore();
    }
  });
});

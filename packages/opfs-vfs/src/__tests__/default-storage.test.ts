import { expect, it, vi } from 'vitest';
import { deleteVolume, OpenFlags } from '../index';
import { OpfsVfsWorker } from '../index_internal';

it.each([
  { options: {}, expected: { bufferMode: 'disk', localDurabilityMode: 'balanced' } },
  {
    options: { bufferMode: 'memory' as const, localDurabilityMode: 'relaxed' as const },
    expected: { bufferMode: 'memory', localDurabilityMode: 'relaxed' },
  },
])('worker client forwards storage defaults and explicit overrides: $expected', async ({ options, expected }) => {
  const post = vi.spyOn(Worker.prototype, 'postMessage');
  const name = `default-client-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfsWorker(name, { forceLeader: true, ...options });
  try {
    await fs.ready;
    expect(post.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ type: 'INIT', payload: expect.objectContaining(expected) }),
    );
    const fd = await fs.open('/hello.txt', true);
    await fs.write(fd, new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode((await fs.read(fd, 5, 0)).buffer)).toBe('hello');
    await fs.close(fd);
  } finally {
    post.mockRestore();
    await fs.closeVfs();
    await deleteVolume(name);
  }
});

it('raw INIT without storage options checkpoints to disk before worker termination', async () => {
  const name = `default-init-${crypto.randomUUID()}.bin`;
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  let id = 0;
  const request = (type: string, payload: Record<string, unknown>, data?: Uint8Array) =>
    new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${type} timed out`)), 3000);
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data: response }) => {
        clearTimeout(timeout);
        if (response.type === 'ERROR') reject(new Error(response.result.error));
        else resolve(response.result);
      };
      worker.postMessage({ id: ++id, type, payload, data });
    });
  try {
    await request('INIT', { fileName: name, generation: crypto.randomUUID() });
    const root = await navigator.storage.getDirectory();
    const log = await root.getFileHandle(name.replace(/\.bin$/, '.meta.log'));
    const readLog = async () => Array.from(new Uint8Array(await (await log.getFile()).arrayBuffer()));
    const before = await readLog();
    const fd = await request('OPEN', { path: '/saved.txt', flags: OpenFlags.O_CREAT | OpenFlags.O_RDWR });
    await request('WRITE', { fd }, new TextEncoder().encode('saved automatically'));
    // No SYNC, FLUSH, or CLOSE_VFS request may create this checkpoint.
    await expect.poll(readLog, { timeout: 3000 }).not.toEqual(before);
    worker.terminate();
    await navigator.locks.request(`opfs-vfs-volume-${name}`, { signal: AbortSignal.timeout(3000) }, () => {});
    const reopened = new OpfsVfsWorker(name, { forceLeader: true });
    try {
      await reopened.ready;
      const readFd = await reopened.open('/saved.txt', false);
      expect(new TextDecoder().decode((await reopened.read(readFd, 64)).buffer)).toBe('saved automatically');
      await reopened.close(readFd);
    } finally {
      await reopened.closeVfs();
    }
  } finally {
    worker.terminate();
    await navigator.locks.request(`opfs-vfs-volume-${name}`, { signal: AbortSignal.timeout(3000) }, () => {});
    await deleteVolume(name);
  }
});

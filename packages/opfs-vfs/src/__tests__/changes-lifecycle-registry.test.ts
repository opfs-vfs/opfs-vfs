import { afterEach, expect, it } from 'vitest';
import { deleteVolume } from '../volume-files';

const workers: Worker[] = [];
const names: string[] = [];
const fileName = () => {
  const value = `changes-registry-${crypto.randomUUID()}.bin`;
  names.push(value);
  return value;
};
let id = 0;
const send = (worker: Worker, type: string, payload: Record<string, unknown>) =>
  new Promise<{ type: string; result?: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 10_000);
    const message = ({ data }: MessageEvent) => {
      if (data.id !== id) return;
      clearTimeout(timer);
      worker.removeEventListener('message', message);
      resolve(data);
    };
    worker.addEventListener('message', message);
    worker.postMessage({ id: ++id, type, payload });
  });
const init = (worker: Worker, name: string, options: Record<string, unknown> = {}) =>
  send(worker, 'INIT', {
    fileName: name,
    generation: crypto.randomUUID(),
    plugins: [{ id: 'logical-reuse', contractVersion: 1, compatibilityKey: 'logical-reuse', options }],
  });

afterEach(async () => {
  for (const worker of workers.splice(0)) worker.terminate();
  for (const name of names.splice(0)) await deleteVolume(name);
});

it('rejects a reused logical contribution before replacing the live worker mount', async () => {
  const worker = new Worker(new URL('./changes-lifecycle-registry-worker.ts', import.meta.url), { type: 'module' });
  workers.push(worker);
  const name = fileName();
  expect((await init(worker, name)).type).toBe('INIT');
  expect((await send(worker, 'MKDIR', { path: '/live' })).type).toBe('MKDIR');
  expect((await init(worker, name)).type).toBe('ERROR');
  expect((await send(worker, 'EXISTS', { path: '/live' })).result).toBe(true);
  await send(worker, 'CLOSE_VFS', {});
});

it('replaces an independent logical session exactly once', async () => {
  const worker = new Worker(new URL('./changes-lifecycle-registry-worker.ts', import.meta.url), { type: 'module' });
  workers.push(worker);
  const closed: { session: number; reason: string }[] = [];
  worker.addEventListener('message', ({ data }) => {
    if (data.type === 'SESSION_CLOSE') closed.push(data);
  });
  const name = fileName();
  expect((await init(worker, name, { fresh: true })).type).toBe('INIT');
  expect((await init(worker, name, { fresh: true })).type).toBe('INIT');
  expect(closed.map(({ session, reason }) => ({ session, reason }))).toEqual([{ session: 1, reason: 'replacement' }]);
  await send(worker, 'CLOSE_VFS', {});
  expect(closed.map(({ session, reason }) => ({ session, reason }))).toEqual([
    { session: 1, reason: 'replacement' },
    { session: 2, reason: 'close' },
  ]);
});

import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import { Volume } from './index.js';
import type { WorkerMountOptions } from './volume.js';

const fileNames: string[] = [];
const sharedWorkerAvailable = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
const fileName = () => {
  const name = `effect-worker-real-${crypto.randomUUID()}.bin`;
  fileNames.push(name);
  return name;
};
const worker = () => new Worker(new URL('../../opfs-vfs/src/worker.ts', import.meta.url), { type: 'module' });
const sharedWorker = (name: string) =>
  new SharedWorker(new URL('../../opfs-vfs/src/default-shared-worker.ts', import.meta.url), {
    type: 'module',
    name: `opfs-vfs-${name}`,
  });

afterEach(async () => {
  await Promise.all(fileNames.splice(0).map((name) => deleteVolume(name).catch(() => {})));
});

const exercise = (options: WorkerMountOptions) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const volume = yield* Volume.make(options);
        const backend = Volume.unsafeBackend(volume) as OpfsVfsWorkerClient;
        yield* Effect.tryPromise({
          try: () => backend.writeFileBuffer('/roundtrip', new TextEncoder().encode('custom worker session')),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        yield* volume.sync;
        const content = new TextDecoder().decode(
          yield* Effect.tryPromise({
            try: () => backend.readFileBuffer('/roundtrip'),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
        );
        return { status: backend.getStatus(), content };
      }),
    ),
  );

it('runs the Effect session through an application-owned worker under auto transport', async () => {
  const result = await exercise({ fileName: fileName(), transport: 'auto', worker });
  expect(result.status.transport).toBe('dedicated');
  expect(result.status.state).toBe('ready');
  expect(result.content).toBe('custom worker session');
});

it('keeps an injected worker crash terminal at the Effect service boundary', async () => {
  let actualWorker: Worker | undefined;
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const volume = yield* Volume.make({
          fileName: fileName(),
          transport: 'auto',
          worker: () => (actualWorker = worker()),
        });
        actualWorker!.dispatchEvent(new ErrorEvent('error', { error: new Error('injected crash') }));
        const syncError = yield* Effect.flip(volume.sync);
        const persistenceError = yield* Effect.flip(volume.persistence);
        expect(persistenceError).toMatchObject({
          _tag: 'VolumeError',
          kind: 'lifecycle',
          code: 'VFS_WORKER_FAILED',
          cause: { _tag: 'VolumeError', code: 'VFS_WORKER_FAILED' },
        });
        return syncError;
      }),
    ),
  );
  expect(error).toMatchObject({
    _tag: 'VolumeError',
    kind: 'lifecycle',
    code: 'VFS_WORKER_FAILED',
    cause: { _tag: 'VolumeError', code: 'VFS_WORKER_FAILED' },
  });
});

it('requires an application SharedWorker factory for strict custom-worker transport', async () => {
  let starts = 0;
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        Volume.make({
          fileName: fileName(),
          transport: 'shared-worker',
          worker: () => {
            starts++;
            return worker();
          },
        }),
      ),
    ),
  );
  expect(error).toMatchObject({ _tag: 'VolumeError', kind: 'configuration', code: 'EINVAL' });
  expect(starts).toBe(0);
});

it.skipIf(typeof SharedWorker === 'undefined' || !sharedWorkerAvailable)(
  'runs the Effect session through the supplied SharedWorker factory under strict transport',
  async () => {
    const result = await exercise({ fileName: fileName(), transport: 'shared-worker', worker, sharedWorker });
    expect(result.status.transport).toBe('shared-worker');
    expect(result.status.state).toBe('ready');
    expect(result.content).toBe('custom worker session');
  },
);

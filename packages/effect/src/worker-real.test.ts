import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import { Volume } from './index.js';
import type { WorkerMountOptions } from './volume.js';
import { OpfsFileSystem } from './filesystem.js';

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
        const fs = OpfsFileSystem.make(volume);
        yield* Effect.tryPromise({
          try: () => backend.writeFileBuffer('/roundtrip', new TextEncoder().encode('custom worker session')),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        yield* fs.writeFileString('/effect-roundtrip', 'custom Effect FileSystem');
        yield* fs.makeDirectory('/namespace/tree/sub', { recursive: true, mode: 0o750 });
        yield* fs.writeFileString('/namespace/tree/sub/note', 'linked');
        yield* fs.symlink('sub/note', '/namespace/tree/link');
        yield* fs.symlink('/namespace', '/namespace/tree/jump');
        yield* fs.symlink('missing', '/namespace/dangling');
        const relativeLink = yield* fs.readLink('/namespace/tree/link');
        const danglingLink = yield* fs.readLink('/namespace/dangling');
        const realLink = yield* fs.realPath('/namespace/tree/link');
        const listing = yield* fs.readDirectory('/namespace/tree/', { recursive: true });
        yield* fs.utimes('/namespace/tree/sub/note', 1.25, new Date(2500));
        const times = yield* fs.stat('/namespace/tree/sub/note');
        yield* fs.link('/namespace/tree/sub/note', '/namespace/hard');
        yield* fs.rename('/namespace/hard', '/namespace/moved');
        yield* fs.truncate('/namespace/moved', 3);
        const metadata = yield* fs.stat('/namespace/moved');
        yield* fs.chmod('/namespace/moved', 0o400);
        const denied = yield* Effect.result(fs.access('/namespace/moved', { writable: true }));
        yield* fs.chmod('/namespace/moved', 0o200);
        const readDenied = yield* Effect.result(fs.access('/namespace/moved', { readable: true }));
        yield* fs.chmod('/namespace/moved', 0o600);
        yield* fs.access('/namespace/moved', { writable: true });
        const nonEmpty = yield* Effect.result(fs.remove('/namespace/tree'));
        const busy = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fs.open('/namespace/tree/sub/note');
            return yield* Effect.result(fs.remove('/namespace/tree', { recursive: true }));
          }),
        );
        yield* fs.remove('/namespace/tree', { recursive: true });
        yield* fs.remove('/namespace/missing', { force: true });
        const dangling = yield* Effect.result(fs.readFileString('/namespace/dangling'));
        yield* fs.symlink('cycle-b', '/namespace/cycle-a');
        yield* fs.symlink('cycle-a', '/namespace/cycle-b');
        const cycle = yield* Effect.result(fs.readFileString('/namespace/cycle-a'));
        const trailingSlash = yield* Effect.result(fs.stat('/namespace/moved/'));
        yield* fs.makeDirectory('/namespace/denied-tree/sub', { recursive: true });
        yield* fs.chmod('/namespace/denied-tree/sub', 0);
        const nestedDenied = yield* Effect.result(fs.readDirectory('/namespace/denied-tree', { recursive: true }));
        yield* volume.sync;
        const content = new TextDecoder().decode(
          yield* Effect.tryPromise({
            try: () => backend.readFileBuffer('/roundtrip'),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
        );
        return {
          status: backend.getStatus(),
          content,
          fileSystemContent: yield* fs.readFileString('/effect-roundtrip'),
          namespace: {
            relativeLink,
            danglingLink,
            realLink,
            listing,
            metadata,
            times,
            denied,
            readDenied,
            nestedDenied,
            nonEmpty,
            busy,
            dangling,
            cycle,
            trailingSlash,
          },
        };
      }),
    ),
  );

it('runs the Effect session through an application-owned worker under auto transport', async () => {
  const result = await exercise({ fileName: fileName(), transport: 'auto', worker });
  expect(result.status.transport).toBe('dedicated');
  expect(result.status.state).toBe('ready');
  expect(result.content).toBe('custom worker session');
  expect(result.fileSystemContent).toBe('custom Effect FileSystem');
  expect(result.namespace).toMatchObject({
    relativeLink: 'sub/note',
    danglingLink: 'missing',
    realLink: '/namespace/tree/sub/note',
    listing: ['jump', 'link', 'sub', 'sub/note'],
    metadata: { nlink: { _tag: 'Some', value: 2 } },
    times: { atime: { value: new Date(1250) }, mtime: { value: new Date(2500) } },
    denied: { _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } },
    readDenied: { _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } },
    nestedDenied: { _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } },
    nonEmpty: { _tag: 'Failure' },
    busy: { _tag: 'Failure', failure: { reason: { _tag: 'Busy' } } },
    dangling: { _tag: 'Failure' },
    cycle: { _tag: 'Failure' },
    trailingSlash: { _tag: 'Failure' },
  });
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
    expect(result.fileSystemContent).toBe('custom Effect FileSystem');
    expect(result.namespace).toMatchObject({
      relativeLink: 'sub/note',
      danglingLink: 'missing',
      listing: ['jump', 'link', 'sub', 'sub/note'],
      times: { atime: { value: new Date(1250) }, mtime: { value: new Date(2500) } },
      denied: { _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } },
      readDenied: { _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } },
      nestedDenied: { _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } },
      nonEmpty: { _tag: 'Failure' },
      busy: { _tag: 'Failure', failure: { reason: { _tag: 'Busy' } } },
      dangling: { _tag: 'Failure' },
      cycle: { _tag: 'Failure' },
    });
  },
);

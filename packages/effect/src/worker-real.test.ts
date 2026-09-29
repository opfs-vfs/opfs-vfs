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

it('copies trees without following symlinks and cleans only scoped temporary roots', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const volume = yield* Volume.make({ fileName: fileName(), transport: 'auto', worker });
        const fs = OpfsFileSystem.make(volume);
        const large = new Uint8Array(140_000);
        for (let i = 0; i < large.length; i++) large[i] = i % 251;
        yield* fs.makeDirectory('/copy-source/nested', { recursive: true, mode: 0o755 });
        yield* fs.writeFile('/copy-source/nested/large.bin', large);
        yield* fs.utimes('/copy-source/nested/large.bin', 1_234, 1_234);
        yield* fs.symlink('../nested/large.bin', '/copy-source/link');
        yield* fs.symlink('missing-target', '/copy-source/dangling');
        yield* fs.copy('/copy-source', '/copy-destination', { overwrite: true, preserveTimestamps: true });
        yield* fs.copy('/copy-source', '/copy-parent/missing/nested/destination', { overwrite: true });
        yield* fs.symlink('/copy-source', '/copy-link-parent');
        const symlinkParentSelfCopy = yield* Effect.result(
          fs.copy('/copy-source', '/copy-link-parent/new-child', { overwrite: true }),
        );
        const rejectedSelfChildExists = yield* fs.exists('/copy-source/new-child');

        const copiedBytes = yield* fs.readFile('/copy-destination/nested/large.bin');
        const copiedTime = yield* fs.stat('/copy-destination/nested/large.bin');
        const copiedLink = yield* fs.readLink('/copy-destination/link');
        const copiedDanglingLink = yield* fs.readLink('/copy-destination/dangling');
        yield* fs.writeFileString('/copy-source/skip.txt', 'source');
        yield* fs.writeFileString('/copy-destination/skip.txt', 'destination');
        yield* fs.copy('/copy-source', '/copy-destination', { overwrite: false });
        const skipped = yield* fs.readFileString('/copy-destination/skip.txt');

        yield* fs.writeFileString('/copy-regular', 'replacement');
        const missingCopyFileParent = yield* Effect.result(fs.copyFile('/copy-regular', '/missing-parent/file'));
        const missingCopyFileParentCreated = yield* fs.exists('/missing-parent');
        yield* fs.writeFileString('/copy-target', 'keep');
        yield* fs.symlink('/copy-target', '/copy-output');
        yield* fs.symlink('/copy-target', '/copy-skip-link');
        yield* fs.copy('/copy-regular', '/copy-skip-link', { overwrite: false });
        const skippedSymlinkTarget = yield* fs.readLink('/copy-skip-link');
        yield* fs.copy('/copy-regular', '/copy-output', { overwrite: true });
        const replacedLink = yield* fs.stat('/copy-output');
        const untouchedTarget = yield* fs.readFileString('/copy-target');
        yield* fs.symlink('/copy-target', '/copy-source-link');
        const symlinkToFileConflict = yield* Effect.result(
          fs.copy('/copy-source-link', '/copy-target', { overwrite: true }),
        );
        yield* fs.symlink('/missing-target', '/copy-dangling-output');
        yield* fs.copy('/copy-regular', '/copy-dangling-output', { overwrite: true });
        const danglingTargetSurvived = yield* Effect.result(fs.readFile('/missing-target'));

        yield* fs.link('/copy-regular', '/copy-hardlink');
        const sameInode = yield* Effect.result(fs.copyFile('/copy-regular', '/copy-hardlink'));
        const directoryConflict = yield* Effect.result(fs.copy('/copy-source', '/copy-regular', { overwrite: true }));
        const directoryConflictWithoutOverwrite = yield* Effect.result(
          fs.copy('/copy-source', '/copy-regular', { overwrite: false }),
        );
        const selfCopy = yield* Effect.result(fs.copy('/copy-source', '/copy-source/child', { overwrite: true }));

        yield* fs.makeDirectory('/tmp/copy-temp', { recursive: true });
        yield* fs.writeFileString('/tmp/copy-temp/sibling', 'caller-owned');
        const tempDirectory = yield* Effect.scoped(
          Effect.gen(function* () {
            const path = yield* fs.makeTempDirectoryScoped({ directory: '/tmp/copy-temp', prefix: 'owned-' });
            yield* fs.writeFileString(`${path}/inside`, 'temporary');
            return path;
          }),
        );
        const defaultTempDirectory = yield* Effect.scoped(
          Effect.gen(function* () {
            return yield* fs.makeTempDirectoryScoped({ prefix: 'default-' });
          }),
        );
        const tempFile = yield* Effect.scoped(
          Effect.gen(function* () {
            const path = yield* fs.makeTempFileScoped({ directory: '/tmp/copy-temp', prefix: 'file-', suffix: '.txt' });
            yield* fs.writeFileString(path, 'temporary');
            return path;
          }),
        );
        const sibling = yield* fs.readFileString('/tmp/copy-temp/sibling');
        const tempDirectoryRemains = yield* fs.exists(tempDirectory);
        const tempFileRemains = yield* fs.exists(tempFile);
        const tempFileParentRemains = yield* fs.exists(tempFile.slice(0, tempFile.lastIndexOf('/')));
        const unscoped = yield* fs.makeTempFile({ directory: '/tmp/copy-temp', prefix: 'caller-', suffix: '.dat' });
        const unscopedExists = yield* fs.exists(unscoped);
        yield* fs.remove(unscoped.slice(0, unscoped.lastIndexOf('/')), { recursive: true });

        return {
          copiedBytes,
          nestedDestination: yield* fs.readFile('/copy-parent/missing/nested/destination/nested/large.bin'),
          symlinkParentSelfCopy,
          rejectedSelfChildExists,
          copiedTime,
          copiedLink,
          copiedDanglingLink,
          skipped,
          replacedLink,
          untouchedTarget,
          symlinkToFileConflict,
          skippedSymlinkTarget,
          missingCopyFileParent,
          missingCopyFileParentCreated,
          danglingTargetSurvived,
          sameInode,
          directoryConflict,
          directoryConflictWithoutOverwrite,
          selfCopy,
          sibling,
          defaultTempDirectory,
          tempDirectoryRemains,
          tempFileRemains,
          tempFileParentRemains,
          unscopedExists,
        };
      }),
    ),
  );
  expect(result.copiedBytes).toEqual(Uint8Array.from({ length: 140_000 }, (_, i) => i % 251));
  expect(result.nestedDestination).toEqual(result.copiedBytes);
  expect(result.symlinkParentSelfCopy._tag).toBe('Failure');
  expect(result.rejectedSelfChildExists).toBe(false);
  expect(result.copiedTime.mtime).toMatchObject({ value: new Date(1_234_000) });
  expect(result.copiedLink).toBe('../nested/large.bin');
  expect(result.copiedDanglingLink).toBe('missing-target');
  expect(result.skipped).toBe('destination');
  expect(result.replacedLink.type).toBe('File');
  expect(result.untouchedTarget).toBe('keep');
  expect(result.symlinkToFileConflict._tag).toBe('Failure');
  if (result.symlinkToFileConflict._tag === 'Failure')
    expect(result.symlinkToFileConflict.failure.reason._tag).toBe('AlreadyExists');
  expect(result.skippedSymlinkTarget).toBe('/copy-target');
  expect(result.missingCopyFileParent._tag).toBe('Failure');
  expect(result.missingCopyFileParentCreated).toBe(false);
  expect(result.danglingTargetSurvived._tag).toBe('Failure');
  expect(result.sameInode._tag).toBe('Failure');
  expect(result.directoryConflict._tag).toBe('Failure');
  expect(result.directoryConflictWithoutOverwrite._tag).toBe('Failure');
  expect(result.selfCopy._tag).toBe('Failure');
  expect(result.sibling).toBe('caller-owned');
  expect(result.defaultTempDirectory.startsWith('/tmp/default-')).toBe(true);
  expect(result.tempDirectoryRemains).toBe(false);
  expect(result.tempFileRemains).toBe(false);
  expect(result.tempFileParentRemains).toBe(false);
  expect(result.unscopedExists).toBe(true);
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

import { Effect, Fiber, Stream } from 'effect';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { expect, it } from 'vitest';
import { OpfsFileSystem } from './filesystem.js';
import { Volume } from './index.js';

it('projects each native descendant record from a worker directory rename once', async () => {
  const fileName = `effect-watch-rename-${crypto.randomUUID()}.bin`;
  let registered!: () => void;
  const registration = new Promise<void>((resolve) => {
    registered = resolve;
  });
  try {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make({ fileName, plugins: [subscriptionsRequest()] });
          const backend = Volume.unsafeBackend(volume) as unknown as FileChangeSource;
          const open = backend.openFileChangeChannel.bind(backend);
          backend.openFileChangeChannel = async (...args) => {
            const channel = await open(...args);
            return {
              ...channel,
              request: async (command) => {
                const reply = await channel.request(command);
                if (command.type === 'register' && reply.type === 'registered') queueMicrotask(registered);
                return reply;
              },
            };
          };

          const fs = OpfsFileSystem.make(volume);
          yield* fs.makeDirectory('/tree/old/nested', { recursive: true });
          yield* fs.writeFileString('/tree/old/nested/a.txt', 'a');
          yield* fs.writeFileString('/tree/old/nested/b.txt', 'b');
          const watching = yield* Stream.take(fs.watch('/tree', { recursive: true }), 9).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.promise(() => registration);
          yield* Effect.yieldNow;
          yield* fs.rename('/tree/old', '/tree/new');
          yield* fs.writeFileString('/tree/sentinel.txt', 'sentinel');
          return yield* Fiber.join(watching);
        }),
      ),
    );

    const keys = events.map((event) => `${event._tag}:${event.path}`);
    const renameKeys = keys.slice(0, 8);
    expect(keys).toHaveLength(9);
    expect(keys.at(-1)).toBe('Create:/tree/sentinel.txt');
    expect(renameKeys).toHaveLength(8);
    expect(new Set(renameKeys).size).toBe(8);
    expect(new Set(renameKeys)).toEqual(
      new Set([
        'Remove:/tree/old',
        'Remove:/tree/old/nested',
        'Remove:/tree/old/nested/a.txt',
        'Remove:/tree/old/nested/b.txt',
        'Create:/tree/new',
        'Create:/tree/new/nested',
        'Create:/tree/new/nested/a.txt',
        'Create:/tree/new/nested/b.txt',
      ]),
    );
  } finally {
    await deleteVolume(fileName);
  }
}, 30_000);

const watchCollect = async (
  setup: (fs: ReturnType<typeof OpfsFileSystem.make>) => Effect.Effect<unknown, unknown>,
  watchPath: string,
  act: (fs: ReturnType<typeof OpfsFileSystem.make>) => Effect.Effect<unknown, unknown>,
  count: number,
) => {
  const fileName = `effect-watch-resolve-${crypto.randomUUID()}.bin`;
  let registered!: () => void;
  const registration = new Promise<void>((resolve) => {
    registered = resolve;
  });
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make({ fileName, plugins: [subscriptionsRequest()] });
          const backend = Volume.unsafeBackend(volume) as unknown as FileChangeSource;
          const open = backend.openFileChangeChannel.bind(backend);
          backend.openFileChangeChannel = async (...args) => {
            const channel = await open(...args);
            return {
              ...channel,
              request: async (command) => {
                const reply = await channel.request(command);
                if (command.type === 'register' && reply.type === 'registered') queueMicrotask(registered);
                return reply;
              },
            };
          };
          const fs = OpfsFileSystem.make(volume);
          yield* setup(fs);
          const watching = yield* Stream.take(fs.watch(watchPath), count).pipe(Stream.runCollect, Effect.forkChild);
          yield* Effect.promise(() => registration);
          yield* Effect.yieldNow;
          yield* act(fs);
          return (yield* Fiber.join(watching)).map((event) => `${event._tag}:${event.path}`);
        }),
      ),
    );
  } finally {
    await deleteVolume(fileName);
  }
};

it('watches the resolved path of /link/../x, not the textual one', async () => {
  const keys = await watchCollect(
    (fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory('/a/b', { recursive: true });
        yield* fs.writeFileString('/a/x', 'a');
        yield* fs.writeFileString('/x', 'unrelated');
        yield* fs.symlink('/a/b', '/link');
      }),
    '/link/../x',
    (fs) =>
      Effect.gen(function* () {
        yield* fs.writeFileString('/x', 'unrelated change');
        yield* fs.writeFileString('/a/x', 'real change');
      }),
    1,
  );
  expect(keys).toEqual(['Update:/a/x']);
}, 30_000);

it('reports the canonical path for a file watched through a symlinked directory', async () => {
  const keys = await watchCollect(
    (fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory('/a/b', { recursive: true });
        yield* fs.writeFileString('/a/b/f.txt', 'a');
        yield* fs.symlink('/a/b', '/link');
      }),
    '/link/f.txt',
    (fs) => fs.writeFileString('/a/b/f.txt', 'changed'),
    1,
  );
  expect(keys).toEqual(['Update:/a/b/f.txt']);
}, 30_000);

it('watches a directory given with a dot final component by its canonical path', async () => {
  const keys = await watchCollect(
    (fs) => fs.makeDirectory('/a/b', { recursive: true }),
    '/a/b/.',
    (fs) => fs.writeFileString('/a/b/new.txt', 'n'),
    1,
  );
  expect(keys).toEqual(['Create:/a/b/new.txt']);
}, 30_000);

it('keeps rejecting missing and symlink watch targets', async () => {
  const fileName = `effect-watch-reject-${crypto.randomUUID()}.bin`;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make({ fileName, plugins: [subscriptionsRequest()] });
          const fs = OpfsFileSystem.make(volume);
          yield* fs.makeDirectory('/a');
          yield* fs.symlink('/a', '/link');
          const missing = yield* Effect.exit(Stream.runHead(fs.watch('/link/../missing')));
          const symlink = yield* Effect.exit(Stream.runHead(fs.watch('/link')));
          expect(JSON.stringify(missing)).toContain('NotFound');
          expect(JSON.stringify(symlink)).toContain('BadResource');
        }),
      ),
    );
  } finally {
    await deleteVolume(fileName);
  }
}, 30_000);

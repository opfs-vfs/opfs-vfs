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

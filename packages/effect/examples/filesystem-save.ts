import { Effect } from 'effect';
import { OpfsFileSystem, Volume } from '@opfs-vfs/effect';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

// fallow-ignore-next-line unused-export
export const saveNote = (fileName = `effect-save-${crypto.randomUUID()}.bin`) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const volume = yield* Volume.make({
          fileName,
          transport: 'dedicated',
          plugins: () => [subscriptionsRequest()],
        });
        const fs = OpfsFileSystem.make(volume);
        yield* fs.writeFileString('/note.txt', 'saved through FileSystem');
        yield* volume.sync.pipe(
          Effect.catchTag('VolumeError', (error) => {
            if (error.code === 'VFS_SYNC_OWNER_CHANGED') {
              return Effect.logWarning(
                'Save status is uncertain; reconcile the current volume before acknowledging it.',
              ).pipe(Effect.andThen(Effect.fail(error)));
            }
            return Effect.fail(error);
          }),
        );
        return yield* fs.readFileString('/note.txt');
      }),
    ),
  );

import { Effect } from 'effect';
import { Volume } from '@opfs-vfs/effect';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

export const runWorkerSession = (fileName = `effect-worker-${crypto.randomUUID()}.bin`) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const volume = yield* Volume.make({
          fileName,
          transport: 'dedicated',
          plugins: () => [subscriptionsRequest()],
        });
        const backend = Volume.unsafeBackend(volume) as OpfsVfsWorkerClient;
        yield* Effect.tryPromise({
          try: () => backend.writeFileBuffer('/session.txt', new TextEncoder().encode('saved by a worker')),
          catch: (error) => error,
        });
        yield* volume.sync;
        return {
          content: new TextDecoder().decode(
            yield* Effect.tryPromise({
              try: () => backend.readFileBuffer('/session.txt'),
              catch: (error) => error,
            }),
          ),
          persistence: yield* volume.persistence,
        };
      }),
    ),
  );

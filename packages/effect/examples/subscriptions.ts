import { Effect, FileSystem, Layer, Stream } from 'effect';
import { OpfsFileSystem, Subscriptions, Volume } from '@opfs-vfs/effect';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

export const observeOneChange = (fileName = `effect-subscriptions-${crypto.randomUUID()}.bin`) => {
  const volume = Volume.layer({ fileName, plugins: () => [subscriptionsRequest()] });
  const live = Layer.merge(Layer.provide(Subscriptions.layer, volume), Layer.provide(OpfsFileSystem.layer, volume));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions.Subscriptions;
        const fs = yield* FileSystem.FileSystem;
        const subscription = yield* subscriptions.subscribe({ path: '/', scope: 'directory', recursive: true });
        yield* fs.writeFileString('/observed.txt', 'subscription example');
        const change = yield* Stream.runHead(subscription.changes);
        return { change, retired: yield* subscription.retired };
      }),
    ).pipe(Effect.provide(live)),
  );
};

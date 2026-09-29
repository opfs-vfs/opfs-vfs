# @opfs-vfs/effect

Effect v4 adapter for worker-backed OPFS volumes and direct mounts. Requires `effect@4.0.0-rc.118`.

```ts
import { Effect } from 'effect';
import { Volume } from '@opfs-vfs/effect';

const program = Effect.gen(function* () {
  const volume = yield* Volume.make({ fileName: 'app.bin' });
  yield* volume.sync;
  return yield* volume.persistence;
}).pipe(Effect.scoped);
```

`make` and `layer` own a worker client in the current `Scope`. The bundled
dedicated worker registers the subscriptions plugin; request it with
`plugins: () => [subscriptionsRequest()]`. Other plugin requests require a
custom worker that registers those plugins. A supplied SharedWorker factory is
required for `transport: 'shared-worker'`; that worker must register the same
requested plugins. `auto` retains the core worker's dedicated fallback behavior.

`makeDirect` and `layerDirect` own a direct backend in the current `Scope` and
must run where OPFS synchronous access handles are available. Configured direct
plugins must be created by a fresh `plugins` thunk for each acquisition.
`unsafeBackend` only borrows that backend: do not call `closeVfs`, and do not use
it after the owning scope closes.

`examples/worker-session.ts` is a runnable worker-backed save/read session.
`examples/direct.ts` shows the direct API.

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

`OpfsFileSystem.layer` builds the standard `FileSystem` service on a mounted
`Volume`. Current support includes absolute-path `access` and whole-file reads
up to 16 MiB. Writes are limited to 16 MiB, with flags `w`, `wx`, or `ax` and
no explicit `mode`. The remaining required methods fail with a typed
unsupported error. See `examples/filesystem-save.ts` for handling errors from
`volume.sync`. A successful write does not mean the data is durable; await
`volume.sync` at save boundaries.

```ts
import { Effect, FileSystem, Layer } from 'effect';
import { OpfsFileSystem, Volume } from '@opfs-vfs/effect';

const FileSystemLive = Layer.provideMerge(OpfsFileSystem.layer, Volume.layer({ fileName: 'app.bin' }));

const app = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const volume = yield* Volume.Volume;
  yield* fs.writeFileString('/note.txt', 'Hello');
  yield* volume.sync;
}).pipe(Effect.provide(FileSystemLive));
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

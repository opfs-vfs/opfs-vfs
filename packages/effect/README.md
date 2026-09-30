# @opfs-vfs/effect

Effect v4 adapter for direct OPFS volumes. Requires `effect@4.0.0-rc.118`. Core uses OPFS synchronous access handles, so run direct mounts in a dedicated worker or another context that provides them.

```ts
import { Effect } from 'effect';
import { Volume } from '@opfs-vfs/effect';

const program = Effect.gen(function* () {
  const volume = yield* Volume.makeDirect({ fileName: 'app.bin' });
  yield* volume.sync;
  return yield* volume.persistence;
}).pipe(Effect.scoped);
```

`makeDirect` and `layerDirect` own the backend in the current `Scope`. Configured
plugins must be created by a fresh `plugins` thunk for each acquisition.
`unsafeBackend` only borrows that backend: do not call `closeVfs`, and do not use
it after the owning scope closes.

`examples/direct.ts` contains this program. Copy it into a module worker and run
`Effect.runPromise(save)` there.

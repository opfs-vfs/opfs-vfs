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
`Volume`. It supports scoped file handles, descriptor reads and writes, and
bounded whole-file helpers up to 16 MiB. Larger files and other open flags use
descriptor I/O. Use `stream` and `sink` for bounded-memory transfers. See
`examples/filesystem-stream.ts` for a chunked copy and
`examples/filesystem-save.ts` for handling persistence errors. A successful
write does not mean the data is durable; await `volume.sync` at save boundaries.

The adapter also supports path metadata, permissions, links, directory creation,
listing, removal, rename, recursive copy and volume-local temporary paths.
Filesystem operands must be absolute paths; relative symlink targets are
preserved. Recursive copy does not follow symlinks, is not atomic, and does not
preserve hard-link topology. `chown` and `glob` return typed unsupported errors
in this slice. Scoped temporary paths remove only their private directory
when the scope closes; the default parent is `/tmp` inside the volume. A temporary
path uses its resolved physical parent, so retargeting the caller-supplied parent
symlink does not redirect cleanup. Ownership covers the created root pathname and
its current descendants; cleanup is not an atomic inode-identity check. Keep the
resolved physical ancestors stable until cleanup completes. Shutdown, owner
replacement, or cleanup failure can leave temporary paths for explicit reclamation.

`FileSystem.watch` uses the same logical-change registration and cleanup path as
rich subscriptions. It checks the target when the stream is acquired: a missing
path fails with `NotFound`, and a symlink target fails with `BadResource`. It
watches regular files or directories and emits absolute volume paths as
`Create`, `Update`, or `Remove`. Recursive directory watching preserves the
native descendant records for directory renames; symlink entries inside a
watched directory are reported, but a symlink target is not followed.

Watch notifications are hints, not a replayable log. Preflight checks and
directory scans are not atomic snapshots; logical event counts and ordering can
differ from native operating-system watchers. Reconciliation marks its view
stale when stream consumption observes a failure, so that callback can lag the
terminal notification. A takeover ends the stream
with `Unknown` and a `SubscriptionError` whose code is
`SUBSCRIPTION_INTERRUPTED`; the standard API does not silently resubscribe.
Readiness and retirement timeouts map to `TimedOut`. Use a bounded retry only
when the application also invalidates and reconciles its current view. The
standard watch API has no registration-ready signal, so use rich subscriptions
when a view must subscribe before its initial scan. See
`examples/reconciled-view.ts` for subscribe-before-scan recovery with bounded
retries and retirement waiting. Its three-retry budget resets after a fresh scan
is successfully published.

`Subscriptions.layer` provides the Effect subscriptions service when the mounted
volume has the compatible logical-change capability. Worker mounts request it
with `subscriptionsRequest()`; direct mounts configure a logical-change plugin.
Without that capability, layer acquisition fails with a typed unsupported
`VolumeError`.

```ts
import { Effect, Layer, Stream } from 'effect';
import { Subscriptions, Volume } from '@opfs-vfs/effect';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

const liveLayer = Layer.provide(
  Subscriptions.layer,
  Volume.layer({ fileName: 'app.bin', plugins: () => [subscriptionsRequest()] }),
);

const observe = Effect.scoped(
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions.Subscriptions;
    const subscription = yield* subscriptions.subscribe({ path: '/', scope: 'directory', recursive: true });
    yield* Stream.runForEach(subscription.changes, (change) => Effect.sync(() => console.log(change.path)));
  }),
).pipe(Effect.provide(liveLayer));
```

Each `changes` stream can be consumed once. Stream completion, interruption, or
scope close unsubscribes it; `retired` can be evaluated repeatedly to read the
same released or unknown cleanup result. The stream has bounded delivery and
preserves terminal subscription errors. It has no initial snapshot or replay;
subscribe before scanning and reconcile notifications received during the scan.
See `examples/subscriptions.ts` for a complete worker-backed example.

The adapter buffers at most 16 changes and permits one additional producer
offer to wait; a terminal error clears buffered changes and fails the stream.
Content capture is off by default (`content: false`). The adapter queue and its
one pending offer retain up to 17 * `maxBytes` of included payloads, in addition
to source buffers and any data a caller retains. If retirement is unknown,
new subscriptions on that same owner generation fail until the volume observes
a different ready generation. Recreating a handle in the same generation does
not clear the barrier; a new generation does, while an old handle's `retired`
result remains unchanged. Direct mounts cannot observe a new owner generation,
so an unknown retirement requires remounting.

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

`examples/encrypted-session.ts` shows an application-owned worker that registers
encryption and subscriptions, inspects before opening an existing encrypted
volume, and keeps one `ManagedRuntime` for the session. Its save controller
serializes work and credential replacement, preserves use and disposal exits,
and never replays the failed save. The creation helper is the only path that
accepts an initial passkey. The paired
`examples/encrypted-session.worker.ts` is application code; the base adapter
does not depend on the premium encryption package.

The encrypted packed check is explicit and requires a reviewed local candidate:

```sh
OPFS_VFS_ENCRYPTION_TARBALL=/absolute/path/plugin-encryption.tgz \
OPFS_VFS_ENCRYPTION_SHA256=<sha256> pnpm --filter @opfs-vfs/effect test:encrypted-packed
```

---
title: Effect adapter
description: Use scoped OPFS VFS volumes, Effect FileSystem layers, and change streams in a browser application.
---

`@opfs-vfs/effect` adapts OPFS VFS to Effect v4. It owns volume resources in an Effect scope, provides the standard `FileSystem` service, and exposes file changes as streams.

Use stable Effect v4 with this adapter. The supported range is `>=4.0.0 <5.0.0`, excluding prereleases. Install it with the core filesystem and subscriptions packages:

```sh
npm install @opfs-vfs/effect @opfs-vfs/opfs-vfs @opfs-vfs/plugin-subscriptions effect@^4.0.0
```

## Start one managed session

Run this in a browser application served over HTTPS or localhost with the [cross-origin isolation headers](/docs/guides/browser-setup/). Build one runtime for the session and reuse it for each save.

```ts
import { Cause, Effect, Exit, FileSystem, Layer, ManagedRuntime } from 'effect';
import { OpfsFileSystem, Volume } from '@opfs-vfs/effect';

const FileSystemLive = Layer.provideMerge(OpfsFileSystem.layer, Volume.layer({ fileName: 'notes.bin' }));

const saveNote = Effect.fn('Notes.save')(function* (contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString('/note.txt', contents);
  return 'saved' as const;
});

const runtime = ManagedRuntime.make(FileSystemLive);
const startExit = await runtime.runPromiseExit(Effect.void);
if (Exit.isFailure(startExit)) {
  const disposeExit = await Effect.runPromiseExit(runtime.disposeEffect);
  console.error('Volume startup failed', startExit, disposeExit);
}
```

`ManagedRuntime.make` initializes lazily. Running `Effect.void` here builds the layer and waits for the worker to become ready before accepting saves. If startup fails, the example disposes the runtime and retains both startup and cleanup results.

`Layer.provideMerge` exposes `FileSystem` and `Volume` from one mount, so `saveNote` can write through the standard service and `Volume.withSync` can synchronize the same volume. `notes.bin` is the backing volume name, a basename ending in `.bin`. `/note.txt` is a path inside that volume. Reopen the same volume from the same origin to read its saved files.

### Save during the session

Run this for a user save action after successful startup. Repeated calls use the same mounted volume.

```ts
if (Exit.isSuccess(startExit)) {
  const saveExit = await runtime.runPromiseExit(saveNote('Hello from Effect').pipe(Volume.withSync));
  if (Exit.isFailure(saveExit)) {
    console.error('Save failed; keep the draft and reconcile before retrying', Cause.pretty(saveExit.cause), saveExit);
  } else {
    console.log(saveExit.value);
  }
}
```

Wrapping the save with `Volume.withSync` returns its value only after sync succeeds. A failure preserves the full `Exit` and does not automatically retry the write.

### End the session

Stop accepting saves, wait for in-flight work to finish, then dispose the runtime from outside that runtime. Run this when the session ends, rather than after each save.

```ts
if (Exit.isSuccess(startExit)) {
  const disposeExit = await Effect.runPromiseExit(runtime.disposeEffect);
  if (Exit.isFailure(disposeExit)) {
    console.error('Volume cleanup failed', Cause.pretty(disposeExit.cause), disposeExit);
  }
}
```

Disposal closes the layer's scope, retires subscriptions, closes file handles, and closes the backend. A disposed runtime cannot be reused. `Volume.make` and `Volume.makeDirect` also support explicit `Effect.scoped` workflows; do not use their mounted services or handles after the owning scope closes.

Omitting `transport` selects `auto`. Without a compatible `sharedWorker` factory, this adapter uses its bundled dedicated worker. That worker registers subscriptions, though change streams require an explicit plugin request below. Other plugins need an application worker that registers them. Forced `transport: 'shared-worker'` requires your own compatible factory. Keep factories and plugin configuration consistent across clients of the same volume. See [volumes and lifecycle](/docs/concepts/) for ownership behavior.

The [worker session example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/worker-session.ts) demonstrates a scoped save/read workflow. The [filesystem save example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/filesystem-save.ts) handles sync failure. The [encrypted session example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/encrypted-session.ts) shows a managed session with serialized saves and disposal.

## Paths and larger files

Filesystem operands must be absolute volume paths. They are not host filesystem paths. Relative symlink targets are preserved.

The adapter supports scoped descriptor I/O, metadata, permissions, links, directories, rename, removal, recursive copy, and volume-local temporary paths. `chown` and `glob` fail with typed `ENOTSUP` errors. Recursive copy does not follow symlinks, is not atomic, and does not preserve hard-link topology.

Whole-file worker helpers use a fast path up to 16 MiB. Larger files and other open flags use descriptor I/O, but `readFile` still allocates the whole result. Use `fs.stream` and `fs.sink` to copy without loading the entire file into memory. The [streaming example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/filesystem-stream.ts) copies a file in 64 KiB chunks and synchronizes afterward.

Scoped temporary paths default to `/tmp` inside the volume. They remove their private directory on scope close. Keep its resolved physical ancestors stable until cleanup completes; interrupted cleanup or owner replacement can leave paths that need explicit removal.

## Choose your save boundaries

The default `localDurabilityMode: 'balanced'` schedules background synchronization about 150 ms after the first dirty change. Further changes do not restart that timer. This is a scheduling interval, not a durability deadline: a busy or suspended worker can delay it, and I/O or quota failures can prevent it from completing. A background failure records a persistence error; it cannot retroactively turn an already successful write into a returned error.

The default `bufferMode: 'disk'` avoids a full RAM copy of file contents. OPFS writes and metadata still need flushing for confirmation, and balanced background synchronization still applies. Use explicit sync or `Volume.withSync` for a confirmed save in either buffer mode. You do not need to sync after each individual write for balanced mode to persist changes in the background.

Background flushing and explicit save boundaries work together. Keep balanced mode for routine edits and add `Volume.withSync` or `volume.sync` where the application needs to acknowledge a save.

| Approach                                            | Benefit                                                             | Cost or limit                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Background balanced mode                            | Groups nearby writes without waiting for sync after each operation. | Write success does not acknowledge durability; timing and failures need observation. |
| `Volume.withSync` or manual `volume.sync` at a save | Completion includes a sync result that the caller can handle.       | The caller waits for synchronization and its I/O cost.                               |
| One `Volume.withSync` around a batch                | Synchronizes several writes once after the whole batch succeeds.    | A failed batch can leave earlier writes applied; there is no rollback.               |

`Volume.withSync(effect)` requires the `Volume` service, runs the effect, then syncs on success and preserves its value. The filesystem must use that same `Volume` instance, as in the layer above. If the wrapped operation fails, defects, or is interrupted, the helper does not start its success sync and preserves the original failure. Existing cancellation behavior still applies. Cancellation can occur after sync dispatch and does not guarantee that sync completes. A sync failure becomes the wrapped effect's failure.

Each wrapper runs one sync after success. Nested wrappers each sync, so wrap the whole batch once when that is the intended boundary. The helper provides no isolation or rollback. Concurrent writes on the volume can also be included in the flush, and background synchronization can still run when a wrapped effect fails.

For more control, yield `volume.sync` at the chosen point in an Effect workflow. `localDurabilityMode: 'relaxed'` defers flushing to explicit sync or orderly close. `strict` additionally flushes memory-mode recovery records; it does not flush every disk-mode write. Neither mode replaces the need for an acknowledged application save boundary.

A write, readback, file close, or `volume.persistence` snapshot does not establish that save's durability. A `clean` persistence snapshot reports the current backend state; it cannot prove that an earlier owner's writes survived. Browser retention permission is separate from synchronization. See [persistence and recovery](/docs/guides/persistence/).

When accepted writes belong to a previous owner generation, sync can fail with `VolumeError`, code `VFS_SYNC_OWNER_CHANGED`, and outcome `unknown`. Keep the draft, reread and reconcile the current volume, and avoid automatically replaying the failed mutation. After the application resolves the uncertainty, `volume.acknowledgeOwnerChange` acknowledges the current generation; it does not recover the old writes or mark a save durable. A later save still needs sync.

## Handle typed errors

Mounting and sync fail with `VolumeError` or `EncryptionError`. `VolumeError` includes `kind`, `operation`, `fileName`, optional `path` and `code`, and an `outcome` of `not-applied`, `possibly-applied`, or `unknown`. An uncertain mutation needs reconciliation before retrying.

Standard filesystem operations fail with Effect's `PlatformError`. Check `error.reason._tag` for ordinary filesystem handling and use `Volume.errorOf(error)` to recover the adapter's `VolumeError`, `EncryptionError`, or `SubscriptionError` cause.

```ts
import { Effect, FileSystem } from 'effect';
import { Volume } from '@opfs-vfs/effect';

const readNote = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString('/note.txt').pipe(
    Effect.catchTag('PlatformError', (error) => {
      if (error.reason._tag === 'NotFound') return Effect.succeed('');
      const cause = Volume.errorOf(error);
      return Effect.logWarning('Could not read note', cause ?? error).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
});
```

This fallback applies only to a missing note. Other failures still reach the caller.

## Subscribe before scanning a view

Request logical changes when mounting, then provide `Subscriptions.layer`. Acquisition fails with an unsupported `VolumeError` if the mount lacks the compatible capability.

```ts
import { Effect, FileSystem, Layer, Stream } from 'effect';
import { OpfsFileSystem, Subscriptions, Volume } from '@opfs-vfs/effect';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

const volume = Volume.layer({
  fileName: 'notes.bin',
  plugins: () => [subscriptionsRequest()],
});
const live = Layer.provide(Layer.merge(OpfsFileSystem.layer, Subscriptions.layer), volume);

const observe = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const subscriptions = yield* Subscriptions.Subscriptions;
    const subscription = yield* subscriptions.subscribe({
      path: '/',
      scope: 'directory',
      recursive: true,
      content: false,
    });
    yield* Effect.log(yield* fs.readDirectory('/', { recursive: true }));
    yield* Stream.runForEach(subscription.changes, () =>
      fs.readDirectory('/', { recursive: true }).pipe(Effect.flatMap(Effect.log)),
    );
  }),
).pipe(Effect.provide(live));
```

Run `observe` for the lifetime of the view, interrupting it when the view closes. Registration completes before the initial scan. Notifications received during that scan trigger another read. Neither the scan nor event delivery is an atomic snapshot.

Each `changes` stream supports one consumer. Completion, interruption, or scope close unsubscribes it. `retired` is a repeatable effect reporting `released` or `unknown`, rather than another stream consumer. An unknown retirement blocks new subscriptions on that owner generation. A different ready worker generation clears the barrier; direct mounts require remounting.

Changes are live hints with no initial snapshot or replay. Delivery is bounded to 16 queued changes and one waiting producer offer; a terminal error clears queued changes and fails the stream. Content capture is off by default. When enabled, the queue and pending offer can retain up to `17 * maxBytes` of payloads, beyond source buffers and data the application retains.

Treat a stream failure as a stale view. The [reconciled view example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/reconciled-view.ts) subscribes before scanning, waits for retirement, and bounds recovery attempts. The [one-change example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/subscriptions.ts) demonstrates acquisition, mutation, consumption, and retirement.

### Standard FileSystem watch

`fs.watch('/documents', { recursive: true })` uses the same logical-change capability. It emits `Create`, `Update`, and `Remove` events with absolute volume paths. Acquisition checks the target: a missing path fails with `NotFound`, and a symlink target fails with `BadResource`. Directory watches report symlink entries without following their targets.

Owner takeover ends the watch with `Unknown` and a `SubscriptionError` cause whose code is `SUBSCRIPTION_INTERRUPTED`; it does not silently resubscribe. Readiness and retirement timeouts map to `TimedOut`. Counts and ordering can differ from operating-system watchers. The standard API has no registration-ready signal, so use rich subscriptions for subscribe-before-scan views. Recovery must invalidate and reconcile the view, even when a bounded retry is appropriate.

## Direct mounts and encrypted sessions

`Volume.makeDirect` and `Volume.layerDirect` own a direct backend. Run them only where OPFS synchronous access handles are available, normally a dedicated worker. Pass configured direct plugins through a fresh `plugins` thunk for each acquisition. The [direct example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/direct.ts) shows scoped acquisition. `Volume.unsafeBackend(volume)` only borrows the backend; do not call `closeVfs` yourself or use it after scope close. Prefer `OpfsFileSystem` for ordinary I/O.

Encryption requires the separately supplied premium plugin and an application worker that registers it. The base adapter does not depend on that package. The [encrypted session](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/encrypted-session.ts) and its [worker](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/effect/examples/encrypted-session.worker.ts) inspect existing storage before opening it, keep one runtime, serialize saves and credential replacement, and preserve disposal failures. They never replay the failed save. An initial passkey belongs only to creation. Replacement must preserve the volume name, plugin profile, and request order.

An unlocked owner can accept a follower without authenticating that follower's secret. The secret is checked if the follower later becomes owner, which can fail. `Redacted` hides display while wrapped; requests and layers may retain revealed secrets, and JavaScript does not guarantee zeroization. Mounting with encryption does not encrypt or migrate existing plaintext storage.

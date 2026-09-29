# Review: Effect v4 adapter API draft

Date: 2026-09-29
Reviews: [effect-adapter-api.md](./effect-adapter-api.md)
Repository baseline: `a5b5084f90ea375b62a70ee4d74552093c648c2a`
Upstream checked: `effect@4.0.0-rc.118` (npm `rc` tag; identical to `Effect-TS/effect` `main` at `35ac25a8`), `@effect/platform-node-shared@4.0.0-rc.118`. The npm `latest` tag is still 3.x, and `effect-smol` is stale at beta.98.
Premium checked: `opfs-vfs/opfs-vfs-premium` `origin/main` at `fbda9c5`, `packages/plugin-encryption`.

## Verdict

The ownership model is right: the volume is the scoped resource, the filesystem is a pure projection of it, plugins are fixed at mount, and there is no global registry. Keep all of that.

Three parts of the draft are harder than they need to be, and one is unsound:

1. **Unsound:** typing mount errors by the selected plugins (C3). A plaintext mount can fail because the storage is protected, so the error type cannot depend on which plugins were requested. Use one fixed mount error union. The premium plugin already tells credential, key-derivation, structure and integrity failures apart. Four of its throw sites need a code or a different class first.
2. **Unnecessary:** the watch bridge problem (C2). `plugin-subscriptions` is not premium code. It has the same license as core, and `@opfs-vfs/react` already depends on it directly. The adapter can do the same.
3. **Unnecessary:** a private overflow policy for the adapter's subscription queue. The subscription client already waits for the listener before it acknowledges an event, so a suspending queue offer gives end-to-end backpressure. Overflow then happens only at the owner, which already reports it.
4. **Contradictory:** a subscription tied to the caller's `Scope` must also "release early after `Stream.take`", and unknown retirement has no delivery path (C4/C5). A small handle fixes both.

Findings are ordered by impact. Section 5 answers the numbered review questions. Section 6 collects the proposed API in one place.

## 1. Blockers

### B1. Mount errors cannot be inferred from plugin selection (C3)

The draft's goal is "unencrypted `E = VolumeError`, encrypted `E = VolumeError | EncryptionError`". This doesn't hold, and not only because `VfsPluginRequest` lacks an error type parameter:

- A mount **without** the encryption plugin fails when protection markers exist. Core throws `EINVAL` "This volume requires a plugin that owns .vault" ([opfs-vfs.ts:1047-1056](../../packages/opfs-vfs/src/opfs-vfs.ts)). That is the most important encryption-related failure an application must handle, and it occurs on the plaintext path.
- A worker follower attaches to an owner that is already open. What it can observe depends on the owner, not on its own request list.
- The draft already notes that branching on `inspect` produces the union of both branches.

Typing errors by plugin therefore gives false precision. It also needs a new descriptor contract and matching changes in the premium package.

**Recommendation:** every mount has the same error type, `VolumeError | EncryptionError`. Both are decoded in the base adapter from the bounded `RemoteErrorDetails.code` string. This needs no premium import, because the codes already cross the worker boundary. The React SDK already classifies them ([react/src/errors.ts:49](../../packages/react/src/errors.ts)). The codes are regular enough for the adapter to decode, but a few premium throw sites need to be fixed first (below).

#### What the premium plugin can actually tell apart (Q7)

Checked in `opfs-vfs-premium` `origin/main` at `fbda9c5`, `packages/plugin-encryption/src`. Every coded error is an `Error` subclass with a fixed `code`, defined in `crypto/format.ts:164-222`. The codes match core's `CODE` pattern, so they survive the worker transport.

| Code / signal | Throw sites | What it actually means | Reason for the adapter |
| --- | --- | --- | --- |
| `EVOLUMELOCKED` "No key-slot matched the provided secret" | `crypto/keyring.ts:217` | Every slot's AES-GCM unwrap failed authentication. `tryUnwrap` treats only `OperationError` as a wrong secret (`keyring.ts:162-165`). A tampered or bit-rotted slot looks the same. So does a password tried against a passkey-only (HKDF) vault (`keyring.ts:140`). | `CredentialsRejected`. Document: "no key slot accepted this secret; if the secret is right, the vault may be damaged." |
| `EVOLUMELOCKED` "Encrypted volume is missing its vault" | `encrypted-storage.ts:111` | `.crypt`/`.crypt.log` exist without `.vault`. **Not a credential problem.** | Needs a premium fix, see below. |
| `EVOLUMELOCKED` "Encrypted volume has no key slots" | `encrypted-storage.ts:115` | The vault is damaged, or all its slots were removed. **Not a credential problem.** | Needs a premium fix, see below. |
| `EKDF` | `keyring.ts:145`, raised only when no slot matched (`keyring.ts:214-216`) | Key derivation failed (WASM load, OOM). The secret was never tested. The source comments explicitly forbid treating it as a wrong password. | `KeyDerivationFailed`. Don't ask for a new secret; retrying after a reload may work. |
| `EVAULTCORRUPT` | `keyring.ts:286, 300, 363` | The vault header structure is invalid. | `VaultCorrupt`. Restore `.vault` from backup; new credentials won't help. |
| plain `Error` "unsupported vault version" / "unsupported cipher id" / "not a vault header (bad magic)" | `keyring.ts:344, 349, 355` | Future format, or damage. **No code.** | Needs a premium fix: code `EVAULTCORRUPT`, or a new `EVAULTFORMAT` → `UnsupportedFormat`. |
| `ECRYPTSIDECAR` | `crypto/format.ts:217` | The `.crypt` nonce/tag table is corrupt. | `SidecarCorrupt`. |
| `ECRYPTOINTEGRITY` | `crypto/crypto-handle.ts:145, 158`, `crypto/cipher.ts:99, 145` | A block or record failed authentication: tampering or corruption. Happens at mount **and during later reads**. | `IntegrityFailure`. |
| `ECRYPTOINTEGRITY` "cipher destroyed — cannot open after volume close" | `crypto/cipher.ts:93, 139` | Use after close. **A lifecycle error, not integrity.** | Needs a premium fix: throw `EBADF`. |
| plain `Error` "Cannot enable encrypted storage on existing plaintext volume" | `encrypted-storage.ts:128` | Encryption was requested for an existing plaintext volume. **No code.** | Needs a premium fix: a code such as `EPLAINTEXTVOLUME` → `PlaintextVolume`. The application's answer is `migrateEncryption`. |
| plain `Error` / `RangeError` from `validateEncryptionConfig` | `config-validation.ts:37-140` | Invalid options, thrown synchronously by `encryptionRequest`. | `VolumeError` kind `configuration`. No code needed; this is a programming error. |
| core `EINVAL` "This volume requires a plugin that owns .vault" | core `opfs-vfs.ts:1047-1056` | Mounted without the encryption plugin. | Needs a core fix: code `VFS_STORAGE_PLUGIN_REQUIRED` → `StoragePluginRequired`. |

Consequences for the draft:

- **Drop `CredentialsRequired`.** The plugin always has a secret; `validateSecret` rejects an empty one. The only "credentials needed" signal is a mount without the plugin, which is `StoragePluginRequired`.
- **Drop `Ambiguous`.** The plugin already separates infrastructure (`EKDF`), structure (`EVAULTCORRUPT`, `ECRYPTSIDECAR`) and authentication. The one real ambiguity, a wrong secret versus a damaged slot, is inherent to AEAD. It belongs in the documentation of `CredentialsRejected`, not in a separate reason.
- **The adapter must not map `EVOLUMELOCKED` to `CredentialsRejected` until the two premium throw sites change.** A missing vault would otherwise look like a wrong password. Users would retry forever, or reset a volume that could have been restored from backup, which is exactly what `VaultCorruptError`'s own comment warns about. There is no clean workaround in the adapter, because `peekVolume.encrypted` doesn't say which marker exists. Land the premium fix before the adapter ships.
- **Integrity failures also happen after mount.** A read that hits `ECRYPTOINTEGRITY` fails in the filesystem as `PlatformError` `InvalidData`, with `reason.cause` set to the `EncryptionError`. There is one decoder for every operation (section 5, question 8).

**Premium changes, all small (message-only throws that get a code):**

1. `encrypted-storage.ts:111, 115`: throw `VaultCorruptError` (or a new `EVAULTMISSING`) instead of `VolumeLockedError`.
2. `keyring.ts:344, 349, 355`: give format and magic failures a code. Use `EVAULTCORRUPT` for bad magic, and `EVAULTFORMAT` for an unknown version or cipher.
3. `encrypted-storage.ts:128`: give "existing plaintext volume" a code.
4. `cipher.ts:93, 139`: use `EBADF` for use after close.

**Core change:** give "protected storage without its storage plugin" its own code, `VFS_STORAGE_PLUGIN_REQUIRED` with `sidecar` in the details. Today it is an `EINVAL` identified only by its message. The draft rightly forbids message matching.

`StoragePluginRequired` should be an `EncryptionError` reason, not a `VolumeError`. The application handles it the same way: it asks for credentials and remounts with the plugin. Putting it under `EncryptionError` lets one `catchTag` cover the whole unlock flow.

**Worker followers aren't authenticated.** A follower whose secret is wrong still mounts successfully when an unlocked owner already exists ([docs/API.md](../../docs/API.md), "Matching profiles do not authenticate follower credentials"). A successful mount therefore doesn't prove that this tab's secret is correct. Say so next to the unlock example. An application that needs per-tab verification must use a dedicated transport with `forceLeader`, or check a known value itself. The adapter shouldn't pretend otherwise.

**Ownership of `EncryptionError`:** export it from the base adapter. It is decoded from core-visible codes, so moving it to premium buys nothing.

### B2. Subscription backpressure already exists; the adapter should not add an overflow policy

The draft asks for "a private bounded queue per subscription" and "if buffering … overflows, fail visibly and release the subscription". That builds a second overflow policy on top of one that already works:

- The client runs the listener, **awaits** it, and only then sends `ack` ([plugin-subscriptions/src/client.ts:213-219](../../packages/plugin-subscriptions/src/client.ts)).
- The owner allows one unacknowledged event per subscription and buffers up to 4,096 pending records. When that bound is exceeded it terminates the subscription with `SUBSCRIPTION_OVERFLOW` ([README limits](../../packages/plugin-subscriptions/README.md)).

So the adapter's listener can be `(change) => runPromise(Queue.offer(queue, change))` on a small bounded queue with the suspend strategy. A slow consumer delays the `ack`, the owner buffers, and the owner's existing limit produces the typed overflow. The adapter queue can never overflow, so it needs no overflow code path, no dropping and no unbounded offers. Capacity only affects latency; 16 is plenty.

Two ordering details belong in the spec:

- On consumer exit, call `unsubscribe()` **before** shutting down the queue. If the queue shuts down first, the pending `offer` rejects while the entry is still `active`, and the client reports `SUBSCRIPTION_CALLBACK_FAILED` ([client.ts:220-224](../../packages/plugin-subscriptions/src/client.ts)).
- `onError` (from the client's `setTimeout`) must fail the queue with the typed `SubscriptionError` so the stream ends with it. It must not be dropped.

### B3. Subscription lifetime contradicts itself, and retirement has no delivery path (C4, C5)

`subscribe: Effect<Stream, SubscriptionError, Scope>` ties registration to the caller's scope. The draft also requires early release after `Stream.take` and a visible unknown retirement. The stream can't end the caller's scope, and a finalizer can't return a typed value. Fixing each requirement separately produces hidden rules.

**Recommendation:** return a handle. It is only one field wider than the draft's shape, and it keeps registration readiness:

```ts
interface Subscription {
  /** Single consumer. Ending, failing or interrupting it unsubscribes. */
  readonly changes: Stream.Stream<FileChange, SubscriptionError>
  /** Completes when the owner confirms retirement. Never fails. */
  readonly retired: Effect.Effect<SubscriptionRetirement>
}

subscribe(options: SubscribeOptions): Effect.Effect<Subscription, SubscriptionError, Scope.Scope>
```

Semantics:

- `subscribe` completes after `registered`, as in the draft, so subscribe-before-scan and subscribe-before-write work.
- `changes` has a finalizer that calls `unsubscribe()` (idempotent). `Stream.take(1)` releases the owner registration right away. The scope finalizer calls it too, as a backstop.
- Running `changes` a second time fails with a defect ("subscription stream already consumed"). This enforces single-consumer use; it is not a replay. Consuming twice is a programming error.
- `retired` wraps the core `closed` promise. The recovery pattern in the subscriptions README ("await the old subscription's `closed` and stop on `unknown`") becomes `const r = yield* sub.retired; if (r.status === "unknown") …`. Recovery code gets a typed value without inspecting `Cause`.
- The scope finalizer does **not** wait for `retired`. Closing the scope should not block on an owner round trip. Callers who need the barrier wait for it explicitly. For an unknown retirement that nobody waited for, log it at warning level and do not turn it into a `Die`. It is not a defect, and the core client already refuses later setups in the same generation after an unknown setup cleanup (`SUBSCRIPTION_RETIREMENT_UNKNOWN`).

This answers C5: choose the handle, because the draft's shape can't express retirement.

### B4. Owner loss and takeover are not specified

Layers are built once, but the worker backend can lose its owner permanently (`VFS_ATTACHMENT_LOST`) and can change owner generations. After a takeover, earlier descriptors are invalid ([docs/API.md](../../docs/API.md), "Ownership changes invalidate pending requests and descriptors"). The draft lists "stale descriptor protection" as a test target but doesn't say what the service does.

Specify:

- **Terminal loss.** The `Volume` service becomes permanently failed. Every later operation fails with `VolumeError` of kind `lifecycle` (`PlatformError` `Unknown` whose `cause` is that `VolumeError`). The adapter does not remount. Applications recover by rebuilding the layer: dispose and recreate their `ManagedRuntime`, or rerun a scoped workflow with `Effect.retry` around `Volume.make`. Put this recipe in the docs.
- **File handles.** Each `File` is pinned to the generation that opened it through `client.forGeneration(ownerGeneration)` ([worker-client.ts:3123](../../packages/opfs-vfs/src/worker-client.ts)). After a takeover, handle operations are refused before dispatch. They surface as `BadResource` with `outcome: "not-applied"`. Path operations (not tied to a handle) can go on through the new owner.
- **Possibly-applied writes.** Map `VfsCommandError.dispatch === "sent"` on a mutation to `outcome: "possibly-applied"`, as React's `toVolumeError` does ([react/src/errors.ts:79-99](../../packages/react/src/errors.ts)). Interrupting a dispatched mutation gets the same outcome. It is never retried.

## 2. Important, not blocking

### I1. Watch bridge (C2): depend on `plugin-subscriptions` directly

The draft treats the subscriptions client as optional premium-like code. It isn't:

- `@opfs-vfs/plugin-subscriptions` has the same license as core (PolyForm Noncommercial 1.0.0). Encryption is the only separately licensed plugin.
- `@opfs-vfs/react` already lists it as a non-optional peer, and its bundled worker registers it ([react/src/vfs.worker.ts](../../packages/react/src/vfs.worker.ts)).
- The client needs only `openFileChangeChannel`, which both `OpfsVfs` and `OpfsVfsWorkerClient` implement.

**Recommendation:** make `@opfs-vfs/plugin-subscriptions` a peer dependency and implement `fs.watch` directly on the volume. `watch` works when the mount's active profile includes `subscriptions`. Otherwise it fails with a typed error, which matches the draft's table. With this there is no bridge, no second layer and no layer variants. `Subscriptions.layer` stays as the service that demands the capability when the layer is built.

**Follow React's lead on defaults:** ship a bundled worker that registers `subscriptions`, and add `subscriptionsRequest()` automatically when the application doesn't supply its own worker ([react/src/volume.tsx:278-290](../../packages/react/src/volume.tsx)). Then `Volume.layer({ fileName: "documents.bin" })` supports watch without further setup. Only encryption needs an application worker.

Upstream `FileSystem.WatchBackend` exists. `NodeFileSystem` looks it up once with `Effect.serviceOption` when the layer is built. Honoring it would cost one line, but no OPFS use case needs it. Skip it until someone asks.

Watch details to settle against upstream behavior:

- Node's `watch` calls `stat(path)` first, so a missing path fails with `NotFound` before registration. Do the same.
- Node emits the **relative** filename from `fs.watch`. The draft maps OPFS events to absolute volume paths. Pick one and document it. Absolute paths are more useful, and Node's relative names are an artifact of `fs.watch`. Either way, portable consumers need to know.
- Rename maps to `Remove` plus `Create`, which is how Node reports it. List what symlink events map to, or say they are not emitted.

### I2. Several volumes in one layer graph

With one `Volume` tag and one `FileSystem` tag, two `Volume.layer` values can't coexist in a layer graph. Section 10 falls back to `Effect.provideService` inside one scoped block. That works, but it drops layers exactly where applications use them.

No new API is needed. `OpfsFileSystem.make(volume)` already covers it. Replace the section 10 example with the layer-based pattern:

```ts
class DocumentsFs extends Context.Service<DocumentsFs, FileSystem.FileSystem>()("app/DocumentsFs") {}
class CacheFs extends Context.Service<CacheFs, FileSystem.FileSystem>()("app/CacheFs") {}

const DocumentsFsLive = Layer.effect(DocumentsFs)(
  Effect.map(Volume.make({ fileName: "documents.bin" }), OpfsFileSystem.make)
)
const CacheFsLive = Layer.effect(CacheFs)(
  Effect.map(Volume.make({ fileName: "cache.bin" }), OpfsFileSystem.make)
)
// Layer.effect scopes Volume.make to the layer's lifetime.

// A portable workflow gets the standard tag locally:
const fromDocuments = <A, E>(self: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.flatMap(DocumentsFs.asEffect(), (fs) => Effect.provideService(self, FileSystem.FileSystem, fs))
```

Also state that `Volume.layer` values are memoized by reference within one layer graph. Two `Volume.layer(sameOptions)` calls mount twice. That fails, or attaches as a follower, depending on core ownership. The draft says this, but put it next to the example, where readers will look.

### I3. Configuration ergonomics

The section 6 example spends 15 lines on `Effect.try` around an object literal, repeats `fileName` in the error, and needs `as const` because `Effect.try` widens the literal. The adapter should do that work:

- Accept `Options | Effect<Options, E, R>`. Most callers pass plain options.
- Run the configuration inside acquisition. Turn a thrown exception into `VolumeError({ kind: "configuration", operation: "configure", fileName, cause })`, and keep typed failures from a supplied Effect as they are. Callers never write `Effect.try`.
- **Direct mounts:** configured plugins are single-use and claimed even when a mount fails ([plugin-config.ts:168-184](../../packages/opfs-vfs/src/plugin-config.ts)), so plain options holding plugin instances break on the second acquisition. Make that impossible to write: `DirectMountOptions.plugins` is a thunk, `() => ConfiguredVfsPlugin[]`, which the adapter calls on each acquisition. Worker requests are copied by core and are reusable, so a plain array is fine there.

Result:

```ts
const DocumentsVolume = Volume.layer(
  Effect.gen(function* () {
    const secret = yield* Credentials.secret // app service; its requirement becomes the layer's R
    return {
      fileName: "documents.bin",
      transport: "dedicated",
      worker: () => new Worker(new URL("./filesystem.worker.ts", import.meta.url), { type: "module" }),
      plugins: [encryptionRequest({ secret: Redacted.value(secret) }), subscriptionsRequest()],
      openMode: "open-existing"
    }
  })
)
```

Use `Redacted` for secrets in every example, and state that `VolumeError.cause` never contains mount options. The worker's request copy stays private, but an adapter that includes `options` in an error would leak it.

### I4. Acquisition before `ready`: give the recipe, not only the risk

The draft warns that wrapping `ready` alone is not enough. The existing APIs make the correct version short. Write it into the spec so implementers don't have to work it out:

```ts
const acquireWorker = (options) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) => openOpfsVfsWorker(options.fileName, { ...options, signal }), // accepts AbortSignal
      catch: toVolumeError("open", options.fileName)
    }),
    (client) => closeOrDie(client)
  ).pipe(
    Effect.tap((client) => Effect.tryPromise({ try: () => client.ready, catch: toVolumeError("ready", options.fileName) }))
  )
```

The release is registered as soon as the client object exists, so interrupting during `ready` closes it. Core already handles closing before `ready` on both backends:

- **Direct:** `closeRequested` is checked after the volume lock is acquired, and the mount fails with `EBADF` "Volume closed during initialization" ([opfs-vfs.ts:1040-1041](../../packages/opfs-vfs/src/opfs-vfs.ts)).
- **Worker:** `closeWorker` skips the flush when the client never opened, disposes local resources, and waits for its election and attachment locks ([worker-client.ts:2634-2641](../../packages/opfs-vfs/src/worker-client.ts)). An elected leader with `INIT` in flight waits for worker initialization, sends `CLOSE_VFS` only if the mount succeeded, and then terminates the worker. Before `INIT` it terminates directly ([worker-client.ts:2174-2194](../../packages/opfs-vfs/src/worker-client.ts)). React relies on this path already: `client.closeVfs().catch(() => {})` followed by `dispose()` ([react/src/volume.tsx:679-680](../../packages/react/src/volume.tsx)).

No core test covers closing before `ready`. The existing status test closes after `ready` ([worker-status.test.ts:163](../../packages/opfs-vfs/src/__tests__/worker-status.test.ts)). Add tests for three windows: before election, leader with `INIT` in flight, and a follower attaching. Put them in core, not in the adapter, because the guarantee belongs to core.

The release should be `closeVfs()` and then `dispose()`, like React, so that a failed close still frees transport resources. A close failure becomes `Die(VolumeError)` (P4). When the failure comes from an acquisition that never became ready, discard it: nothing was ever exposed to the program, so the acquisition error is the one to report.

### I5. `volume.sync` is ambiguous, and core ignores sync after close

- The worker client has two commands, `sync()` → `SYNC` and `flushVfs()`/`flush()` → `FLUSH` ([worker-client.ts:2619, 3256-3261](../../packages/opfs-vfs/src/worker-client.ts)). The direct mount has `syncSync()` and `fsyncSync(fd)`. The spec must say which one `volume.sync` calls on each backend. It should be the one that gives the durability barrier the docs recommend at save boundaries.
- Direct `syncSync()` returns silently after close ([opfs-vfs.ts:3313-3314](../../packages/opfs-vfs/src/opfs-vfs.ts)). The draft requires "operations after closure must fail", so the adapter must check its own closed flag and fail with `BadResource`/`VolumeError`. It can't rely on core here.

### I6. Filesystem conformance: what is actually required

Facts from `effect@4.0.0-rc.118` that change the scope of section 5:

- `FileSystem.make` derives only `exists` (from `access`), `readFileString`, `writeFileString`, `stream` and `sink`. Everything else must be implemented, including `watch`, `glob`, `copy`, `chown`, `utimes` and all four `makeTemp*` methods.
- `stream` and `sink` are derived from `open` and `File` (`seek`, then `readAlloc` in 64 KiB chunks; `Sink.forEach(file.writeAll)`). `File` is therefore load-bearing. The 16 MiB RPC limit only affects `readFile`, `copyFile` and `copy`.
- `File` has no `fd`. `seek` takes and returns plain `bigint`. `truncate` and `readAlloc` take `number`. `File.Info.size` is `ByteSize` (branded `bigint`). There is no `FileSystem.Size` in v4.
- `PlatformError` always has the top-level tag `"PlatformError"`. The kind is `reason._tag`. Its `SystemErrorTag` set includes `Busy`, `InvalidData`, `TimedOut` and `WriteZero`, which the draft's mapping doesn't use.

Proposed method table (replaces the obligations list in section 5):

| Method | Implementation |
| --- | --- |
| `access` | `stat`. Check `readable`/`writable` against mode bits only if core enforces them on open; otherwise document that only existence is checked. |
| `chmod`, `utimes`, `symlink`, `link`, `readLink`, `realPath`, `rename`, `truncate` | Forward. `utimes` converts `Date \| number` to milliseconds. |
| `chown` | Fail with `Unknown`, whose cause has code `ENOTSUP`. Never succeed silently. |
| `copyFile` | Chunked `open`/`read`/`write`, never `readFileBuffer`. |
| `copy` | Recursive: `readDirectory` plus `copyFile`. `overwrite` and `preserveTimestamps` via `utimes`. Not atomic; say so. |
| `glob` | Defer. Fail with `Unknown`/`ENOTSUP` in v1, since it needs a matcher dependency. Add it when a consumer asks. |
| `makeDirectory`, `readDirectory` | Forward. `recursive` read uses `listPaths()` with a prefix filter. |
| `makeTemp*` | `/tmp/<prefix><crypto.randomUUID()>` inside the volume. Scoped variants remove recursively on release. |
| `open` + `File` | The adapter keeps the position as `bigint` and always passes explicit offsets to `read`/`write`. Core's cursor is never used, so there are no cursor races between the page and the worker. One-permit semaphore per `File`, as in Node. Append flags: write at `fstat().size` inside the permit. |
| `readFile` | `readFileBuffer` (one round trip). Fall back to chunked reads through `open` when core rejects on the 16 MiB limit. Direct mounts have no limit. |
| `writeFile` | `writeFileBuffer` for `w`, and `open` plus `writeAll` for the other flags. Copy the caller's buffer before any transferring call. |
| `remove` | `recursive` → `remove`, file → `unlink`, directory → `rmdir`. `force` ignores `NotFound`. |
| `stat` | `dev: 0`, `ino`/`nlink` from the VFS if exposed (else `Option.none()`), `uid`/`gid`/`rdev`/`blksize`/`blocks` as `none`. |
| `watch` | See I1. |

Path rule: the volume has no working directory, so **reject relative paths** with `BadArgument` instead of resolving them against `/`. Resolving silently hides caller bugs, and rejecting is less code.

Errno mapping. `NodeFileSystem` in rc.118 maps exactly seven codes and turns everything else into `Unknown` (`@effect/platform-node-shared` `src/internal/utils.ts`, `handleErrnoException`): `ENOENT` → `NotFound`, `EACCES` → `PermissionDenied`, `EEXIST` → `AlreadyExists`, `EISDIR`/`ENOTDIR`/`ELOOP` → `BadResource`, `EBUSY` → `Busy`. Node sends **`EPERM` and `EBADF` to `Unknown`**, which contradicts the draft's mapping.

Use Node's seven mappings exactly. Add only mappings that make an `Unknown` more specific, because portable code can't depend on a Node `Unknown` staying `Unknown`:

| VFS | `reason._tag` | Same as Node? |
| --- | --- | --- |
| `ENOENT` | `NotFound` | Yes |
| `EEXIST` | `AlreadyExists` | Yes |
| `EACCES` | `PermissionDenied` | Yes |
| `EISDIR`, `ENOTDIR`, `ELOOP` | `BadResource` | Yes |
| `EBUSY` | `Busy` | Yes |
| `EPERM` | `PermissionDenied` | Extension (Node: `Unknown`) |
| `EBADF`, and a handle refused after a generation change | `BadResource` | Extension (Node: `Unknown`) |
| `VfsCorruptionError` (any `category`), `ECRYPTOINTEGRITY`, `ECRYPTSIDECAR` | `InvalidData` | Extension (no Node equivalent) |
| `EINVAL` from core | `Unknown` (`BadArgument` is for invalid adapter arguments, per the draft) | Yes |
| `ENOSPC`, `QuotaExceededError`, `EFBIG`, `ENOTEMPTY`, `ENAMETOOLONG`, `ENOTSUP`, `VFS_*` | `Unknown` | Yes |

Fill `syscall` with the VFS method name and `pathOrDescriptor` with the path, as Node does, so that `PlatformError.message` reads the same way.

For every mapped error, set `reason.cause` to the adapter's `VolumeError`, never the raw error. Callers then get one inspectable type with `code`, `outcome` and corruption details everywhere, and serialization stays bounded.

**Conformance suite:** write it once as a function of `FileSystem.FileSystem`. Run it against `NodeFileSystem` in Node and against `OpfsFileSystem` in the browser runner. Every difference is either a bug or a documented difference. This is cheaper and more convincing than listing semantics in prose.

## 3. Preferences

- **P1. `Volume.layer` could also provide `FileSystem`.** `OpfsFileSystem.make` does no I/O, so a volume layer that outputs `Volume | FileSystem.FileSystem` costs nothing and saves one composition step in the common single-volume case. `OpfsFileSystem.layer` and `make` stay for the other cases. The draft's point that applications can omit `Volume` from their context still holds if `OpfsFileSystem.layer` remains.
- **P2. Rename `open`/`openDirect` to `make`/`makeDirect`.** Effect convention names a scoped constructor `make` and its layer form `layer`. `Volume.open` also reads like a file operation next to `fs.open`.
- **P3. Status (C1): ship a snapshot only.** `volume.persistence: Effect<PersistenceSnapshot>`, where `PersistenceSnapshot = { state: LocalPersistenceState | "unknown", lastError: RemoteErrorDetails | null, failureRevision: number }`. The worker client's `null` persistence maps to `"unknown"`. Leave role, transport, generation and a change stream out of v1. The direct mount's persistence listener is internal (`persistenceSources` in `mount-context`), so a stream would need a new core export or polling. Add it when a UI needs live status.
- **P4. Shutdown (C4): no checked-shutdown operation.** `volume.sync` is the typed checkpoint. A failed orderly close in the finalizer becomes a `Die` whose value is the `VolumeError`, so it stays inspectable in `Exit`. Do not expose `shutdownSharedVfs`: it is a global operation across pages, and React also leaves it out.
- **P5. Raw backend escape hatch: yes, one.** Applications that also use the PGlite, DuckDB or Wasmer adapters on the same mount need the backend. Offer `Volume.unsafeBackend(volume): OpfsVfs | OpfsVfsWorkerClient`, documented as "do not close; not valid after the scope ends". Otherwise users mount twice.
- **P6. Share error classification with React.** The kind table in [react/src/errors.ts](../../packages/react/src/errors.ts) is what the Effect adapter needs. Move `classify` and the outcome logic into a core subpath (for example `@opfs-vfs/opfs-vfs/errors`) so the two SDKs don't drift. The Effect `VolumeError` then reuses React's `kind` and `outcome` vocabulary, so documentation and support answers carry over between SDKs.
- **P7. Direct mount operations block and can't be interrupted.** Say so. Each call runs synchronously inside `Effect.sync`, so `readFile` on a large file blocks the worker thread and ignores interruption until it returns.
- **P8. Pin `effect` exactly while v4 is a release candidate.** Use `effect: "4.0.0-rc.118"` as the peer, or a tested range, the same way premium pins core.

## 4. Smaller corrections to the draft

- Section 2: `peekVolume` requires names ending in `.bin`. `Volume.inspect` should fail with `VolumeError` of kind `configuration` for other names, not throw.
- Section 4: `VolumeService` lists `sync` but not the capability flag that `Subscriptions.layer` and `watch` rely on. Keep it internal. `Subscriptions.layer` can read it through a module-private accessor, and no public field is needed.
- Section 6: `Subscriptions.layer: Layer<Subscriptions, SubscriptionError, Volume>`. A missing capability is a mount-profile problem, not a subscription runtime failure. Fail with `VolumeError` (kind `unsupported`) instead.
- Section 7: `SubscriptionError.code` should be a closed literal union: `SUBSCRIPTION_OVERFLOW | SUBSCRIPTION_INTERRUPTED | SUBSCRIPTION_CALLBACK_FAILED | SUBSCRIPTION_RESYNC_REQUIRED | SUBSCRIPTION_RETIREMENT_UNKNOWN | EINVAL | EBADF`. `CALLBACK_FAILED` can't happen once B2's ordering is followed. Keep it in the union anyway, because it comes from core.
- Section 9 example: with the B3 handle, it reads `sub.changes.pipe(Stream.take(1), …)`. It then shows early release without extra explanation.

## 5. Answers to the review questions

### Numbered questions from the draft

1. **Plugin errors (C3):** use a fixed union, `VolumeError | EncryptionError` on every mount, decoded from `RemoteErrorDetails.code` in the base adapter. Don't add a descriptor or error generic. You need one core code (`VFS_STORAGE_PLUGIN_REQUIRED`) and four small premium changes that add codes to message-only throws (B1).
2. **Watch integration (C2):** peer-depend on `plugin-subscriptions`, implement `watch` directly, and use a bundled worker that registers subscriptions by default, as React does (I1). No bridge.
3. **Shutdown (C4):** no explicit checked shutdown. Use `sync` for typed durability, and let close failures become `Die(VolumeError)` in `Exit` (P4). Unknown subscription retirement goes through `Subscription.retired` (B3).
4. **Subscription shape (C5):** keep registration as an Effect, but return `{ changes, retired }` instead of a bare stream. The stream finalizer unsubscribes. A second run is a defect. Backpressure comes from the suspending offer (B2, B3).
5. **Volume status (C1):** a persistence snapshot only (P3).
6. **Compatibility:** pin `effect@4.0.0-rc.118`. Use the method table and the errno table in I6. Node's actual table maps seven codes, and `EPERM`/`EBADF` stay `Unknown` there. Add a differential conformance suite against `NodeFileSystem`.
7. **Premium evidence:** answered in B1 from `opfs-vfs-premium@fbda9c5`. The plugin separates credentials (`EVOLUMELOCKED` from the slot loop), key-derivation infrastructure (`EKDF`), vault structure (`EVAULTCORRUPT`), sidecar structure (`ECRYPTSIDECAR`) and block authentication (`ECRYPTOINTEGRITY`). Four throw sites are misclassified or have no code and need a small fix before the adapter ships.

### Other open points in the draft

8. **Plugin errors on persistence and filesystem operations** (draft section 7, "precise plugin errors here remain open"). Use one decoder for every operation. Volume-level operations (`sync`, `persistence`, `inspect`) have `E = VolumeError | EncryptionError`. `ECRYPTOINTEGRITY` can come from any read, and a seal failure can come from `sync`. Filesystem operations keep `PlatformError`: encryption codes map to `InvalidData`, with `reason.cause` set to the decoded `EncryptionError`. An application that cares uses `catchTag("PlatformError")` and checks `e.reason.cause instanceof EncryptionError`. Show that in one example.
9. **Where `EncryptionError` lives.** In the base adapter (B1). It is decoded from codes, and moving it to premium would force every application to install premium just to name the type in `E`.
10. **An encryption service** (draft section 6: "justified only by separately supported operations… none specified"). Premium has such operations: `exportVolumeStream`/`exportVolumeEncrypted`, `importVolumeEncrypted`, `migrateEncryption`, and `enrollPasskey`/`assertPasskey` (`packages/plugin-encryption/src/{export-blob,migrate-encryption,passkey}.ts`). All of them take a volume **name** and mount the volume themselves (for example, `migrateEncryption` constructs `OpfsVfs` directly). None needs a live `Volume`. So:
    - Keep them out of v1 of `@opfs-vfs/effect`, as the draft says.
    - When they are added, put them in a separate entry point that has premium as its peer (for example `@opfs-vfs/effect-encryption`), as plain Effects: `Encryption.export(name, options): Stream<Uint8Array, EncryptionError | VolumeError>`, `Encryption.import(...)`, `Encryption.migrate(...)`. They are not methods on `Volume`.
    - Document that they conflict with a live mount of the same name. They take the volume lock, so running them while a `Volume` layer holds that name fails with `EBUSY`, or waits. The application releases the layer first.
    - `migrateEncryption` constructs a direct `OpfsVfs`, so it runs only in a dedicated worker. Say so in the type docs, or expose it only through `Volume.makeDirect`-style constructors.
    - `onProgress` becomes a `Stream` of progress values, or an `Effect` that emits progress to a `Queue`. Don't put a callback option on an Effect API.
11. **Passkeys.** `initialPasskey` forces `requiredOpenMode: "create-new"` (`plugin-encryption/src/config.ts`). Creating and opening therefore need different options, and passing `initialPasskey` with `open-existing` fails in core validation as `VolumeError` kind `configuration`. Show two named option builders in the docs (`createEncrypted`, `openEncrypted`), not one options object with conditional fields. The secret type is `string | Uint8Array`, so accept `Redacted<string | Uint8Array>` in adapter-owned helpers.
12. **Raw backend escape hatch** (draft section 3). Yes, one: `Volume.unsafeBackend` (P5).
13. **Watch paths, renames and symlinks** (draft section 5). Core's `ChangeType` is `create | update | delete` with a `kind` of `file | directory | symlink` (`packages/opfs-vfs/src/changes.ts:1-15`). There is no rename event, so a rename arrives as `delete` plus `create`, and maps to `Remove` plus `Create`. Symlinks are ordinary entries with `kind: "symlink"`, and the standard `watch` drops `kind`. Use absolute volume paths in `WatchEvent.path` and document the difference from Node's relative names. Renaming a **directory** emits an event for every descendant, verified in [opfs-vfs/opfs-vfs#10](https://github.com/opfs-vfs/opfs-vfs/pull/10). `renameSyncImpl` records a `delete` for each old subtree path (deepest first), then a `create` for each new path (parent first). Each subscription's `path`, `scope`, `recursive` and `match` then filter those events. So a recursive `fs.watch` gets one `Remove`/`Create` pair per entry, and a watch on a single file inside the renamed directory gets `Remove`. The adapter doesn't need to expand the subtree itself. For a large directory, a single rename can emit many events against the owner's 4,096-record bound. Document that a rename of a very large tree can end in `SUBSCRIPTION_OVERFLOW` for a slow consumer.
14. **Relative paths** (draft section 5, "state how relative paths resolve"). Reject them with `BadArgument` (I6).
15. **Fanout.** The draft's `PubSub` guidance is right, and the handle doesn't change it: `sub.changes.pipe(Stream.toPubSub(...))` in application code. Don't add a broadcast API to the service.

## 6. Proposed API in one place

```ts
// @opfs-vfs/effect

// Errors (Schema.TaggedErrorClass)
class VolumeError {
  readonly _tag: "VolumeError"
  readonly fileName: string
  readonly operation: string
  readonly kind: VolumeErrorKind // shared with React: configuration | unsupported | filesystem | conflict | quota | corruption | lifecycle | persistence | unknown
  readonly code?: string
  readonly outcome: "not-applied" | "possibly-applied" | "unknown"
  readonly details: RemoteErrorDetails | null
  readonly cause?: unknown // never includes mount options or secrets
}
class EncryptionError {
  readonly _tag: "EncryptionError"
  readonly fileName: string
  readonly reason:
    | "StoragePluginRequired" // core VFS_STORAGE_PLUGIN_REQUIRED (new): ask for credentials, remount with plugin
    | "CredentialsRejected"   // EVOLUMELOCKED from the slot loop: no slot accepted this secret
    | "KeyDerivationFailed"   // EKDF: environment failure, the secret was never tested
    | "VaultCorrupt"          // EVAULTCORRUPT (+ missing vault / no slots after the premium fix)
    | "UnsupportedFormat"     // EVAULTFORMAT (new): unknown vault version or cipher
    | "SidecarCorrupt"        // ECRYPTSIDECAR
    | "IntegrityFailure"      // ECRYPTOINTEGRITY: tampering or corruption
    | "PlaintextVolume"       // EPLAINTEXTVOLUME (new): use migrateEncryption
  readonly code: string
  readonly cause?: unknown
}
class SubscriptionError {
  readonly _tag: "SubscriptionError"
  readonly code: SubscriptionErrorCode
  readonly cause?: unknown
}
type MountError = VolumeError | EncryptionError

// Volume
class Volume extends Context.Service<Volume, {
  readonly fileName: string
  readonly sync: Effect<void, VolumeError>
  readonly persistence: Effect<PersistenceSnapshot>
}>()("@opfs-vfs/effect/Volume") {}

Volume.inspect(fileName: string): Effect<VolumePeek, VolumeError>
Volume.make<E = never, R = never>(options: WorkerMountOptions | Effect<WorkerMountOptions, E, R>):
  Effect<Volume["Service"], MountError | E, Scope | R>
Volume.layer<E, R>(options: /* same */): Layer<Volume | FileSystem.FileSystem, MountError | E, R> // P1
Volume.makeDirect / Volume.layerDirect // DirectMountOptions.plugins is a thunk
Volume.unsafeBackend(volume): OpfsVfs | OpfsVfsWorkerClient // P5

// Filesystem
OpfsFileSystem.make(volume): FileSystem.FileSystem
OpfsFileSystem.layer: Layer<FileSystem.FileSystem, never, Volume>

// Subscriptions
class Subscriptions extends Context.Service<Subscriptions, {
  readonly subscribe: (options: SubscribeOptions) => Effect<Subscription, SubscriptionError, Scope>
}>()("@opfs-vfs/effect/Subscriptions") {}
Subscriptions.layer: Layer<Subscriptions, VolumeError, Volume>

interface Subscription {
  readonly changes: Stream<FileChange, SubscriptionError>
  readonly retired: Effect<SubscriptionRetirement>
}
```

The typical application after these changes:

```ts
// No custom worker: bundled worker, subscriptions on, fs.watch works.
const AppLive = Volume.layer({ fileName: "documents.bin" })

// Encrypted: application worker registers [encryption, subscriptions].
const EncryptedLive = Volume.layer(encryptedOptions).pipe(
  Layer.provideMerge(Subscriptions.layer) // only if the rich API is used
)

const unlock = (secret: Redacted.Redacted) =>
  Volume.make(encryptedOptions(secret)).pipe(
    Effect.catchTag("EncryptionError", (e) =>
      e.reason === "CredentialsRejected" || e.reason === "StoragePluginRequired"
        ? askAgain(e.reason) // application effect; one explicit retry
        : Effect.fail(e) // KeyDerivationFailed, VaultCorrupt, …: new credentials won't help
    )
  )
```

## 7. Evidence checked for this review

| Claim | Source |
| --- | --- |
| Listener is awaited before `ack` | `packages/plugin-subscriptions/src/client.ts:213-219` |
| Listener rejection while active → `SUBSCRIPTION_CALLBACK_FAILED` | `client.ts:220-224` |
| Owner bounds (4,096 pending, one unacknowledged) | `packages/plugin-subscriptions/README.md`, "Limits" |
| Plaintext mount of protected storage → `EINVAL` identified only by message | `packages/opfs-vfs/src/opfs-vfs.ts:1047-1056` |
| Close during initialization handled | `opfs-vfs.ts:1040-1041` |
| Direct `syncSync()` no-ops after close | `opfs-vfs.ts:3313-3314` |
| Worker `SYNC` vs `FLUSH` | `packages/opfs-vfs/src/worker-client.ts:2619, 3256-3261` |
| `forGeneration` refuses before dispatch after takeover | `worker-client.ts:3120-3150` |
| `openOpfsVfsWorker` accepts `AbortSignal` | `packages/opfs-vfs/src/index_internal.ts:39-46, 105` |
| Configured plugins claimed even on failure | `packages/opfs-vfs/src/plugin-config.ts:168-184` |
| Encryption codes already classified | `packages/react/src/errors.ts:49-50` |
| React hard-peers subscriptions; bundled worker registers it; auto-adds request | `packages/react/package.json`, `src/vfs.worker.ts`, `src/volume.tsx:278-290` |
| Same license for core and subscriptions | `packages/{opfs-vfs,plugin-subscriptions}/package.json` |
| `FileSystem.make` derives 5 methods; `File`/`PlatformError`/`WatchBackend` shapes | `effect@4.0.0-rc.118` `src/FileSystem.ts`, `src/PlatformError.ts` |
| Node looks up `WatchBackend` once at layer build; `watch` stats first; relative paths | `@effect/platform-node-shared@4.0.0-rc.118` `src/NodeFileSystem.ts` |
| Node maps seven errnos; `EPERM`/`EBADF` → `Unknown` | `@effect/platform-node-shared@4.0.0-rc.118` `src/internal/utils.ts` |
| Worker close before `ready` skips the flush, waits for `INIT`, then terminates | `worker-client.ts:2634-2641, 2174-2194` |
| Premium error classes and codes | `opfs-vfs-premium@fbda9c5` `packages/plugin-encryption/src/crypto/format.ts:164-222` |
| Wrong secret = AES-GCM `OperationError` on every slot; `EKDF` only when no slot matched | `…/crypto/keyring.ts:138-168, 205-218` |
| `EVOLUMELOCKED` reused for missing vault and empty slots | `…/encrypted-storage.ts:111, 115` |
| Vault version, cipher and magic failures have no code | `…/crypto/keyring.ts:344-355` |
| "Existing plaintext volume" has no code | `…/encrypted-storage.ts:128` |
| Use after close reported as `ECRYPTOINTEGRITY` | `…/crypto/cipher.ts:93, 139` |
| Standalone export/import/migrate/passkey operations take a volume name | `…/export-blob.ts:535, 646, 780`, `migrate-encryption.ts:111`, `passkey.ts:121, 183` |
| No rename change type; `kind` includes `symlink` | `packages/opfs-vfs/src/changes.ts:1-15` |

| Directory rename emits per-descendant delete, then create | `packages/opfs-vfs/src/opfs-vfs.ts` `renameSyncImpl`; test `packages/plugin-subscriptions/src/__tests__/subscription-rename.test.ts` ([opfs-vfs/opfs-vfs#10](https://github.com/opfs-vfs/opfs-vfs/pull/10)) |

Still unverified: close before `ready` is handled in the code, but no test covers it (I4).

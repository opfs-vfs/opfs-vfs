# Second review: revised Effect v4 adapter API

Date: 2026-09-29
Reviews: the working-tree revision of [effect-adapter-api.md](./effect-adapter-api.md) (the "revised review draft"), compared with the staged original
Earlier review: [effect-adapter-api-review.md](./effect-adapter-api-review.md)
Checked against: this repository at `a16b899`, `effect@4.0.0-rc.118` published sources, `opfs-vfs-premium@fbda9c5`

## Summary

The revision is a clear improvement. It absorbs the first review without copying its mistakes. I checked its corrections to that review, and they hold:

- `close-admission.test.ts` already covers closing before `ready`: held `INIT`, held `PING`, late `CLOSE_VFS` failure and follower readiness. The first review's "no core test covers it" was wrong.
- `GENERATION_METHODS` covers path commands and `sync`, not `open`/`read`/`write`/`close`/`fstat`/`fsync`/`ftruncate`/`seek` ([worker-client.ts:79-99](../../packages/opfs-vfs/src/worker-client.ts)). The first review's generation-bound `File` recipe relied on something that doesn't exist.
- The acquire step of `acquireRelease` is uninterruptible, so the `AbortSignal` in the first review's recipe would never fire.
- Numeric `utimes` input is in seconds, as in Node.
- A per-handle semaphore can't make "append = `fstat().size` + write" safe across clients. Native `O_APPEND` exists ([opfs-vfs.ts:193, 2281, 2425](../../packages/opfs-vfs/src/opfs-vfs.ts)).
- Worker `SYNC` runs `syncSync()` ([worker-runtime.ts:806-808](../../packages/opfs-vfs/src/worker-runtime.ts)). `FLUSH` runs `flushVfs()`, a full snapshot checkpoint. Mapping `volume.sync` to `SYNC` is right.
- React adds `subscriptionsRequest()` whenever the caller didn't request it, not only for its default worker ([react/src/volume.tsx:278-290](../../packages/react/src/volume.tsx)).

Five points need changes. The first is a blocker.

## 1. Blocker: a takeover should not invalidate the volume

Section 4 says: "A confirmed owner replacement or terminal client failure permanently invalidates this service." With dedicated transport, that makes every multi-tab application lose its `Volume`, and every layer built on it, whenever the tab that owns the volume closes or reloads. That is ordinary browser behavior, not a failure.

Core doesn't treat a takeover as terminal. Only descriptors and pending requests from the old owner are invalidated: "Ownership changes invalidate pending requests and descriptors from the old owner; uncertain mutations are never replayed automatically. Reopen files after takeover." ([docs/API.md:119](../../docs/API.md)). React follows that model. It keeps the volume and keys only its generation-scoped resources to `ownerGeneration` ([react/src/volume.tsx:377-378, 449-451](../../packages/react/src/volume.tsx)). Only SharedWorker attachment loss (`VFS_ATTACHMENT_LOST`) and a failed client are terminal.

**Recommendation:** split what survives a generation change from what doesn't.

| Survives a takeover | Invalidated by a takeover |
| --- | --- |
| `Volume` service, `FileSystem` service, `Subscriptions` service | Open `File` handles → `BadResource`, `outcome: "not-applied"` when refused before dispatch |
| Path operations, which the next call routes to the new owner | Commands in flight at the takeover → `outcome: "possibly-applied"` for mutations, never replayed |
| | Active subscriptions → `SUBSCRIPTION_INTERRUPTED`; the application resubscribes and reconciles, as today |

Terminal states (`VFS_ATTACHMENT_LOST`, client `failed`, `closed`) permanently fail the service, as the revision says. The rule "do not retry an entire workflow containing writes merely to recreate its layer" still applies to those.

Section 4's other concern stays valid: a path call that races a takeover has an uncertain outcome. That's already expressed per operation through `outcome`, so it doesn't justify killing the volume.

## 2. A takeover can surface credential failures late

The docs say: "Followers use the owner's already-open storage; their own options are validated when they become owner" ([docs/API.md:121](../../docs/API.md)). So a follower tab with a wrong secret mounts successfully. The revision covers that in section 8. What it doesn't cover: the wrong secret **later** fails when this tab takes over, possibly minutes into the session, from inside an ordinary filesystem call.

Specify what callers see:

- The takeover fails with the decoded `EncryptionError` (`CredentialsRejected`, `KeyDerivationFailed`, …). The client becomes terminally `failed`, so under point 1 this is a terminal state.
- Filesystem calls fail with `PlatformError` `Unknown`. `reason.cause` is a lifecycle `VolumeError` whose `cause` is the `EncryptionError`. `volume.sync` fails with the `EncryptionError` directly, since its `E` is already `MountError`.
- Recovery is the same as for any terminal state: release the scope and mount again with new credentials. Add one sentence and an example to section 8, because this is the only path where an unlock error shows up after the application believed the volume was open.

## 3. Whole-file operations: keep the generation-bound helpers as the baseline

Section 6 makes chunked descriptor I/O "the correctness baseline" for `readFile` and `writeFile`, and treats `readFileBuffer`/`writeFileBuffer` as an optional later fast path. On workers, this reverses the safety ordering:

- `readFileBuffer` and `writeFileBuffer` **are** in `GENERATION_METHODS`. Descriptor commands are not (see the summary). Until prerequisite 2 lands, the whole-file helpers are the only worker I/O with atomic generation protection. Making `readFile`/`writeFile` depend on descriptors turns prerequisite 2 into a blocker for the most common calls too.
- A chunked `writeFile` produces intermediate states that other tabs can observe: a truncated file, then partial contents. It is also many logical operations instead of one. `writeFileBuffer` finishes in one worker turn.
- `writeFileBuffer` supports `exclusive` and `append` ([opfs-vfs.ts:95-99](../../packages/opfs-vfs/src/opfs-vfs.ts)). That covers `w`, `wx` and `a` without descriptors.

The revision's objection is that the adapter must not retry `EFBIG` through another mutation path. That's correct for writes, but it doesn't force descriptors:

- **`readFile`:** the worker compares the size with the limit *before* reading and fails with `EFBIG` ([worker-runtime.ts:682-687](../../packages/opfs-vfs/src/worker-runtime.ts)). The failed read had no effect, so falling back to chunked reads is safe. Reads are not mutations.
- **`writeFile`:** check `data.byteLength` against the known limit **locally, before dispatch**. Use `writeFileBuffer` below the limit when the flag is `w`/`wx`/`a` and no `mode` is given. Otherwise use descriptors, with the same restrictions as `open`. There's never a retry, so the `EFBIG` concern doesn't arise.

Record which path each call takes, because atomicity and the number of change events differ between them. That should be counted as a documented behavior, not an implementation detail. Check in the contract suite what subscribers see for a chunked write compared with one `writeFileBuffer`.

## 4. Prerequisite 2 may be much smaller than it looks

Section 4 treats generation-bound descriptors as a large core change ("extend the public dispatch contract or prove an equivalent implementation"). The descriptor methods already dispatch through the same `sendToWorker` that the `forGeneration` facade redirects ([worker-client.ts:3168-3200](../../packages/opfs-vfs/src/worker-client.ts)). The facade applies the public method body to a context whose `sendToWorker` pins `ownerGeneration` ([worker-client.ts:3123-3150](../../packages/opfs-vfs/src/worker-client.ts)).

Before planning a new contract, spike the obvious version: add `open`, `read`, `write`, `seek`, `close`, `fstat`, `fsync` and `ftruncate` to `GENERATION_METHODS`, and test the three hazards the revision lists:

1. **Late `OPEN` result.** A generation-pinned `OPEN` is refused by any other owner, so no descriptor can come from the new owner. What still needs a test is an `OPEN` that the old owner answered after this client already saw the takeover: that descriptor must never be used.
2. **Descriptor reuse.** The numbers belong to one owner. A pinned `CLOSE` or `WRITE` sent to a successor is refused before it can touch a recycled number.
3. **Stale finalizers.** A `File` finalizer's `close` is pinned too, so it is refused after a takeover instead of closing someone else's descriptor. A refused close is the correct outcome, because the old owner released its descriptors when it went away.

If the spike passes these tests, prerequisite 2 becomes a list change plus tests, and full worker `File` support stops being the release blocker the revision describes. Keep the revision's wording as the fallback in case the spike fails.

## 5. Acquisition: write down the interruption pattern

Section 4 correctly rejects the first review's recipe and asks for "one documented approach". Here is a concrete candidate, so implementers don't have to design it:

```ts
const acquire = Effect.uninterruptibleMask((restore) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()                  // private acquisition scope (section 4)
    const pending = openOpfsVfsWorker(fileName, { ...options, signal: controller.signal })
    const client = yield* restore(Effect.promise(() => pending)).pipe(
      Effect.onInterrupt(() => Effect.sync(() => {
        controller.abort()
        // Late result: a client that resolves after interruption is still released.
        pending.then((c) => c.closeVfs().finally(() => c.dispose()), () => {})
      }))
    )
    yield* Scope.addFinalizer(scope, releaseClient(client)) // before any further await
    yield* restore(awaitReady(client))                // interruptible; release already registered
    return { client, scope }
  })
)
```

The pieces:

- **Discovery** (`openOpfsVfsWorker` in `auto`/`shared-worker` mode) is async *before* any client exists. It runs interruptibly, the signal cancels it, and a client that arrives late is released.
- **Registering release** happens while interruption is masked, so there is no window where a client exists without a finalizer.
- **`ready`** is awaited interruptibly, with release already registered. Core's close-during-initialization paths (`close-admission.test.ts`) then do the rest.
- **Direct mounts** construct `new OpfsVfs(...)` synchronously, so they need only the last two steps.

Add adapter tests for interruption inside each of the three windows (discovery, between construction and registration, and `ready`), plus late resolution after interruption.

## 6. Smaller points

- **Error class API in rc.118.** The published package exports `Schema.TaggedError` (and `Schema.Error`), not `Schema.TaggedErrorClass`. Schema classes have no static `is` ([Schema.ts](https://unpkg.com/effect@4.0.0-rc.118/src/Schema.ts), `makeClass` statics). `EncryptionError.is(cause)` in section 9 won't exist. Use `Schema.is(EncryptionError)` or export `isEncryptionError` built from it. Name `Schema.TaggedError` in section 5 so the pin and the code agree. `instanceof` also works, because the adapter constructs the decoded errors itself.
- **Profile interop with React.** Because the revision keeps plugins opt-in, an Effect tab that mounts `documents.bin` without `subscriptionsRequest()` has an empty profile. A React tab on the same volume always requests subscriptions. They get `VFS_PLUGIN_MISMATCH` against each other ([docs/API.md:119](../../docs/API.md)). The opt-in decision can stay, but document it where the defaults are described: "to share a volume with the React SDK, request subscriptions." Better still, name the default profile in one place that both SDKs cite.
- **List what counts as `TimedOut`.** Section 5 says "verified timeout" without naming codes. Suggested: `LEADER_RESPONSE_TIMEOUT` on an operation → `TimedOut`, with `outcome: "possibly-applied"` for mutations. `VFS_INITIALIZATION_TIMEOUT` happens only at mount and stays a lifecycle `VolumeError`.
- **Where the unlock example ends.** `unlockExisting` (section 8) returns a `VolumeService` in a scope, but nothing shows how that becomes the application's `FileSystem`. Add `Layer.effect(FileSystem.FileSystem, Effect.map(unlockExisting, OpfsFileSystem.make))`. Also note that this runs the credential prompt during layer construction, which is how an application built on `ManagedRuntime` will experience it.
- **The encrypted example's `plugins` thunk.** It reveals the secret inside the thunk, which is good. Also say that the adapter drops its reference to the options after acquisition, because the thunk keeps the `Redacted` alive for as long as the layer value exists. That's harmless, but readers of an encryption API ask about it.
- **Buffer transfer is real for writes.** `write` transfers and detaches a view that covers its whole `ArrayBuffer` ([worker-client.ts:3171-3182](../../packages/opfs-vfs/src/worker-client.ts)). `File.write`/`writeAll` and `writeFile` must copy such views before dispatch. The revision lists "buffer ownership", but name the exact condition so the test targets it.
- **Section 12's note on the first review's B2.** The first review didn't claim that the queue backpressures filesystem writers. It said a slow consumer delays the `ack`. The rest of that row (retained memory scales with capacity × `maxBytes`, and `Queue.fail` drains before failing) is a real correction and should stay.

## 7. Things the revision got right that should not regress

- A private child scope for each `make`, so that a failed mount inside a long-lived parent scope doesn't leak a backend into it.
- `VFS_STORAGE_PLUGIN_REQUIRED` as an unsupported `VolumeError`, not an `EncryptionError`. The code identifies a missing storage provider, not a password problem.
- `SUBSCRIPTION_SETUP_FAILED` as a fallback, with the original code kept separately.
- The memory bound on captured content: `(capacity + 1) × maxBytes`.
- No wire field for `sidecar` until something needs it.
- A snapshot-only persistence API without an invented `failureRevision`.

## Evidence

| Claim | Source |
| --- | --- |
| Takeover invalidates descriptors and pending requests, not the client | `docs/API.md:119` |
| Follower options are validated when it becomes owner | `docs/API.md:121` |
| React keeps the volume and keys resources per generation | `packages/react/src/volume.tsx:377-378, 449-451` |
| Generation facade methods (no descriptor commands) | `packages/opfs-vfs/src/worker-client.ts:79-99` |
| Descriptor methods dispatch through `sendToWorker` | `worker-client.ts:3168-3200` |
| Facade pins `ownerGeneration` by replacing `sendToWorker` | `worker-client.ts:3123-3150` |
| `writeFileBuffer` options: `exclusive`, `expected`, `append` | `packages/opfs-vfs/src/opfs-vfs.ts:95-99` |
| Worker whole-file read fails with `EFBIG` before reading | `packages/opfs-vfs/src/worker-runtime.ts:682-687` |
| `SYNC` → `syncSync()`, `FLUSH` → `flushVfs()` (full snapshot) | `worker-runtime.ts:806-811`, `opfs-vfs.ts:3313, 3528-3542` |
| Close-before-ready coverage exists | `packages/opfs-vfs/src/__tests__/close-admission.test.ts:108-439` |
| React always adds a subscriptions request | `packages/react/src/volume.tsx:278-290` |
| `write` transfers whole-buffer views | `worker-client.ts:3171-3182` |
| rc.118 exports `Schema.TaggedError`; schema classes have no static `is` | `effect@4.0.0-rc.118/src/Schema.ts` (`TaggedError`, `makeClass`) |
| `Layer.effect` accepts both `(tag, effect)` and `(tag)(effect)` | `effect@4.0.0-rc.118/src/Layer.ts:1345-1430` |

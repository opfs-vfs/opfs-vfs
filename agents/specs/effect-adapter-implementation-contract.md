# Effect v4 adapter: implementation contract

Date: 2026-09-29

Status: proposed design only. Core baseline `a5b5084f90ea375b62a70ee4d74552093c648c2a`; Effect target `4.0.0-rc.118`.

The [API spec](./effect-adapter-api.md) defines public exports, error types, guarantees and usage. This companion defines the algorithms and acceptance tests that enforce those guarantees. Implementers need both documents; implementation mechanics are authoritative here and are not duplicated in the API spec. Neither document authorizes implementation.

## Persistence continuity

Guard adapter liveness before all operations: direct `syncSync()` silently returns after closure and is not sufficient protection by itself.

A successful `volume.sync` must not imply that G2 persisted writes accepted by G1. Balanced flushing and owner-exit hooks do not prove that G1 completed a save. Track mutations made through this `Volume` and all filesystem projections/handles built from it. Raw backend calls and other independently mounted services/tabs are outside this bookkeeping.

Keep private state `clean`, `pending(generation)`, or `continuity-lost(oldestGeneration)`. The pending generation identifies the oldest unresolved barrier obligation, whether created by a mutation or explicit acknowledgment, not merely the most recent writer. Later writes on G2 must not replace an unresolved G1 marker. Use one private serialization gate for mutating backend commands and explicit sync/fsync barriers and acknowledgment. Reads and subscriptions do not take this gate; compound methods acquire it per backend command, not recursively. Per-handle cursor locking is outside this gate. This serializes this adapter's mutation RPCs; a concurrent high-water-mark design is deferred until throughput measurements justify the extra state.

Record a tentative pending generation before invoking a mutating command, under the gate, so interruption cannot lose tracking. A known local refusal restores the previous state; success, sent/replied errors and unclassified interruption retain the conservative pending marker. After dispatch, keep ownership until the Promise settles even if the caller is interrupted; cancellation must not let a barrier overtake an unresolved local dispatch. Include create/truncate opens, file writes/truncates and explicit namespace/metadata changes, including changes made by copy, temp and cleanup helpers. Read-side access-time updates do not establish a cross-generation receipt. A call waiting for the gate has not dispatched that command. Gate waiting is interruptible, has no adapter deadline and consumes no readiness budget. Caller cancellation removes only that waiter; it cannot cancel or release the current holder. For a compound operation, earlier commands may already have applied.

| State when `volume.sync` acquires the gate | Behavior |
| --- | --- |
| `clean` | After admission and under-gate revalidation, issue one pinned SYNC on that generation. No recapture. Success covers this barrier, not historical writes through a previous mount or other clients. |
| `pending(G1)` | Admit outside the gate, then revalidate under it. Only issue SYNC if the ready generation is G1. A validated successful G1 reply clears the marker; do not reject that receipt solely because status changes after the successful barrier. |
| `pending(G1)` with a confirmed different owner, or a generation-refused SYNC after capture | Latch `continuity-lost(G1)` and fail with persistence `VolumeError`, code `VFS_SYNC_OWNER_CHANGED`, `outcome: "unknown"`. Never redirect the barrier to G2. |
| `continuity-lost(G1)` | Keep failing with `VFS_SYNC_OWNER_CHANGED`, even after later G2 mutations or persistence snapshots report ready. Only explicit application acknowledgment can adopt a new baseline in place. |

A mutation dispatched on G2 while `pending(G1)` also latches continuity loss. The service can still read and perform deliberate writes, but cannot issue an all-clear save receipt. A same-generation sync failure leaves the pending state intact. Admission timeout while writes are pending reports uncertainty about their durability; it does not clear tracking or imply rollback. Terminal lifecycle/crypto errors remain visible, including a direct `EncryptionError` for failed takeover authentication; they never clear pending continuity state. A successful barrier does not establish whether an earlier failed/uncertain mutation actually applied: callers must still reconcile that operation's outcome.

The error message for `VFS_SYNC_OWNER_CHANGED` says that writes accepted by one or more previous owners may not be durable. The application pauses save reporting, rereads current state and compares it with the intended edits. It may then run `acknowledgeOwnerChange` to adopt the current owner without closing the volume, handles or subscriptions. The acknowledgment records the application's acceptance of previous-owner uncertainty; it does not verify the comparison, recover data, flush storage or declare the edits saved. Never invoke it automatically in an error handler. Keep unresolved edits and warnings in application state.

Acknowledgment uses normal admission, then the same mutation gate and ready-generation revalidation, without recapture. If the owner changes between admission and the under-gate commit, fail with persistence `VolumeError`, code `VFS_ACK_OWNER_CHANGED`, outcome `"not-applied"`, and leave all tracking unchanged. Closed/failed mounts fail with lifecycle `VolumeError`, retaining any decoded terminal cause. Readiness timeout and interruption while queued also leave tracking unchanged. The final local state update is synchronous and interruption-masked.

On a live owner G, acknowledgment replaces `continuity-lost` or an obsolete `pending(old)` with `pending(G)` unconditionally, even if this service made no G mutations. This pins the required post-reconciliation barrier to G: a G→H takeover before sync must report `VFS_SYNC_OWNER_CHANGED` rather than sync H and report saved. Existing G mutations remain covered by that pending state. A same-owner `pending(G)` stays pending; a clean/direct mount with no unresolved loss is a live no-op. A successful current-owner `File.sync` never clears an older continuity-loss marker; acknowledgment still requires a fresh barrier on the acknowledged owner. Acknowledgment accepts uncertainty from all earlier owners, including intermediate takeovers, rather than certifying survival of a particular old write. It captures its owner at ready admission when the Effect runs; it cannot detect a change between an earlier application scan and invocation. Applications must explicitly accept that reconciliation risk or coordinate their own verification; this API does not claim atomic scan-and-acknowledge semantics.

A successful `File.sync` is pinned to its handle generation. Current core `fsyncSync(fd)` calls volume-wide `syncSync`, so it may clear `pending` for that same generation under the shared gate. It never clears continuity loss from another generation; stale handles fail `BadResource`. Background flushes, status snapshots and merely closing a file do not clear the adapter's marker. Direct mounts use the same command/barrier ordering but have no takeover. Applications must await completion of the mutating workflow before saving; a barrier interleaved with a multi-command workflow does not cover that workflow's later commands.

Balanced mode remains the default. Without explicit `volume.sync` or a qualifying same-owner `File.sync` at save boundaries, a mutation can remain pending even after a background flush. The next takeover then causes `VFS_SYNC_OWNER_CHANGED` on a later sync until the application reconciles and acknowledges. This conservative result is intentional because persistence snapshots do not identify which mutations were flushed.

Core follow-ups: an equivalent caller-local continuity check for raw `sync()`, and an owner-reported durable watermark per generation identifying the highest ordered command sequence covered by a completed local sync. The latter could let adapters recognize background durability without false alarms. It needs an ordering contract covering owner-local and relayed commands, mutation replies and flush completion; current persistence frames are not a substitute. Neither change is required for v1.

`persistence` is a snapshot, not a stream. Direct state comes from `getLocalPersistenceStatusSync()`; worker state comes from `getStatus().persistence`. Missing worker persistence maps to `unknown`. Expose `error` only when the current state is `error`, normalized to bounded details; otherwise it is `null`. Do not expose a fabricated common failure revision: direct public status has none and clears old errors, while worker status retains a history marker. A closed or terminally failed adapter fails with a lifecycle `VolumeError`.

## Acquisition, shutdown and owner changes

Each `make` obtains the parent with `Effect.scope` and creates its acquisition/backend scope with `Scope.fork(parent, "sequential")`. The parent owns it immediately; closing the child detaches it. Failed acquisition closes the child before returning the failure. Successful acquisition needs no scope-transfer step. This matters when callers catch a failed mount and immediately try another inside the same parent scope.

The acquisition sequence is:

1. Evaluate configuration and fresh plugin thunks; validate options.
2. Acquire/create the backend under resource protection. Register orderly release as soon as the backend object is owned.
3. Await `ready` interruptibly, with cleanup already registered.
4. Record the active profile and install lifecycle observation for a worker-backed service; expose the service only after readiness. Owner generation is captured per operation/resource, not for the lifetime of the service.
5. On acquisition failure/interruption, close the private acquisition scope, preserve any cleanup failure and account for a late-created backend.

Use `Effect.uninterruptibleMask(restore => ...)` for ownership transitions and fork the child inside the mask. Provide the child as the acquisition body's `Scope`, including configuration resources. The selected interruption algorithm is:

1. Register a child finalizer that marks acquisition closed, aborts pending discovery and joins its settlement/late cleanup. Parent closure and fiber interruption must use the same idempotent cleanup path; concurrent calls join the same release result rather than closing a late client twice. Evaluate user configuration interruptibly. Inside the mask, create an `AbortController` and start worker discovery lazily through a typed boundary. Keep its Promise and install cancellation handling before awaiting it. Do not start discovery if the child has already closed.
2. Await discovery with `restore(Effect.tryPromise(...))`; decode rejection to `MountError`. Its `Effect.onInterrupt` handler aborts discovery and then joins the original Promise under the cleanup mask. If that Promise resolves late, close/dispose that client exactly once before interruption completes. An expected rejected discovery needs no backend release. A failed late close remains a decoded defect in the final `Cause`. Do not detach a `pending.then(...)` chain whose cleanup rejection would be unobserved.
3. Once discovery returns, still under the outer mask, register release with `Scope.addFinalizer(child, releaseClient(client))` before another interruptible boundary. Synchronous direct construction uses `Effect.try`, then the same masked registration.
4. Await `ready` through `restore(Effect.tryPromise(...))`. Wrap the acquisition body in `Effect.onExit`: on failure/interruption, `Scope.close(child, exit)`; on success, no transfer is needed. Backend release marks the service closed before its first asynchronous step. Check acquisition/service liveness after registering release, after readiness and before returning the service. A closed scope produces a lifecycle `VolumeError`, not a successfully acquired service. Registering a finalizer on an already closed scope runs it immediately; it must not lead to returning a released backend. Backend release and nested handle/subscription cleanup must remain ordered.

`Scope.fork` links cleanup; it does not by itself interrupt an arbitrary fiber running acquisition. The explicit close/abort guard handles concurrent parent closure. Normal callers keep acquisition within the parent's lifetime. Tests must also close the parent during discovery, between construction/registration and during readiness, verifying late cleanup and that no usable service escapes.

This algorithm deliberately waits for aborted discovery to settle so late cleanup failures remain observable. Verify that every core discovery path settles on abort or its configured timeout, including injected worker factories; do not claim instantaneous cancellation. Adapter tests must cover discovery interruption, the construction/registration boundary, interruption during `ready`, late success/rejection and cleanup failure. If a path can remain pending indefinitely after abort, fix that path before shipping this contract.

Effect rc.118 `acquireRelease` masks acquisition by default. Passing its `tryPromise` callback an AbortSignal alone does not make acquisition interruptible. `Effect.promise` turns rejection into a defect; use `tryPromise` at fallible typed boundaries. Joined late cleanup and child-scope failure cleanup are part of the contract.

Orderly release calls `closeVfs()`. The worker implementation already disposes resources in its `finally`; adapter fallback disposal may be used idempotently if a construction path needs it. Release child subscriptions and handles before the backend. Never replace a local attachment close with global shared-owner shutdown.

Finalizers cannot add ordinary typed errors to `E`. A failed close becomes an inspectable failure in `Cause`, using `Die` with the decoded `MountError` value where necessary. Preserve both use/acquisition and cleanup failures. Do not discard cleanup failures simply because `ready` never succeeded. Continue other cleanup after one release fails. No explicit checked-shutdown API is proposed for v1; `sync` is the typed save boundary and `Exit` reports finalization failures.

### Owner changes and delivery uncertainty

Ordinary dedicated-worker takeover keeps `Volume`, `FileSystem` and `Subscriptions` alive. Each new path operation captures the currently ready owner generation and dispatches through its `forGeneration()` facade. A multi-command operation, such as a chunked copy, holds that generation throughout. Multi-command work fails if its generation changes; it never switches owners halfway through. Single-command admission follows the bounded rules below. Temporary routing loss does not by itself establish terminal failure.

| Resource/work | On owner replacement |
| --- | --- |
| Services and future path operations | Survive; new calls use the new ready owner. |
| Open `File` handles | Remain pinned to their original owner and fail `BadResource` after replacement. Reopen explicitly. |
| Pending commands | Fail with dispatch evidence; a sent mutation may have applied. Never replay automatically. |
| Active subscriptions | End with `SUBSCRIPTION_INTERRUPTED`; retire, resubscribe and reconcile. The service can create a new subscription. |

Client `failed`/`closed` states and terminal SharedWorker attachment loss permanently invalidate the service. Recovery closes the old scope/runtime and mounts again. `VFS_ATTACHMENT_LOST` alone is insufficient evidence: core also uses that code when invalidating ordinary dedicated-worker routing. Consult client state and transport. Do not retry an entire workflow containing writes merely to recreate its layer.

Latch the terminal status error before closure can replace it. Check `getStatus()` at operation boundaries as well as listening for changes, since status notifications are coalesced. A failed takeover's INIT error is available through `getStatus().error`, while later raw calls may only report shutdown. Preserve the initiating command's dispatch evidence separately: terminal authentication failure does not prove that a preceding mutation was unapplied.

### Admission during takeover

For worker path operations and eligible `volume.sync` calls under the continuity rules in [persistence continuity](#persistence-continuity), wait interruptibly for `getStatus()` to report `ready` with a non-null `ownerGeneration`. Subscribe to status changes before reading the snapshot, then recheck in the callback to avoid a lost wakeup. Remove the listener and timer on every exit. `opening`/`recovering` wait; `closing`/`failed`/`closed` fail immediately with the lifecycle mapping in [platform error mapping](./effect-adapter-api.md#platform-error-mapping). Use the same admission wait before starting a subscription; convert admission errors to `SubscriptionError` with code `SUBSCRIPTION_SETUP_FAILED` and preserve the original `sourceCode`/decoded cause. Standard watch preserves the underlying platform mapping, including `TimedOut` for admission expiry. Existing file handles never wait for or move to a new generation.

Bound cumulative ready-owner waiting per call with the effective `initTimeout` option, 15 seconds by default, measured with Effect's clock. Preserve the remaining budget across any permitted recapture; time spent waiting for the mutation gate or executing a backend command is excluded. Subscription retirement waiting shares this budget as specified below. This is an adapter readiness budget: core's `ready` Promise settles once at initial mount and is not reset for takeover. Core may reject unpinned calls with `VFS_LEADER_NOT_READY`; awaiting that old Promise is insufficient. Do not reset the budget on status changes or recapture. Expiry fails with adapter code `VFS_OWNER_READY_TIMEOUT`, lifecycle `VolumeError`, and `outcome: "not-applied"` because nothing was dispatched. For `sync` with pending earlier writes, use `outcome: "unknown"` to preserve uncertainty about their durability. Filesystem projection uses `TimedOut`. Expiry affects the call, not the still-recovering volume. Caller interruption remains interruption.

For mutation commands, barriers and acknowledgment, the ordering is mandatory:

1. Wait for ready admission and capture the generation without holding the mutation gate.
2. Acquire the gate interruptibly, without an adapter deadline or readiness timer running. Remove canceled waiters. Wake queued calls on adapter closure or terminal failure and return the lifecycle failure without dispatch. Callers can use `Effect.timeout` to bound their wait; it interrupts the waiting operation and exposes Effect's `TimeoutError`, not an adapter outcome classification. A compound operation may already have completed earlier commands.
3. Re-read liveness, readiness and generation under the gate. A pinned compound operation/descriptor also retains its original generation. Never wait for an owner while holding the gate.
4. If readiness/generation no longer matches, release the gate before any renewed admission. Eligible single-command operations may spend their one recapture allowance; sync, acknowledgment and compound work fail without redirecting. Use `VFS_SYNC_OWNER_CHANGED` for sync with pending writes and confirmed loss, `VFS_ACK_OWNER_CHANGED` for acknowledgment, and the appropriate lifecycle/refusal mapping otherwise. Mere temporary recovering state without a confirmed replacement does not latch continuity loss.
5. Once revalidated, update tentative mutation tracking and invoke the pinned backend command. Hold the gate until that command settles, restore tracking only for proven local refusal, then release. Acknowledgment instead performs its local state transition. No await may be inserted between the final local validation and tentative tracking/dispatch, though the backend still performs its own atomic generation checks.

The same single recapture allowance covers a generation change observed under the gate or a subsequent facade refusal; these are not two separate budgets. If ready status disappears and returns with the same generation, one new admission is allowed for an eligible single command after this local, proven pre-dispatch refusal. Once any command of a compound operation reached the backend, no later local refusal authorizes restarting that compound operation; report its aggregate uncertainty.

### Gate-holder failures

A caller-imposed timeout or interruption of a waiter does not cancel or release the holder. The holder keeps ownership through interruption until the underlying Promise settles; mutation outcomes and pending continuity remain conservative. Core already bounds leader-to-worker `requestWorker` calls: 30 seconds normally, 300 seconds for SYNC/FSYNC/FLUSH/CLOSE_VFS/LIST_PATHS, and `initTimeout` for INIT. Expiry invokes `failWorker`, publishes terminal `VFS_WORKER_FAILED`, rejects pending requests and terminates the worker. Worker `error`/`messageerror` paths also call `failWorker`. Follower relay timeouts produce `LEADER_RESPONSE_TIMEOUT`. Verify both paths at the adapter boundary; an admission timeout is not an in-flight deadline.

These timers require the hosting event loop to run. A suspended tab may deliver them late, and synchronous direct calls cannot be preempted. If an injected endpoint violates core's settlement contract, keep the gate held rather than dispatching over an uncertain holder; subsequent waiters remain interruptible and can use caller-imposed timeouts; closure or terminal failure wakes them without dispatch. This is an observable broken backend, not permission to retry a mutation. Tests must cover hung responses, worker crashes, late responses after timeout, interrupted holders and waiter cleanup.

After admission, a single-command operation may recapture and dispatch at most once more only when all of these hold:

- Either under-gate revalidation proves that no dispatch happened, or the pinned facade reports `dispatch: "refused"` with `VFS_ATTACHMENT_LOST`; live status must still be nonterminal on dedicated transport.
- The operation contains no earlier command or mutation; local validation succeeded. Wait for ready admission again using the remaining readiness budget; a facade-reported generation mismatch requires a different generation, while a local readiness-only refusal may recover on the same one.
- The adapter has not already used this one recapture allowance. Reuse the original inputs and preserve caller buffers.

A refusal after the second capture is returned as a typed failure with `outcome: "not-applied"`. Validation/configuration failures, closed clients, arbitrary same-generation backend failures and exceptions are not recapture signals. Anything `sent` or `replied` is never dispatched again, even if a remote reply says the owner refused it. In-flight command timeouts remain core's own timeouts; the readiness budget never cancels an already-dispatched mutation. If the budget is exhausted when a local refusal occurs, return that refusal rather than restarting the budget.

Whole-file helpers and a single rename/stat/etc. qualify. `volume.sync` and `acknowledgeOwnerChange` never use recapture, even when the pending-mutation state is clean; their continuity contract is defined in [persistence continuity](#persistence-continuity). Multi-command `copy`, traversal, temp creation, chunked reads/writes, descriptor operations and subscription setup do not. They use one generation throughout and require explicit caller recovery on change. This allowance resubmits a locally refused command, never a dispatched mutation or a workflow.

Generation-bound path commands already exist. Descriptor commands need the same atomic dispatch protection; checking a status snapshot before an asynchronous call is insufficient.

> Required core verification/change: `forGeneration()` currently omits `open`, `read`, `write`, `seek`, `close`, `fstat`, `fsync` and `ftruncate`. First spike adding these methods to `GENERATION_METHODS`: their public bodies already use the redirected `sendToWorker`. Test late OPEN results, descriptor-number reuse, stale finalizers and dispatch evidence on both leader and follower paths. Reject an OPEN result if its generation became stale before delivery; any cleanup must target only that original generation. A stale CLOSE must never touch a successor's descriptor. Pinned dispatch skips some existing unbound-descriptor bookkeeping, so a list change is a hypothesis to verify, not proof. If it fails, extend the dispatch contract only as needed. Full worker-backed `File` support remains gated on these tests, without presuming a large core redesign.

Use `outcome: "not-applied"` only for a validated refusal before dispatch, `"possibly-applied"` for a sent mutation with no validated outcome, and `"unknown"` otherwise. A replied error can follow a partial mutation. Preserve dispatch evidence where available; do not synthesize it for uninstrumented commands. Effect interruption stays interruption in `Cause`, not a magically catchable typed error; it cannot prove rollback of an already-dispatched mutation.

Core already has close-before-ready coverage in `close-admission.test.ts`, including held INIT, pre-INIT PING, late CLOSE failure and follower readiness. Add adapter-level acquisition/interruption tests and extend core only for demonstrated gaps; do not create a redundant suite on the premise that these tests are absent.

## Error classification prerequisites

Export schema-backed tagged `VolumeError`, `EncryptionError` and `SubscriptionError` from the base adapter using rc.118 `Schema.TaggedError<Self>()("Tag", fields)`. This release exports `Schema.TaggedError`, not `Schema.TaggedErrorClass`. Derive guards with `Schema.is(ErrorClass)`; schema classes do not receive a static `.is` method. Decode known external codes without importing premium code. One internal classifier serves direct and worker operations; filesystem wrapping is a final projection of that classifier.

Reuse React's `kind`/`outcome` vocabulary and bounded error sanitization. A common dependency-free classifier can be extracted when implementing both consumers; this spec does not require a broad React rewrite.

Premium source was checked against `origin/main` at `fbda9c54fc87b601334eba6198722b1a4f1fcd01`. Relevant files in the available checkout match that revision. These mappings require the following corrections before the documented precision can ship:

| Source signal | Target meaning | Required correction or qualification |
| --- | --- | --- |
| `EVOLUMELOCKED` after no key slot accepts the secret | `CredentialsRejected` | Currently reused for missing vault and zero slots. Reclassify those two sites first. Even then, a rejected secret and damaged authenticated slot cannot be distinguished; document that ambiguity. |
| `EKDF` | `KeyDerivationFailed` | Verified. Some derivation failed and no slot ultimately unlocked; do not promise that no other slot tested the secret. This is not evidence for asking for a different password. |
| `EVAULTCORRUPT` | `VaultCorrupt` | Use for malformed/missing vault, zero slots and bad magic. |
| Uncoded unsupported vault version/cipher | `UnsupportedFormat` | Add a distinct code, proposed `EVAULTFORMAT`. An unrecognized field may also be corruption; it is not proof of a newer producer. |
| `ECRYPTSIDECAR` | `SidecarCorrupt` | Verified structural sidecar failure. |
| `ECRYPTOINTEGRITY` | `IntegrityFailure` | Verified authenticated data/record failures, including after mount. Reclassify cipher use-after-close first. |
| Uncoded encryption request for existing plaintext storage | `PlaintextVolume` | Add a code, proposed `EPLAINTEXTVOLUME`. Mounting with encryption is not migration. |
| Destroyed cipher used for open or seal | Lifecycle `VolumeError`, `EBADF` | Current open paths use integrity errors and seal paths throw uncoded errors. Fix both JS/WASM open and seal guards. |
| Core protection marker without declared provider | Unsupported `VolumeError` | Add `VFS_STORAGE_PLUGIN_REQUIRED`; current core uses generic `EINVAL`. |

These are prerequisite changes in core/premium, not edits made by this task. Do not map today's overloaded `EVOLUMELOCKED` to definite credential rejection, or identify missing-provider `EINVAL` by matching its message. Pin/test corrected provider versions. If older/unknown producers are admitted, their unclassified failures remain `VolumeError` with bounded details instead of guessed reasons.

The current worker error wire accepts only message/name/code/errno/category/offset. Adding a `sidecar` field as suggested by the review would require a protocol-compatible serialization/validation change. The minimal prerequisite is a dedicated code; omit the extra wire field until needed.

Drop `CredentialsRequired` as a plugin error: the current factory validates a supplied, nonempty secret. Credential collection is application policy. Also avoid a generic `Ambiguous` reason; document the particular ambiguity of key-slot authentication under `CredentialsRejected`.

## Filesystem routing and conformance

`make` is pure construction of lazy operations. `FileSystem.make` derives exactly `exists`, `readFileString`, `writeFileString`, `stream` and `sink`. Implement the remaining methods, or return the documented unsupported error. Reuse upstream derivation instead of `makeNoop` stubs.

- Worker `readFile` first uses generation-bound `readFileBuffer` at its 16 MiB limit. A validated `EFBIG` response from that read can select chunked descriptor reads pinned to the same generation: the worker checks size before reading file contents. Do not retry transport or integrity failures. Direct core has no `readFileBufferSync`; use its descriptor reads. A chunked read is not a snapshot of concurrent writes.
- For `writeFile`, select the route before dispatch. At up to 16 MiB input, no explicit `mode`, and flag `w`/`wx`/`ax` (default `w`), use `writeFileBuffer` in the worker or `writeFileBufferSync` directly. Map exclusive and append options independently. Other supported flags, including ordinary `a`, explicit modes and larger input use descriptors. Validate flags and modes before mutating.
- Append's final file size is also limited by the whole-file helper. Input length alone cannot prove that ordinary `a` fits, so select native `O_APPEND` descriptor writes upfront for that flag. `ax` can use the helper because exclusive creation either creates a new file or fails. Do not use a racy pre-stat or fall back after a failed write. This qualifies the review's proposed helper use for `a` and preserves large-file append under the standard interface. Configured file/quota limits still apply.
- A successful whole-file helper finishes in one owner turn and core groups its logical change records. Descriptor writes span turns: truncation and partial contents may be visible, and multiple operations may produce multiple notifications. Document this size/options-dependent behavior and test it. Neither route promises rollback or durable commit on failure; one owner turn is not a storage transaction.

Never retry a failed mutation through a different path. Chunked fallback depends on the descriptor prerequisite above; using helpers does not remove the release gate for full `FileSystem` conformance. Whole-file methods still allocate the full result; `stream`/`sink` are the bounded-memory alternatives.

Worker `write` transfers and detaches data when `byteOffset === 0` and `byteLength === data.buffer.byteLength` on an `ArrayBuffer`-backed view. The adapter must copy caller-owned inputs before any descriptor dispatch that could transfer them, including `File.write`, `writeAll` and chunked `writeFile`. Use `Uint8Array.from`, not `Buffer.slice`, which may alias. Subarray and SharedArrayBuffer views are copied by core. `writeFileBuffer` already copies, so reuse that protection rather than copying twice. Verify contents and attachment of original buffers after every write route.

`File` in rc.118 has no public `fd`; `seek` uses `bigint`, and `File.Info.size` is `ByteSize`. Maintain one serialized adapter cursor per handle. Use explicit offsets for reads/non-append writes; append writes retain native `O_APPEND` behavior so the owner selects EOF inside the write operation. Do not implement append as `fstat().size` followed by write: a per-handle semaphore cannot protect against other handles, clients or tabs. Append writes do not move the adapter's read cursor. Match upstream truncate/cursor rules, detect short/zero writes, and reject unsafe conversions.

### Watch semantics

Check the watched path at stream acquisition. A missing path fails `NotFound`; successful preflight is not an atomic guarantee that it still exists at registration. Watch regular files/directories and emit absolute normalized volume paths. Rich subscriptions retain the core ability to subscribe to a missing future path.

Map create/update/delete to Create/Update/Remove. Core already emits descendant delete/create records for directory renames; do not synthesize a second expansion. Symlink entries observed under a directory map the same way, with their kind omitted in the standard event. Do not claim Node-equivalent watching through symlink targets: core rejects traversal through ancestor symlinks. Reject a standard watch whose target is itself a symlink in v1; richer file subscriptions may observe that directory entry under core rules.

When a takeover interrupts standard `watch`, fail the stream with `PlatformError` reason `Unknown` and the decoded `SubscriptionError(SUBSCRIPTION_INTERRUPTED)` in `reason.cause`. Do not silently resubscribe: records between registrations are unavailable. A caller can use a bounded `Stream.retry` schedule to resume notifications, but must invalidate its cached view and reconcile after recovery. [API §9](./effect-adapter-api.md#recovering-a-watched-view) shows the registration-aware reconciliation pattern. The standard FileSystem interface has no watch-ready signal, so `Stream.retry` followed by a rescan does not itself prove subscribe-before-scan ordering; an indefinitely running stream never reaches a subsequent rescan.

A large mutation can overflow a bounded owner subscription. These are logical notifications, not durable commit receipts. Node watcher ordering/counts and relative path names are not identical; document those differences rather than treating exact event sequence equality as a portable guarantee. `WatchBackend` override support is deferred until a concrete OPFS use case requires it.

## Subscription delivery and retirement

### Queue and acknowledgment behavior

Use a bounded suspending queue with a small fixed capacity, initially 16 events. The source awaits the listener before acknowledgment, so await the queue offer in the listener. Never spawn an unlimited set of offers. This backpressures delivery/acknowledgment; it does not slow unrelated filesystem writers. Existing owner bounds decide overflow. No second adapter overflow algorithm is needed.

Capacity also bounds retained data, not just latency. Included content is copied and capped per event; with 16 queued events and one pending offer, retained payload can approach `17 * maxBytes`, in addition to source buffers. Default `content: false`. Document the bound before tuning queue capacity.

Unsubscribe before ending/shutting down the queue so rejecting a pending offer does not become a spurious active-listener failure. Propagate `onError` through a typed terminal signal even while the data queue is full. rc.118 queue failure can drain queued/pending data before presenting its error, so do not assume calling `Queue.fail` discards buffered records immediately. Latch terminal state; prevent resync-invalid data from being used as a continuing current view, and wake blocked offers/consumers on exit. The implementation may race consumption with that terminal signal; consumers must always treat previously observed notifications as non-transactional.

### Lifetime and retirement

Ending, failing or interrupting `changes` unsubscribes immediately, including early completion via `Stream.take`. The enclosing scope performs the same idempotent cleanup as a backstop, including when the stream was never run. A second consumption is a programming defect, not replay. A child resource scope/finalizer can release this registration without closing the caller's whole scope.

`retired` completes with either confirmed `released` or explicit `unknown`; it never has an ordinary typed failure and awaiting it does not cancel an active subscription. Use a child scope to close an unused subscription before waiting for retirement. Allow the terminal result to be awaited after the subscription scope closes without touching the backend.

Scope finalization initiates unsubscribe and local cleanup but does not wait indefinitely for remote confirmation. Unknown retirement is a normal environmental outcome recorded in `retired`, not a defect. Report a sanitized warning once for unknown retirement; reading it must remain possible regardless of logging. No automatic resubscription. Before recovery, await the previous handle's retirement. `unknown` must remain truthful; do not relabel it `released` merely because an owner changed. Core specifically blocks unknown cleanup from failed setups, not every formerly active subscription.

The adapter therefore records uncertain retirement by owner generation for its mount. A new `subscribe` first waits for ready admission, then checks prior retiring registrations. If any earlier registration on that generation is still retiring, wait interruptibly for its `retired` result within the remaining shared budget; do not allocate the new registration yet. Ready waiting and retirement waiting share one budget. Recheck generation and the retirement records after waking and immediately before registration, so a concurrently started retirement cannot slip past the gate. Existing active subscriptions do not block independent registrations.

Expiry fails the new setup with `SubscriptionError`, code `SUBSCRIPTION_SETUP_FAILED`, sourceCode `VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT`; standard watch maps it to `TimedOut`. Remove waiters on timeout/interruption. Expiry does not change the old handle's eventual retirement result or mark the volume terminal; a later confirmed release can permit registration. A confirmed new owner generation lets the new setup ignore old-generation retirement records under the rules below.

Confirmed release permits reuse. Unknown retirement blocks registration on the same generation with `SUBSCRIPTION_RETIREMENT_UNKNOWN`; the application must stop/remount. A confirmed different owner generation permits a fresh registration, because old subscription IDs/channels cannot attach to that owner. This applies to rich subscriptions and `fs.watch` and does not install a plugin or remount the volume. Direct mounts have no owner-generation transition and must remount after unknown retirement. Keep this bookkeeping private and discard obsolete generation records. A normal takeover can now recover without treating uncertain old cleanup as proof of release.

Setup cancellation and late registration must also release resources. `fs.watch` wraps the same handle lifecycle, maps stream failures to `PlatformError` and records retirement internally before permitting a new registration; a canceled consumer cannot be promised a new catchable typed error after it has exited.

### Events and recovery

Keep kind, cursor and content/omission metadata in the rich interface. Notifications have no initial enumeration, replay or persistent history. Captured content is a historical operation version, not necessarily current state, and remains plaintext application data even with encrypted storage.

On overflow/interruption/resync failure, retire the old subscription, pass the retirement/generation gate above and rebuild the view with a fresh subscription plus serialized rereads/scanning. Subscribe-before-scan is necessary for that pattern but does not prove an atomic snapshot or transport barrier. Application fanout may use PubSub with an explicit slow-consumer policy. A shared queue would divide events among consumers rather than broadcast them.

## Acceptance tests and release gates

1. Land/test the bounded core and premium error-code corrections from [error classification prerequisites](#error-classification-prerequisites). Verify classification after worker serialization. Do not add a sidecar wire field without updating its validators/version compatibility.
2. Start with the `GENERATION_METHODS` list-extension spike and tests for late OPEN, descriptor reuse and stale close. Extend the contract further only if those tests expose a gap. Full worker-backed `File` support requires this verified behavior.
3. Verify the leader requestWorker timeout/crash rejection paths and follower relay timeout, with hung response, interrupted holder, caller-canceled waiter and late reply cases. Prove the [acquisition and admission](#acquisition-shutdown-and-owner-changes) interruption/ownership algorithm across configuration, discovery, construction/registration, readiness and parent-scope closure, including late resolution/rejection. Use existing core tests and add adapter-boundary cases. Preserve cleanup errors on failed mounts.
4. Test subscription registration readiness, full-queue terminal signaling, early stream completion, second consumption, unused-handle scope exit, unknown retirement and same-generation recovery. Include content memory bounds, takeover retirement marked unknown, the same-generation registration block, new-generation resubscription and scan ordering. Include still-pending retirement, timeout/interruption, late release, concurrent retirement at registration and one budget shared with ready admission.
5. Build a shared filesystem contract suite against pinned NodeFileSystem and direct/worker OPFS backends. Treat documented capability/path/watch differences explicitly rather than expecting identical OS watcher behavior. Include concurrent append, short writes, relative symlink targets, timestamps, helper selection and append final-size limits, large reads, metadata, buffer detachment and whole-file versus chunked notifications.
6. Verify plain/encrypted/both-plugin mounts, dynamic inspection paths and independent named volumes. Exercise recovering-without-generation, status/listener races, admission timeout/interruption, exactly one safe local recapture, second refusal, terminal loss and no replay after sent/replied. Verify multi-command work cannot switch generations. An existing shared owner must not make tests falsely claim per-tab credential validation. Test successful dedicated takeover with surviving services, stale handles/subscriptions and late credential failure with preserved status cause; separately test terminal SharedWorker loss and React profile mismatch. For persistence, test G1 write → takeover → sync failure; G1 write → G2 write → sync still failing; same-generation sync clearing; no pending writes permitting G2 sync; failed/interrupted writes and syncs retaining tracking; concurrent commands/barriers and File.sync sharing the gate. Cover a valid old-owner SYNC reply before a later status change, so a proven receipt is retained.
7. Verify admission → gate → ready-generation revalidation → tracking → dispatch; no owner wait holds the gate. Cover a single recapture budget shared by local revalidation and facade refusal, readiness expiry, and no sync/compound/acknowledgment redirect. Hold a healthy SYNC beyond `initTimeout` but within core's command timeout, then verify a queued write can proceed without an adapter timeout. Verify canceled waiters never dispatch, terminal closure wakes them, and gate waiting does not consume the remaining readiness budget on recapture. Verify explicit acknowledgment preserves current-owner pending writes, clears no terminal failure, leaves state unchanged on races/timeouts, and handles multiple intervening generations. Specifically test G1 loss → reconcile/acknowledge G2 without a G2 write → G3 takeover → sync failure; acknowledgment must not erase the pending G2 barrier.
8. Check `Volume.errorOf` for direct causes, one lifecycle wrapper, unknown/foreign causes and preserved originals. Verify long-lived session reuse and disposal before replacement.

The exact core/provider versions containing prerequisites remain to be selected. The API is still a review draft; these acceptance targets are not completed tests or permission to implement the prerequisites.

## Evidence and source references

Core references are relative to this file so the handoff travels with the repository:

- [First review](./effect-adapter-api-review.md)
- [Second review](./effect-adapter-api-review-2.md)
- [Third review](./effect-adapter-api-review-3.md)
- [Fourth review](./effect-adapter-api-review-4.md)
- [Fifth review](./effect-adapter-api-review-5.md)
- [Sixth review](./effect-adapter-api-review-6.md)
- [Core API, plugin ownership and follower authentication](../../docs/API.md)
- [Core README and premium request imports](../../packages/opfs-vfs/README.md)
- [Inspection](../../packages/opfs-vfs/src/peek-volume.ts)
- [Direct operations, append, limits, status and lifecycle](../../packages/opfs-vfs/src/opfs-vfs.ts)
- [Worker construction and transport selection](../../packages/opfs-vfs/src/index_internal.ts)
- [Worker generation facade and descriptor dispatch](../../packages/opfs-vfs/src/worker-client.ts)
- [Existing close-admission tests](../../packages/opfs-vfs/src/__tests__/close-admission.test.ts)
- [Plugin types](../../packages/opfs-vfs/src/plugins.ts)
- [Single-use plugin claims](../../packages/opfs-vfs/src/plugin-config.ts)
- [Worker error wire validation](../../packages/opfs-vfs/src/remote-error.ts)
- [React error classification](../../packages/react/src/errors.ts)
- [React subscriptions dependency](../../packages/react/package.json)
- [React worker registration](../../packages/react/src/vfs.worker.ts)
- [Subscriptions guarantees](../../packages/plugin-subscriptions/README.md)
- [Listener/ack, termination and setup-retirement implementation](../../packages/plugin-subscriptions/src/client.ts)
- [Subscription types](../../packages/plugin-subscriptions/src/types.ts)

Premium checked at immutable revision `fbda9c54fc87b601334eba6198722b1a4f1fcd01`, repository access required:

- [Error classes](https://github.com/opfs-vfs/opfs-vfs-premium/blob/fbda9c54fc87b601334eba6198722b1a4f1fcd01/packages/plugin-encryption/src/crypto/format.ts)
- [Key-slot authentication, KDF and vault parsing](https://github.com/opfs-vfs/opfs-vfs-premium/blob/fbda9c54fc87b601334eba6198722b1a4f1fcd01/packages/plugin-encryption/src/crypto/keyring.ts)
- [Encryption initialization, vault unlock and sidecar parsing](https://github.com/opfs-vfs/opfs-vfs-premium/blob/fbda9c54fc87b601334eba6198722b1a4f1fcd01/packages/plugin-encryption/src/crypto/index.ts)
- [Encrypted storage initialization](https://github.com/opfs-vfs/opfs-vfs-premium/blob/fbda9c54fc87b601334eba6198722b1a4f1fcd01/packages/plugin-encryption/src/encrypted-storage.ts)
- [Cipher lifecycle errors](https://github.com/opfs-vfs/opfs-vfs-premium/blob/fbda9c54fc87b601334eba6198722b1a4f1fcd01/packages/plugin-encryption/src/crypto/cipher.ts)
- [Request construction and create-new passkey requirement](https://github.com/opfs-vfs/opfs-vfs-premium/blob/fbda9c54fc87b601334eba6198722b1a4f1fcd01/packages/plugin-encryption/src/config.ts)

Effect rc.118 source was retrieved with the installed opensrc CLI using `opensrc path effect@4.0.0-rc.118`. Its package metadata reports `4.0.0-rc.118`. Local cache: `/Users/bastian/.opensrc/repos/github.com/Effect-TS/effect/4.0.0-rc.118/packages/effect`. `Schema.ts` exposes `is` at line 1401 and `TaggedError` at line 15148; `makeClass` statics at lines 14761–14826 contain no `.is`. `Scope.ts` exposes `fork`, `addFinalizer` and `close`; `Effect.ts` exposes `scope`, `uninterruptibleMask`, `onInterrupt`, `onExit` and `tryPromise` used by the acquisition algorithm. Public links below pin the same published release for reviewers without this cache:

- [Schema constructors, guards and class implementation](https://unpkg.com/effect@4.0.0-rc.118/src/Schema.ts)
- [Private scope creation, finalizers and closure](https://unpkg.com/effect@4.0.0-rc.118/src/Scope.ts)
- [Effect rc.118 package metadata](https://unpkg.com/effect@4.0.0-rc.118/package.json)
- [FileSystem interface and derived methods](https://unpkg.com/effect@4.0.0-rc.118/src/FileSystem.ts)
- [PlatformError](https://unpkg.com/effect@4.0.0-rc.118/src/PlatformError.ts)
- [Effect acquisition and finalization](https://unpkg.com/effect@4.0.0-rc.118/src/Effect.ts)
- [ManagedRuntime lifetime and disposal](https://unpkg.com/effect@4.0.0-rc.118/src/ManagedRuntime.ts)
- [Stream retry and scoped consumption](https://unpkg.com/effect@4.0.0-rc.118/src/Stream.ts)
- [Bounded schedules](https://unpkg.com/effect@4.0.0-rc.118/src/Schedule.ts)
- [Layer dependency direction](https://unpkg.com/effect@4.0.0-rc.118/src/Layer.ts)
- [Queue termination behavior](https://unpkg.com/effect@4.0.0-rc.118/src/Queue.ts)
- [NodeFileSystem implementation](https://unpkg.com/@effect/platform-node-shared@4.0.0-rc.118/src/NodeFileSystem.ts)
- [Node errno mapping](https://unpkg.com/@effect/platform-node-shared@4.0.0-rc.118/src/internal/utils.ts)
- [Node timestamp input units](https://nodejs.org/api/fs.html#fsutimespath-atime-mtime-callback)

Verification for this revision: an isolated TypeScript fixture compiled against `effect@4.0.0-rc.118` and ran successfully for tagged-error construction, `Schema.is` narrowing, rejection of raw wire-shaped objects by a class guard, layer dependency direction, forked-scope cleanup, long-lived ManagedRuntime reuse and the scoped reconciliation/retry idiom. The adapter and browser lifecycle behavior remain unimplemented; [acceptance tests](#acceptance-tests-and-release-gates) lists their required tests.

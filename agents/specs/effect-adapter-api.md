# Effect v4 adapter: API

Date: 2026-09-29

Proposed package: `@opfs-vfs/effect`

Core baseline: `a5b5084f90ea375b62a70ee4d74552093c648c2a`

Effect compatibility target: `effect@4.0.0-rc.118`

Status: API design, updated after six independent reviews; not an implementation authorization.

## Review brief and revision status

This document is complete for API review: public exports, user-visible guarantees and usage. The [companion contract](./effect-adapter-implementation-contract.md) defines implementation mechanics and validation, referring to the public types here. Review history is kept in [a separate record](./effect-adapter-api-review-history.md). Section 11 links implementation and validation gates before the milestone issue and final implementation plan.

All adapter exports and application examples below are proposed and are not compiled against an adapter implementation. The Effect constructor/guard and layer idioms have separate checks against rc.118; those checks do not validate the unimplemented adapter. Signatures use abbreviated `Effect<A, E, R>`, `Stream<A, E>`, `Layer<Out, E, In>` and `Scope` notation. Existing library exports are identified in the evidence section. Implementation details marked as prerequisites are required changes, not capabilities already present in core.

## 1. Design commitments

- One `OpfsFileSystem.layer` works with every plugin combination. `Volume` is its construction dependency. Standard filesystem calls retain the upstream interface and error type.
- A volume owns a scoped backend. Plugins are selected before mounting. A later service can expose a capability, but cannot install a plugin into an existing mount.
- Encryption and subscriptions can coexist. Encryption changes storage behavior; subscriptions add notifications.
- Ordinary plugin factories do not inherently require `yield*`. Effect supplies dependencies, typed failures and resource ownership.
- Mounts have one fixed error union. Actionable encryption errors remain directly catchable without a premium runtime import in the base adapter.
- Inspection guides the UI. Mounting validates the actual storage and profile. An existing unlocked owner does not authenticate each follower's credentials.
- Each named volume has its own lifetime. Applications choose which instance supplies the standard filesystem service to each workflow.

No credential UI, automatic retry of dispatched mutations, destructive recovery, global volume registry or new storage format is introduced.

## 2. Packages, capabilities and defaults

`@opfs-vfs/effect` peers on core, `@opfs-vfs/plugin-subscriptions` and the tested Effect version. Subscriptions are an ordinary source-available dependency, as in the React SDK. The premium plugin remains optional and separately installed. Pin Effect to rc.118 initially; expand the peer range only after checking another release. This pin is a compatibility target, not a claim about the newest release.

The adapter can directly import the subscription client and construct both `fs.watch` and the richer subscription service. No generic watch-bridge registry or `layerWithWatch` is needed. Honor the volume's validated active profile; do not look up an optional ambient subscription service per operation.

Ship a bundled worker registering the subscriptions factory. Keep requests explicit: omitted `plugins` and `plugins: []` select no plugin; adding `subscriptionsRequest()` enables notifications without requiring a custom worker. An encryption request needs an application worker registering encryption. Explicit SharedWorker use needs the corresponding compatible worker factory. Never silently fall back to plaintext when a requested plugin or worker is unavailable.

| Selected plugins | Storage | `fs.watch` |
| --- | --- | --- |
| None | Plaintext | Typed unsupported failure |
| Encryption | Encrypted | Typed unsupported failure |
| Subscriptions | Plaintext | Available |
| Both | Encrypted | Available |

Core permits one storage contribution and one logical-change contribution. Existing ownership and mount-profile compatibility rules remain authoritative. To share a volume with the React SDK, request `subscriptionsRequest()` and match its other options/plugins: React always adds subscriptions. An Effect mount with no plugins has a different profile and can fail with `VFS_PLUGIN_MISMATCH` against that React owner. Keep the explicit Effect default documented here; no shared default-profile abstraction is required.

## 3. Volume API and configuration

The proposed names `make`/`makeDirect` replace the previous draft's `open`/`openDirect`. Nothing has shipped under either name.

```ts
type MountError = VolumeError | EncryptionError
type Input<O, E, R> = O | Effect<O, E, R>

interface PersistenceSnapshot {
  readonly state: LocalPersistenceState | "unknown"
  // Current persistence error only; not a history or a durability receipt.
  readonly error: RemoteErrorDetails | null
}

interface VolumeService {
  readonly fileName: string
  readonly sync: Effect<void, MountError>
  readonly persistence: Effect<PersistenceSnapshot, VolumeError>
  readonly acknowledgeOwnerChange: Effect<void, VolumeError>
}

// Service tag: Volume.Volume
Volume.inspect(fileName: string): Effect<VolumePeek, VolumeError>
Volume.make<E = never, R = never>(input: Input<WorkerMountOptions, E, R>):
  Effect<VolumeService, MountError | E, Scope | R>
Volume.layer<E = never, R = never>(input: Input<WorkerMountOptions, E, R>):
  Layer<Volume, MountError | E, R>
Volume.makeDirect<E = never, R = never>(input: Input<DirectMountOptions, E, R>):
  Effect<VolumeService, MountError | E, Scope | R>
Volume.layerDirect<E = never, R = never>(input: Input<DirectMountOptions, E, R>):
  Layer<Volume, MountError | E, R>
Volume.unsafeBackend(volume: VolumeService): OpfsVfs | OpfsVfsWorkerClient
Volume.errorOf(error: PlatformError.PlatformError):
  VolumeError | EncryptionError | SubscriptionError | undefined
```

`Volume.layer` provides only `Volume`. `OpfsFileSystem.layer` remains the explicit filesystem projection. This keeps resource ownership separate from which services the application chooses to expose.

Worker options reuse the supported existing worker options plus `fileName`, with `plugins` accepting either a request array or a thunk returning a request array. Direct options reuse direct mount options plus `fileName`, but `plugins` accepts only a thunk returning fresh configured plugins. Both thunks execute once per acquisition inside a typed configuration boundary. Plugin capabilities and backend liveness are internal; they are not mutable public fields.

Accepting plain options makes simple use short. Accepting a configuration Effect allows credentials or other services to contribute `R` and their original typed `E`. A thrown exception from an adapter-invoked plugin thunk becomes `VolumeError` with `kind: "configuration"`. Typed failures from a supplied Effect remain unchanged. Defects inside arbitrary caller Effects remain defects.

Configured direct plugins and their factories are single-use, including failed attempts. The thunk must construct fresh objects, not return a previously mounted instance. Worker requests are reusable configuration snapshots; their factories execute in the worker.

### Persistence and raw backend access

`sync` calls direct `syncSync()` or worker `sync()` (`SYNC`). These are the checked data-and-metadata persistence barriers. It does not mean a full `FLUSH` snapshot/checkpoint. File-handle `sync` maps to the corresponding generation-pinned `fsync` operation. The continuity guarantee below qualifies both barriers. Close retains core's orderly flush behavior.

`sync` never reports durability for unresolved writes accepted by a previous owner; it fails with persistence `VolumeError`, code `VFS_SYNC_OWNER_CHANGED`, outcome `"unknown"`. Later writes cannot erase that uncertainty. Tracking covers this volume service's adapters/handles, not raw-backend calls or other mounts.

After rereading and deciding how to handle possible lost writes, the application can explicitly run `acknowledgeOwnerChange` without remounting. Acknowledging a loss pins a new pending save baseline to the admitted owner, even when this service has not written on that owner; it neither verifies old writes nor flushes storage. A following `sync` on that same owner is required before reporting saved, and another takeover before that barrier reports uncertainty again. The acknowledgment is not an atomic scan-and-ack operation: it accepts previous-owner uncertainty visible when invoked. It fails without changing the baseline if the admitted owner changes before the baseline update (`VFS_ACK_OWNER_CHANGED`), the mount is terminal, or admission times out. Never acknowledge automatically.

Balanced durability is the default. Without explicit sync/fsync at save boundaries, the next takeover after a write reports `VFS_SYNC_OWNER_CHANGED` on the next sync even if background flushing may have completed. Current persistence snapshots cannot prove which writes were flushed. [Continuity tracking and the proposed durable-watermark follow-up](./effect-adapter-implementation-contract.md#persistence-continuity) explain the conservative rule.

`persistence` returns a current snapshot, not a stream or a durability receipt. Unavailable state is `unknown`; `error` contains bounded details only while the state is `error`, otherwise it is `null`. Closed or terminally failed mounts fail with a lifecycle `VolumeError`.

`unsafeBackend` supports callers using another existing VFS adapter on the same mount. It is a borrowed backend: callers must not close/dispose it, reinitialize it, or retain it beyond the volume scope. Backend type and transport determine which other adapters can use it. Raw operations bypass this adapter's typed errors and guards; universal compatibility with every adapter is not promised.

## 4. Lifetime and owner changes

- Mounting is scoped: failure cleans up that attempt, and closing the owning scope releases handles/subscriptions before the backend.
- Cleanup failures remain in `Exit`/`Cause`; `sync` is the typed persistence barrier, not an explicit shutdown API.
- Ordinary dedicated-worker takeover preserves the services, invalidates old file handles and interrupts active subscriptions.
- Terminal failure or SharedWorker attachment loss requires a fresh mount; the error code alone does not identify a terminal state.
- Ready-owner waits share an `initTimeout` budget, 15 seconds by default. Mutation-queue waiting is interruptible, has no adapter deadline and does not consume that budget. Callers can use `Effect.timeout` to limit their wait.
- An eligible single-command path operation may recapture once only when local evidence proves it was never dispatched; sent/replied operations, sync, acknowledgment and compound work are never automatically replayed.
- `File` handles remain bound to their original owner; stale handles fail `BadResource`.

The [acquisition/admission contract](./effect-adapter-implementation-contract.md#acquisition-shutdown-and-owner-changes) specifies ordering, timeouts, late cleanup and the descriptor prerequisite.

## 5. Error API and decoding

Export schema-backed tagged `VolumeError`, `EncryptionError` and `SubscriptionError` from the base adapter. Derive guards with `Schema.is(ErrorClass)`. Known external codes are decoded without a premium runtime import.

```ts
type ErrorOutcome = "not-applied" | "possibly-applied" | "unknown"
type VolumeErrorKind =
  | "configuration" | "unsupported" | "filesystem" | "conflict"
  | "quota" | "corruption" | "encryption" | "lifecycle"
  | "subscription" | "persistence" | "unknown"

// Both operational error classes carry this context.
interface OperationErrorContext {
  readonly fileName: string | null // May be unknown before config resolves.
  readonly operation: string
  readonly path?: string
  readonly code?: string
  readonly outcome: ErrorOutcome
  readonly details: RemoteErrorDetails | null
  readonly cause?: unknown
}

// VolumeError: _tag = "VolumeError", kind: VolumeErrorKind + context
// EncryptionError: _tag = "EncryptionError", reason below + context
type EncryptionReason =
  | "CredentialsRejected" | "KeyDerivationFailed" | "VaultCorrupt"
  | "UnsupportedFormat" | "SidecarCorrupt" | "IntegrityFailure"
  | "PlaintextVolume"
```

Every mount exposes the fixed `MountError = VolumeError | EncryptionError`, plus caller configuration errors. No inferred plugin-error descriptors or caller-selected unchecked error generic. This is an ergonomic choice: runtime storage and owner behavior can differ from requested configuration. It does not mean missing generic storage capability must be called an encryption error.

Protected storage without its compatible provider remains `VolumeError`, `kind: "unsupported"`, with a proposed dedicated `VFS_STORAGE_PLUGIN_REQUIRED` code. Core supports storage plugins generally; the code alone does not identify a particular cipher/provider or establish that a password is the solution. The application may inspect protection markers and choose its supported encryption flow.

`inspect` returns `VolumeError` only, since it never opens crypto payloads. `sync` uses `MountError` because encryption can fail during later operations too. `persistence` is an observation of already-reported state and has lifecycle/accessor failures only. A recognized crypto read failure becomes a `PlatformError` with an `EncryptionError` cause. Terminal client failure uses a lifecycle `VolumeError` whose `cause` retains the decoded underlying error. For example, failed takeover authentication yields `PlatformError` with reason `Unknown`, a lifecycle `VolumeError` in `reason.cause`, and the decoded `EncryptionError` in that wrapper's `cause`. `sync` returns that encryption failure directly because its error type is already `MountError`; `persistence` retains its lifecycle `VolumeError` contract.

Preserve genuine source error information but never attach mount options, credential objects, raw request payloads or captured file contents to errors. A `Redacted` wrapper prevents accidental display while wrapped; revealing a secret for a request does not protect that request if it is later logged. Foreign error causes also require care and cannot be assumed secret-free merely because their messages are bounded.

### Accessing adapter errors

`Volume.errorOf(error)` is a pure, nonthrowing helper for a `PlatformError`. If `reason.cause` is a decoded adapter error, return it. If it is a lifecycle `VolumeError` whose immediate `cause` is a decoded `VolumeError`, `EncryptionError` or `SubscriptionError`, return that inner error instead. Otherwise return the outer decoded adapter error, or `undefined` for a foreign cause. Unwrap at most one lifecycle wrapper: do not recursively traverse arbitrary objects, decode raw worker payloads or mutate the original error. A foreign Node filesystem error normally returns `undefined`.

Keep the original `PlatformError` when reporting/rethrowing. It retains lifecycle and dispatch context; `errorOf` is for classifying the underlying problem, not deciding whether a mutation can be retried. `Schema.is` remains the guard API; no adapter-specific guard exports are needed. For the verified provider and the adapter operations in this spec, `CredentialsRejected`, `KeyDerivationFailed`, `VaultCorrupt`, `UnsupportedFormat`, `SidecarCorrupt` and `PlaintextVolume` arise during initialization. Before acquisition succeeds they are mount errors; if a successfully mounted service later reports one, its takeover initialization failed and the service is terminal. That is why the example can request session replacement for `CredentialsRejected`. `IntegrityFailure` can arise either during initialization or ordinary live I/O. For that reason, unclassified errors, or future provider behavior, inspect the original `reason.cause` for a lifecycle `VolumeError` rather than using the unwrapped reason to infer service state. Standalone premium management helpers remain outside this rule and outside v1.

The [verified code mappings and provider prerequisites](./effect-adapter-implementation-contract.md#error-classification-prerequisites) define which versions can support these reasons. Current overloaded/uncoded provider failures must not be guessed from messages. Missing credentials are application policy; missing generic storage capability remains `VolumeError`, not `EncryptionError`.

### Platform error mapping

`PlatformError` has top-level tag `"PlatformError"`; consumers inspect `reason._tag`. Attach the decoded `VolumeError`, `EncryptionError` or `SubscriptionError` as `reason.cause`, depending on the source. Include method, path/descriptor and underlying syscall where meaningful.

| Input | Platform reason |
| --- | --- |
| Invalid adapter argument | `BadArgument` |
| `ENOENT` | `NotFound` |
| `EEXIST` | `AlreadyExists` |
| `EACCES`, `EPERM` | `PermissionDenied` |
| `EISDIR`, `ENOTDIR`, `ELOOP`, `EBADF`, stale descriptor refusal | `BadResource` |
| `EBUSY` | `Busy` |
| `LEADER_RESPONSE_TIMEOUT` on a dispatched operation | `TimedOut`; sent mutations have `outcome: "possibly-applied"` |
| `VFS_OWNER_READY_TIMEOUT` before a filesystem dispatch | `TimedOut`; `outcome: "not-applied"` |
| `VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT` during registration | `TimedOut`, with the subscription setup error as cause |
| Standard watch interrupted by takeover | `Unknown`, with `SubscriptionError` code `SUBSCRIPTION_INTERRUPTED` as `reason.cause` |
| Known VFS corruption; vault/sidecar/data integrity failures | `InvalidData` |
| Zero progress during nonempty `writeAll` | `WriteZero` |
| `EINVAL` returned by core; quota/file-size limits; unsupported operation; unclassified errors | `Unknown` |

`VFS_INITIALIZATION_TIMEOUT` during mount is a lifecycle `VolumeError`. Only map other timeouts after verifying their source/code; do not match arbitrary error messages. Terminal service invalidation maps to `Unknown` even when its underlying failure is crypto-related; stale file handles remain `BadResource`.

Node rc.118 maps seven errno codes and otherwise uses `Unknown`. The rows for `EPERM`, `EBADF`, timeouts, corruption and write progress are deliberate, more-specific extensions. Do not classify every encryption failure as `InvalidData`: credentials, KDF infrastructure and format support are different from corrupted file data.

## 6. Filesystem API and compatibility

```ts
OpfsFileSystem.make(volume: VolumeService): FileSystem.FileSystem
OpfsFileSystem.layer: Layer<FileSystem.FileSystem, never, Volume>
```

`make` constructs lazy filesystem operations without opening another volume.

Filesystem operand paths are absolute volume paths. Reject relative operand paths with `BadArgument`; explicitly document this difference from Node. A symlink's target string is an exception: preserve valid relative symlink targets for resolution relative to the link location. Never treat a virtual path as a host filesystem path.

| Method group | Proposed behavior |
| --- | --- |
| `access` | Check existence/searchability and requested readable/writable access under the VFS permission model without mutating the entry. Do not equate a successful `stat` with every requested access permission. |
| `chmod`, `link`, `symlink`, `readLink`, `realPath`, `rename`, `truncate` | Adapt corresponding VFS operations, argument order, defaults and errors. |
| `utimes` | `Date.getTime()` for dates; numeric input is seconds since epoch as in Node, converted to VFS milliseconds with validation. |
| `chown`, `glob` | Explicit `Unknown` with `VolumeError` code `ENOTSUP` in v1. Glob support is deferred rather than adding a matcher now. |
| `makeDirectory` | Preserve recursive and mode options. |
| `readDirectory` | Return names relative to the requested directory; recursive results also remain relative. Use traversal with proper permission checks rather than blindly filtering a global listing. |
| `copyFile` | Scoped chunked read/write; handle aliasing/same inode before truncating, short writes and buffer ownership. |
| `copy` | Recursive copy with overwrite and timestamp policy, symlinks preserved rather than followed into cycles, and ancestor/self-copy guards. It is not atomic; partial success remains possible. Hard-link topology preservation is not promised. |
| Four `makeTemp*` methods | Default to a volume-local `/tmp`; honor directory/prefix/suffix. Use exclusive creation with random names, not check-then-create. Scoped forms remove only their own created paths and report cleanup failures via `Cause`. |
| `open` and `File` | Scoped descriptor, generation protection, checked offset conversion, per-handle serialization and adapter-owned cursor. See below. |
| `readFile`, `writeFile` | Use existing whole-file helpers where the linked routing contract applies; otherwise scoped chunked descriptor I/O. Preserve flags, modes, generation and buffer ownership. |
| `remove` | Respect recursive/force. `force` suppresses missing-path failure only; it must not hide permission, integrity or transport failures. |
| `stat` | Synthetic `dev: 0` denotes this virtual filesystem, not host identity. Preserve valid VFS inode/link/mode/size/timestamp/block metadata. Missing UID/GID/rdev/birthtime use `Option.none()`. |
| `watch` | Subscription-backed, absolute event paths, typed unavailable failure; details below. |

Whole-file helpers and chunked operations can produce different intermediate states and event counts; neither promises rollback. Ordinary append uses native O_APPEND, so concurrent writers do not rely on a racy EOF lookup. Caller-owned write buffers remain usable. File cursors are serialized per handle, with checked offsets and upstream truncate behavior.

Standard watch emits absolute volume paths, fails `NotFound` for a missing initial target, and rejects watching through a symlink target in v1. Takeover terminates it with `PlatformError` reason `Unknown` and `SubscriptionError(SUBSCRIPTION_INTERRUPTED)` as cause; it never silently resubscribes or fills a lost-event gap. The standard interface has no watch-ready signal; reconciled views use rich subscriptions as shown below.

See the [filesystem routing contract](./effect-adapter-implementation-contract.md#filesystem-routing-and-conformance) for the 16 MiB helper selection, buffer copying, descriptor behavior and exact watch mapping.

## 7. Subscriptions API

```ts
interface Subscription {
  // Exactly one consumption, within the owning volume lifetime.
  readonly changes: Stream<FileChange, SubscriptionError>
  // Repeatable await of the same terminal result; does not initiate close.
  readonly retired: Effect<SubscriptionRetirement>
}

type SubscriptionErrorCode =
  | "SUBSCRIPTION_OVERFLOW" | "SUBSCRIPTION_INTERRUPTED"
  | "SUBSCRIPTION_CALLBACK_FAILED" | "SUBSCRIPTION_RESYNC_REQUIRED"
  | "SUBSCRIPTION_RETIREMENT_UNKNOWN" | "SUBSCRIPTION_SETUP_FAILED"
  | "EINVAL" | "EBADF"

// SubscriptionError: _tag = "SubscriptionError", code above,
// fileName, path, optional original sourceCode, bounded details and cause.

type SubscriptionRetirement =
  | { readonly status: "released" }
  | { readonly status: "unknown"; readonly error: SubscriptionError }

interface SubscriptionsService {
  readonly subscribe: (options: SubscribeOptions) =>
    Effect<Subscription, SubscriptionError, Scope>
}

Subscriptions.layer: Layer<Subscriptions, VolumeError, Volume>
```

`SubscribeOptions` keeps path, file/directory scope, recursive flag, event selection, matching and optional bounded content capture. Scope/interruption and typed errors replace `signal` and `onError`. A missing configured capability fails service acquisition as an unsupported `VolumeError`. Per-registration failures are `SubscriptionError`.

Use a closed known subscription code union containing the four terminal protocol codes, `SUBSCRIPTION_RETIREMENT_UNKNOWN`, `EINVAL` and `EBADF`, plus `SUBSCRIPTION_SETUP_FAILED` as an adapter fallback for other errors. Preserve the original code and bounded details separately. The review's smaller union is insufficient: target traversal can fail with `EACCES`/`ENOTDIR`, and transport/setup can fail with other codes. Effect cancellation remains interruption rather than a fabricated setup error.

`subscribe` returns only after confirmed registration; the existing activation step is scheduled subsequently. Its handle is ready to buffer events before the consumer runs. This supports subscribe-before-write/scan without claiming an atomic scan boundary or a historical replay.

`changes` has one consumer and no replay; ending it releases the subscription, with its scope as a cleanup backstop. `retired` is repeatably awaitable after scope closure and does not initiate cancellation. Recovery waits for retiring registrations; uncertain cleanup blocks the same owner generation but permits a confirmed new generation. Ready-owner and retirement waits share one budget and do not rewrite an older retirement result.

Delivery buffers 16 events plus one pending offer; captured payload can approach `17 * maxBytes` in addition to source buffers. Slow consumers delay acknowledgment, not filesystem writers; owner overflow remains a typed failure. Captured content is historical plaintext application data even for encrypted storage.

Subscriptions provide no atomic snapshot, initial enumeration or durable history. Explicit recovery registers anew and rescans current state; fanout can use application PubSub with a chosen slow-consumer policy. The [delivery/retirement contract](./effect-adapter-implementation-contract.md#subscription-delivery-and-retirement) specifies queue termination, memory bounds and registration gates.

## 8. Inspection and credentials

`Volume.inspect` wraps `peekVolume`. Reject invalid names as configuration `VolumeError`; valid names are basenames ending in `.bin`. No key is required and no volume is mounted. Keep `exists`, protection-marker `encrypted`, `importing`, plaintext `metadataVersion` where readable, and `compatible: boolean | "unknown"`.

`encrypted` means at least one `.vault`, `.crypt` or `.crypt.log` marker exists; it does not validate unlockability or the provider. Missing/damaged components can make inspection inconclusive. Use it to choose application UI and plugin configuration, then validate again at mount. Existing-volume workflows use `openMode: "open-existing"`; disappearance after inspection must not silently create a new volume. Creation uses a deliberate encryption choice and `create-new`. Import reservations and incompatible formats require explicit handling, never automatic deletion.

Creation and opening have different encryption options. In particular, premium `initialPasskey` requires `create-new`; it cannot be reused for opening an existing vault. Credential helpers should use `Redacted<string | Uint8Array>` and reveal only when constructing the private plugin request. Examples assume application helpers for collecting credentials and enforcing creation/open policy.

### Encryption plus subscriptions

```ts
// filesystem.worker.ts: existing plugin exports
import { startVfsWorker } from "@opfs-vfs/opfs-vfs/worker-runtime"
import { encryption } from "@opfs-vfs/plugin-encryption"
import { subscriptions } from "@opfs-vfs/plugin-subscriptions"

startVfsWorker({ plugins: [encryption, subscriptions] })
```

```ts
// page.ts: proposed adapter; secret is already Redacted<string | Uint8Array>.
import { Effect, Layer, Redacted } from "effect"
import { Volume, OpfsFileSystem, Subscriptions, VolumeError } from "@opfs-vfs/effect"
import { encryptionRequest } from "@opfs-vfs/plugin-encryption/config"
import { subscriptionsRequest } from "@opfs-vfs/plugin-subscriptions/config"

const encryptedOptions = (secret: Redacted.Redacted<string | Uint8Array>) => ({
  fileName: "documents.bin",
  openMode: "open-existing" as const,
  transport: "dedicated" as const,
  worker: () => new Worker(
    new URL("./filesystem.worker.ts", import.meta.url),
    { type: "module" }
  ),
  // Both factories run inside the adapter's typed configuration boundary.
  plugins: () => [
    encryptionRequest({ secret: Redacted.value(secret) }),
    subscriptionsRequest()
  ]
})

const DocumentsVolume = Volume.layer(encryptedOptions(secret))
const DocumentsLive = Layer.mergeAll(
  OpfsFileSystem.layer,
  Subscriptions.layer
).pipe(Layer.provideMerge(DocumentsVolume))
```

Keep adapter-only temporary option references only as long as acquisition needs them. This does not erase credentials: a retained layer value closes over its options/thunk and `Redacted` secret, and core retains worker plugin requests for a possible takeover until disposal. Caller-held values and JavaScript strings cannot be reliably zeroized. Never claim `Redacted` or dropping one reference wipes the secret.

If credentials come from a service, yield that service in the configuration Effect and return options with the same plugin thunk. That service is required only by that configuration. The filesystem layer itself still requires only `Volume`. In the example above the dependency flows from `DocumentsVolume` into the consumer layers; reversing `provideMerge` would not satisfy the subscription service's dependency.

```ts
// Application effects: requestCredentials returns a Redacted secret.
const mountEncrypted = (secret: Redacted.Redacted<string | Uint8Array>) =>
  Volume.make(encryptedOptions(secret))

const unlockExisting = Effect.gen(function* () {
  const info = yield* Volume.inspect("documents.bin")
  yield* checkOpenPolicy(info) // Missing/importing/compatibility decisions.
  if (!info.encrypted) {
    return yield* Volume.make({
      fileName: "documents.bin",
      openMode: "open-existing"
    })
  }
  const secret = yield* requestCredentials()
  return yield* mountEncrypted(secret)
}).pipe(
  Effect.catchTags({
    VolumeError: (error) => error.code === "VFS_STORAGE_PLUGIN_REQUIRED"
      ? requestCredentials().pipe(Effect.flatMap(mountEncrypted))
      : Effect.fail(error),
    EncryptionError: (error) => error.reason === "CredentialsRejected"
      ? requestCredentials(error.reason).pipe(Effect.flatMap(mountEncrypted))
      : Effect.fail(error)
  })
)
```

The returned scoped volume can supply the standard filesystem service directly:

```ts
import { FileSystem } from "effect"

const UnlockedFileSystemLive = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(unlockExisting, OpfsFileSystem.make)
)
```

Credential collection here runs during layer construction, including the first build by a `ManagedRuntime`. The layer owns the successful volume's scope; failed attempts have already closed their private scopes.

The missing-provider branch is appropriate only for this application's supported encryption profile, not a generic storage plugin. This example permits one user-driven recovery attempt; errors from that handler remain failures. The `CredentialsRejected` mapping assumes the corrected premium version. A known-good secret can still be rejected by a damaged slot. KDF, structure and integrity failures are not prompts to keep changing passwords.

Successful follower attachment uses the existing owner's unlocked storage and does not verify this tab's secret. A normal read through that owner is not independent credential verification either. No per-tab authentication is promised and no force-takeover recipe is part of this API. If this dedicated follower later becomes owner, its own credentials are used for initialization. That can fail with `CredentialsRejected` or another encryption error minutes after mounting. The client then becomes terminally failed. Other credential errors do not justify repeatedly prompting for a new password.

Use one long-lived `ManagedRuntime` per application session. Every save runs against its existing volume; mounting belongs to session creation, not the save handler:

```ts
import { Exit, ManagedRuntime } from "effect"

const makeSession = (secret: Redacted.Redacted<string | Uint8Array>) =>
  ManagedRuntime.make(Layer.mergeAll(OpfsFileSystem.layer, Subscriptions.layer).pipe(
    Layer.provideMerge(Volume.layer(encryptedOptions(secret)))
  ))

let session = makeSession(secret)
// Application startup observes this Exit and disposes the runtime on build failure.
const started = await session.runPromiseExit(Effect.void)

const save = Effect.gen(function* () {
  const volume = yield* Volume.Volume
  yield* volume.sync
  return "saved" as const
}).pipe(Effect.catchTags({
  EncryptionError: (error) => error.reason === "CredentialsRejected"
    ? Effect.succeed("credentials-needed" as const)
    : Effect.fail(error),
  VolumeError: (error) => error.code === "VFS_SYNC_OWNER_CHANGED"
    ? Effect.succeed("verification-needed" as const)
    : Effect.fail(error)
}))

async function onSave() {
  const current = session
  const result = await current.runPromiseExit(save)
  if (Exit.isFailure(result)) return reportSessionFailure(result.cause)
  if (result.value === "credentials-needed") {
    // Runs after the save fiber exits, outside the runtime being disposed.
    session = await replaceSessionWithCredentials(current)
  } else if (result.value === "verification-needed") {
    // Keep unsaved edits; reread/compare before choosing a new save baseline.
    await showSaveNeedsVerification(current)
  }
}
```

### Session replacement and reconciliation

- Attach the save handler only after `started` succeeds. On startup failure, dispose the runtime and report both exits.
- Serialize save/replacement actions and stop admitting new work while replacing a session. `replaceSessionWithCredentials` cancels and joins session-owned tasks, observes `current.disposeEffect` through `Effect.runPromiseExit`, and reports cleanup failure before proceeding. Never dispose from a fiber that disposal must join.
- Collect a new secret, create a runtime with `makeSession`, and check its layer build before publishing it. Dispose and report a failed build without automatic retry. Canceled credential collection leaves the session unavailable.
- Neither replacement nor saving replays previous writes. `showSaveNeedsVerification` keeps intended edits and the unsaved status while the application reconciles. After an explicit decision, run `volume.acknowledgeOwnerChange`, then `volume.sync` before reporting saved. Never acknowledge loss automatically.

After the user explicitly accepts the reconciliation result, the application hook can run:

```ts
const acceptReconciledSave = Effect.gen(function* () {
  const volume = yield* Volume.Volume
  yield* volume.acknowledgeOwnerChange
  yield* volume.sync // Another takeover here fails; acknowledgment is not a save.
})
```

A filesystem-triggered terminal unlock failure uses the nested cause described in section 5; `Volume.errorOf` below exposes its underlying error. The original failure and any independent cleanup failure remain available to the application through `Exit`.

Premium export/import/migration/passkey helpers remain outside v1. Future wrappers belong in a premium integration entry point and must respect their own worker and exclusive-volume ownership requirements. Mounting an encrypted adapter is not an in-place migration facility.

## 9. Usage and error handling

```ts
import { Effect, FileSystem, Stream } from "effect"

const readNote = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString("/note.txt").pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed("")
        : Effect.fail(error)
    )
  )
})

const writeAndObserve = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const volume = yield* Volume.Volume
  const subscriptions = yield* Subscriptions.Subscriptions
  const sub = yield* subscriptions.subscribe({
    path: "/", scope: "directory", recursive: true, content: false
  })

  yield* Effect.all([
    sub.changes.pipe(
      Stream.take(1),
      Stream.runForEach((event) => Effect.log(event.type, event.path))
    ),
    fs.writeFileString("/note.txt", "Hello")
  ], { concurrency: "unbounded" })

  // take(1) initiated unsubscribe; this is the explicit remote cleanup barrier.
  const retirement = yield* sub.retired
  if (retirement.status === "unknown") return yield* Effect.fail(retirement.error)
  yield* volume.sync
}))

const exit = await Effect.runPromiseExit(
  writeAndObserve.pipe(Effect.provide(DocumentsLive))
)
// Application handles Exit, including independent cleanup failures.
```

One observed event is not proof that a particular write committed. The combined operation fails if either branch fails. Supervise failures of a long-lived subscription rather than detaching it without observation.

Adapter-specific filesystem handling derives guards from the exported error schemas:

```ts
import { Schema } from "effect"
import { EncryptionError } from "@opfs-vfs/effect"

const isEncryptionError = Schema.is(EncryptionError)

fs.readFile("/record.bin").pipe(
  Effect.catchTag("PlatformError", (error) => {
    const cause = Volume.errorOf(error)
    if (isEncryptionError(cause) && cause.reason === "IntegrityFailure") {
      return showIntegrityProblem(cause).pipe(Effect.andThen(Effect.fail(error)))
    }
    if (isEncryptionError(cause) && cause.reason === "CredentialsRejected") {
      // Inform the outer session owner; it closes the scope before remounting.
      return notifySessionNeedsCredentials(cause).pipe(
        Effect.andThen(Effect.fail(error))
      )
    }
    return Effect.fail(error)
  })
)
```

`Schema.is(EncryptionError)` is the verified rc.118 API. It guards the adapter's decoded error value; it does not decode arbitrary wire objects or imply premium class identity survives transport. No extra guard export is needed.

### Recovering a watched view

For notification delivery alone, a standard filesystem consumer can opt into retries:

```ts
import { Schedule } from "effect"
import { SubscriptionError } from "@opfs-vfs/effect"

const isSubscriptionError = Schema.is(SubscriptionError)
const notifications = fs.watch("/").pipe(
  Stream.retry(($) => $(Schedule.spaced("250 millis")).pipe(
    Schedule.while(({ input, attempt }) => {
      const cause = Volume.errorOf(input)
      return attempt <= 3 && isSubscriptionError(cause) &&
        cause.code === "SUBSCRIPTION_INTERRUPTED"
    })
  ))
)
```

This resumes notifications only; it cannot reconstruct missed changes. Stream retry resets its schedule after successful output, so this is a bound on consecutive failed restarts, not a lifetime retry limit. The adapter's registration gate still blocks same-generation unknown retirement and terminal mounts. Permission, integrity and setup errors remain failures.

For a cache or UI that must reconcile after takeover, use the rich service's registration barrier. The smallest reliable pattern treats notifications as invalidation hints and rescans current state serially. It does not replay historical file contents into the new view:

```ts
import type { SubscriptionRetirement } from "@opfs-vfs/effect"

const reconcileAttempt = Effect.gen(function* () {
  // Retained only to await cleanup after the inner scope has closed.
  let retired: Effect.Effect<SubscriptionRetirement> | undefined
  const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
    const subscriptions = yield* Subscriptions.Subscriptions
    const sub = yield* subscriptions.subscribe({
      path: "/", scope: "directory", recursive: true, content: false
    })
    retired = sub.retired
    yield* rescanCurrentView() // Registration is already confirmed; events buffer.
    yield* sub.changes.pipe(Stream.runForEach(() => rescanCurrentView()))
  })))
  // Scope exit initiated unsubscribe even if the initial scan failed.
  if (retired) yield* retired
  return yield* exit // Preserve the failure, defect or interruption.
})

const keepViewCurrent = reconcileAttempt.pipe(
  Effect.tapError(() => markViewStale()),
  Effect.retry(Schedule.spaced("250 millis").pipe(
    Schedule.while(({ input, attempt }) =>
      attempt <= 3 && isSubscriptionError(input) &&
      (input.code === "SUBSCRIPTION_INTERRUPTED" ||
       input.code === "SUBSCRIPTION_OVERFLOW" ||
       input.code === "SUBSCRIPTION_RESYNC_REQUIRED")
    )
  ))
)
```

`rescanCurrentView` and `markViewStale` are application Effects; the former reads current state and replaces the view. Run this workflow inside the session runtime. Each retry registers afresh, then rescans; it never repeats filesystem writes. Unknown retirement is recorded by the adapter before `retired` settles. After unknown retirement, the next registration can proceed only on a different ready generation; same-generation uncertainty produces `SUBSCRIPTION_RETIREMENT_UNKNOWN`, which this schedule does not retry. Setup, scan, permission, crypto and terminal mount errors also stop for application handling. Exhaustion stays visible.

This example pays for a full scan per hint, which suits small views. Large views can serialize path-level rereads or coalesce invalidations when measurements justify it. Scans are not atomic snapshots; overflow or failure invalidates the view again. `Stream.retry` is appropriate when only renewed notification delivery is needed, using the same bounded/recoverable-error policy after `Volume.errorOf`. For reconciled state, retrying the complete scoped read-only attempt also gives a place to await retirement and establish the next subscription before rescanning. Generic `FileSystem.watch` alone cannot provide that readiness guarantee; use the rich service or accept explicit eventual/periodic reconciliation.

## 10. Multiple volumes through layers

Do not merge two filesystem implementations under the same standard tag. Application tags distinguish them; portable workflows receive the appropriate standard service locally.

```ts
import { Context, Effect, FileSystem, Layer } from "effect"

class DocumentsFs extends Context.Service<DocumentsFs, FileSystem.FileSystem>()(
  "app/DocumentsFs"
) {}
class CacheFs extends Context.Service<CacheFs, FileSystem.FileSystem>()(
  "app/CacheFs"
) {}

const DocumentsFsLive = Layer.effect(DocumentsFs,
  Effect.map(Volume.make({ fileName: "documents.bin" }), OpfsFileSystem.make)
)
const CacheFsLive = Layer.effect(CacheFs,
  Effect.map(Volume.make({ fileName: "cache.bin" }), OpfsFileSystem.make)
)
const BothLive = Layer.mergeAll(DocumentsFsLive, CacheFsLive)

const readFromBoth = Effect.gen(function* () {
  const documents = yield* DocumentsFs
  const cache = yield* CacheFs
  return yield* Effect.all({
    documents: readNote.pipe(Effect.provideService(FileSystem.FileSystem, documents)),
    cache: readNote.pipe(Effect.provideService(FileSystem.FileSystem, cache))
  }, { concurrency: "unbounded" })
}).pipe(Effect.provide(BothLive))
```

Layer acquisition owns each volume's scope. Reuse a single layer value when multiple consumers should share acquisition. Two constructor calls with identical options are two acquisitions, which may conflict or attach to an existing owner; they are not a global cache. Different filenames identify different logical volumes. Cross-volume transactions, atomic moves and a merged namespace are outside this proposal.

## 11. Implementation and validation

The [implementation contract](./effect-adapter-implementation-contract.md) contains acquisition, continuity tracking, gate ordering, retirement, queue behavior, provider corrections and the [required acceptance tests](./effect-adapter-implementation-contract.md#acceptance-tests-and-release-gates). Full worker-backed File support remains gated on atomic generation-bound descriptors. The core/provider versions containing required fixes remain to be selected.

## 12. Review status

Findings and their disposition for all six rounds are in [review history](./effect-adapter-api-review-history.md). This document contains the current decisions; section 11 links the remaining implementation/validation gates. This update changes the design documents only.

## 13. Sources and verification

The [source references and verification record](./effect-adapter-implementation-contract.md#evidence-and-source-references) pin the Effect version and core/premium evidence. Effect APIs were checked through opensrc and isolated TypeScript/runtime fixtures. Adapter and browser behavior still require implementation and the listed acceptance tests.

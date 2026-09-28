# File and directory subscriptions design

Status: S7 design documentation for [premium issue #11](https://github.com/opfs-vfs/opfs-vfs-premium/issues/11). This preserves the reviewed PR #17 design baseline and adds accepted S3/S5b updates below. The [specification](../specs/file-subscriptions.md) is normative for consumer behavior. The historic implementation plan remains valuable acceptance detail; the S7 update controls if it conflicts with the current stacked implementation status.

This specification, design, and `packages/plugin-subscriptions` now live in `opfs-vfs/opfs-vfs` under its PolyForm Noncommercial License. The original cross-repository S0–S7 plan below is historical; current development uses the core workspace dependency and local packed artifacts. Core implementation PRs link to these contracts. The revisions address the [original review](https://github.com/opfs-vfs/opfs-vfs/pull/52#pullrequestreview-5307314639) and [response on premium PR #17](https://github.com/opfs-vfs/opfs-vfs-premium/pull/17#issuecomment-5819759980).

## Starting point and ownership

Core `6689770f670a25f5e545913373a378daa7907108` and premium `ab764d37bf7ab59a0705c6b87929c172da14fc46` contain the merged plugin refactor. Its storage seam remains the encryption seam. Logical subscriptions need an additional contribution because storage writes include block allocation, metadata, logs, and encryption housekeeping rather than completed file operations.

| Responsibility                                                                                                             | Repository and module                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Logical mutation recording, outer operation scopes, snapshot permission checks and reading, generation and record sequence | Core `OpfsVfs`                                               |
| Validated contribution lifecycle and the closed normal-client transport                                                    | Core plugin configuration, worker runtime, and worker client |
| Subscription matching, capacity reservations, retained captures, delivery state                                            | Premium subscriptions owner module                           |
| Local option validation, promise/activation handoff, listeners, abort and cleanup                                          | Premium `/client` module                                     |
| Cloneable activation request and compatibility key                                                                         | Premium `/config` module                                     |

Core tests use a small logical-change test plugin, never premium imports. The subscription package consumes core public interfaces through a workspace dependency; its installed-consumer checks pack both packages from the same checkout. Premium encryption integration checks retain an exact source pin. Keep `OpfsVfs`, `OpfsVfsWorker`, and the one-storage-provider rule. Do not replace classes, patch methods, infer changes from storage, add generic operation middleware, or expose a plugin lookup registry.

The specification's compatibility policy applies to all fixes and implementation layers. Proposed names and declaration locations can change when that simplifies the design. Update current callers and tests together; preserving an old entry point or behavior is not a release requirement.

## Closed contribution and client interfaces

Add one `logicalChanges` contribution slot. A configured plugin contributes either storage or logical changes. V1 allows at most one of each per mount; a second contributor to either slot rejects with `EINVAL`. Different plugin IDs do not bypass that rule. The proposed union accepts the current encryption shape; implementation may revise both contributions together when needed. Empty contributions reject.

These declarations belong to the core `/plugins` entry, with change protocol types in a new `/changes` entry. The latter contains types and small bridge code only, with no premium dependency.

```ts
interface PluginIdentity {
  readonly id: string;
  readonly contractVersion: 1;
  readonly compatibilityKey: string;
  readonly requiredOpenMode?: 'create-new';
}

interface StorageContribution {
  readonly factory: VolumeStorageFactory;
  readonly sidecars: readonly StorageSidecarSuffix[];
}

type ConfiguredVfsPlugin = PluginIdentity &
  (
    | { readonly storage: StorageContribution; readonly logicalChanges?: never }
    | { readonly storage?: never; readonly logicalChanges: LogicalChangeContribution }
  );

interface LogicalChangeContribution {
  readonly version: 1;
  create(host: LogicalChangeHost): LogicalChangeSession;
}

interface LogicalChangeHost {
  readonly generation: string;
  validateTarget(target: Pick<WireSubscribeOptions, 'path' | 'scope' | 'recursive'>): void;
  send(client: ChangeClient, frame: ChangeFrame): void;
}

interface LogicalChangeSession {
  control(client: ChangeClient, command: ChangeCommand): ChangeReply;
  completed(operation: CompletedLogicalOperation): void;
  invalidated(impact: ChangeImpact, reason: 'partial-mutation' | 'record-limit'): void;
  clientClosed(client: ChangeClient): void;
  close(reason: 'close' | 'initialization-failed' | 'replacement'): void;
}

interface LogicalRecord {
  readonly type: 'create' | 'update' | 'delete';
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly cursor: { readonly generation: string; readonly sequence: number };
  readonly inodeId: number;
  readonly size: number;
}

interface CompletedLogicalOperation {
  readonly records: Iterable<LogicalRecord>;
  capture(record: LogicalRecord, maxBytes: number): CapturedContent;
}

type CapturedContent =
  | { readonly status: 'included'; readonly bytes: Uint8Array }
  | {
      readonly status: 'omitted';
      readonly reason: 'deleted' | 'not-file' | 'too-large' | 'unavailable';
    };

type ChangeImpact =
  | {
      readonly kind: 'paths';
      readonly paths: readonly { readonly path: string; readonly subtree: boolean }[];
    }
  | { readonly kind: 'all' };
```

`validateTarget` uses the mounted namespace and normal search checks without atime changes. It permits missing entries, rejects symlink ancestors and conflicting existing kinds, and runs during registration before installation. `inodeId` and `size` are owner-only facts, never public event fields. `records` enumerates finalized records in specification order without requiring another materialized subtree array. `capture` is usable only during `completed`, only for a record supplied by that operation, and never after its return. It cannot read arbitrary historical versions. Core rejects stale record tokens; plugins must finish matching, reserving, and capture synchronously.

`create`, `control`, `completed`, `invalidated`, and `clientClosed` are synchronous owner-side operations. They perform bounded bookkeeping and snapshot reads, never invoke application listeners or wait for acknowledgement. `close` is synchronous and idempotent. If contribution code throws unexpectedly after mount, core contains it, poisons the change capability, and terminates all its channels with `SUBSCRIPTION_RESYNC_REQUIRED`. It preserves the filesystem result. A thrown `create` fails initialization and runs all cleanup already acquired.

The wire contract is deliberately closed around this feature. Core provides no arbitrary plugin method name, payload type, service key, callback invocation, or user-defined command opcode.

```ts
interface WireSubscribeOptions {
  readonly path: string;
  readonly scope: 'file' | 'directory';
  readonly recursive: boolean;
  readonly events: readonly ('create' | 'update' | 'delete')[];
  readonly match?: { readonly source: string; readonly flags: string };
  readonly content: false | { readonly maxBytes: number };
}

interface ChangeClient {
  readonly clientId: string;
  readonly channelId: string;
  /** Stamped by core transport; controls cannot choose this route. */
  readonly route: 'local' | 'follower-relay';
}

type ChangeCommand =
  | {
      readonly type: 'register';
      readonly subscriptionId: string;
      readonly options: WireSubscribeOptions;
    }
  | { readonly type: 'activate'; readonly subscriptionId: string }
  | { readonly type: 'ack'; readonly subscriptionId: string; readonly deliveryId: number }
  | { readonly type: 'cancel'; readonly subscriptionId: string }
  | { readonly type: 'terminal-ack'; readonly subscriptionId: string };

type ChangeReply = { readonly type: 'registered'; readonly subscriptionId: string } | { readonly type: 'ok' };

type TerminalCode =
  | 'SUBSCRIPTION_OVERFLOW'
  | 'SUBSCRIPTION_INTERRUPTED'
  | 'SUBSCRIPTION_CALLBACK_FAILED'
  | 'SUBSCRIPTION_RESYNC_REQUIRED';

type ChangeFrame =
  | {
      readonly type: 'event';
      readonly subscriptionId: string;
      readonly deliveryId: number;
      readonly change: FileChange;
    }
  | { readonly type: 'terminal'; readonly subscriptionId: string; readonly code: TerminalCode }
  | { readonly type: 'closed'; readonly subscriptionId: string };

interface FileChangeChannel {
  readonly generation: string;
  request(command: ChangeCommand): Promise<ChangeReply>;
  close(): void;
}

// Implemented by both OpfsVfs and OpfsVfsWorker.
interface FileChangeSource {
  openFileChangeChannel(
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    closed: () => void,
  ): Promise<FileChangeChannel>;
}
```

`FileChange` is the data type in the specification, owned by core `/changes` and re-exported by the subscription package’s `/client`. The public subscription helper calls `fs.openFileChangeChannel`; it never reads private fields. The method is a dedicated, statically declared seam for the sole logical-change contribution, not a dynamic extension method. It waits for readiness and rejects with `ENOTSUP` when unavailable. It supplies a mount-local channel identity and closes with the client. The helper shares one channel per filesystem object while any of its subscriptions or retiring frames remain.

Every transport envelope additionally carries version `1`, owner generation, normal-client identity, and channel identity. The runtime derives the client identity from the normal transport route; it never accepts a subscription payload's asserted client identity. Subscription IDs are caller-generated unique IDs scoped to that channel, making cancel-before-ack possible. The owner assigns increasing delivery IDs per subscription. Duplicate control messages are idempotent; an unknown or stale acknowledgement cannot free a reservation. Malformed shapes, unknown fields, out-of-range numbers, and identity mismatches reject or discard before contribution dispatch. Protocol errors contain fixed messages rather than plugin option data.

## Configuration, profiles, and lifecycle

`plugin-config.ts` must validate the contribution union and snapshot it before the first mount await. Count storage and logical-change slots separately. Keep configured objects and contribution factories single-use with the existing weak-set claim discipline. Worker static registrations still call `configure` for each mount and return fresh state. A failed mount does not make a claimed instance reusable.

`worker-plugins.ts` currently treats the second request as a second storage provider. Remove that inference. It may accept up to two unique activation requests, then validate the resolved contribution slots at the worker. It still structured-clones requests before ownership election and checks exact request fields. `createMountProfile` and strict sorted-profile comparison keep their existing shape and version. The active subscriptions request contributes `subscriptions`, contract version `1`, and `subscriptions-v1`; paths, regexes, listeners, limits, and content settings never enter the profile.

`worker-runtime.ts` resolves all IDs, configures all registrations, validates every configured contribution, and checks request/profile equality before replacing the live mount. It then creates the new logical-change session once the logical namespace has loaded. Failed initialization closes any created session and every acquired storage handle. Normal close and re-INIT dispose the session in a `finally` path even when flush or storage close throws. No session callback runs after disposal. Direct mounts use a fresh generation for the mount. Worker mounts use the existing owner generation: add it to the strictly validated INIT envelope and pass it through a runtime-internal mount context, never a plugin option or mount profile. A replacement worker gets a fresh owner generation and fences the old one.

The core records operations whenever the contribution is active. Metadata-only listeners still allocate event records; they skip content reads and content buffers. With no contribution active, operation entry takes only an inactive check. It creates no scope object, record, event, reverse index, matching state, or snapshot. Existing inode/path indexes are reused rather than maintained a second time.

## Operation scopes and mutation recording

Add a private synchronous `withLogicalOperation` mechanism in `OpfsVfs`, with depth and a bounded outer accumulator. Public mutators enter it; nesting increments depth and contributes to one result. No scope may remain open across an `await` or across commands.

Move the existing `WRITE_FILE_BUFFER` implementation into a proposed direct `OpfsVfs.writeFileBufferSync(path, bytes, options): void` method, which enters that private scope. Move `WriteFileBufferOptions` to the appropriate shared core declaration and update its callers and imports together. No legacy re-export is required. The proposed helper supports `exclusive`, `expected`, and `append` as specified here. The worker command validates its wire payload then delegates to this helper. The new direct helper validates the same limits and arguments because direct callers do not pass through the worker validator. This gives direct and worker whole-file operations one implementation without exposing a generic application batch or a private method to the worker runtime. Other mutating commands already delegate to one synchronous core mutator.

Do not wrap the asynchronous `handleSyncCommand` in a synchronous scope. A thrown mutation error becomes a rejected promise there, so such a wrapper would mistake promise creation for successful completion. Finalize from the synchronous mutator/helper body before the dispatcher returns its promise.

Record facts at mutation sites, not by wrapping `VolumeStorage`, watching OPFS filenames, comparing every file after each command, or hooking generic dirty/timestamp helpers. Existing dirty markers conflate logical changes, reads, namespace maintenance, and persistence.

| Current core path                                                   | Required recording                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `symlinkSync`, `mkdirSingleSync`, `openSync` creation, `linkSync`   | Added namespace entry after successful insertion; retain kind and inode.                                                           |
| `writeSync`, shared `truncateInode`, `chmodSync`, `utimesSync`      | Changed inode, with pre-state necessary to suppress known no-ops. Expand all live names at finalization.                           |
| `unlinkSync`, `rmdirSync`, `removeSync`                             | Removed path and kind retained before removal. Recursive removal contributes descendants to the outer scope.                       |
| `renameSync`                                                        | Existing destination removal, old subtree entries, and new mapped entries. Reuse existing traversal; distinguish same-inode no-op. |
| `mkdirSync` recursive path and `openSync` internal truncate         | Nested scopes, with partial-mutation tracking if a later step fails.                                                               |
| Proposed `writeFileBufferSync`, delegated to by `WRITE_FILE_BUFFER` | One outer scope around validation/open, optional comparison, write, final truncate, and close.                                     |

The accumulator records namespace transitions and a set of changed inodes. A path created and then written in the same supported helper finalizes as one create. Existing inode updates deduplicate within the scope and fan out to all live names. Rename replacement retains deletion and creation records even when the same path exists at both ends. Do not use a single `Map<path, lastEvent>` that loses replacement or subtree transitions. No supported v1 scope contains arbitrary user code or unrelated application operations.

The existing `inoToPaths` index and `pathsForInode` helper supply every live hard-link name; a single `pathForInode` is insufficient. Namespace recording uses resolved logical paths from core, not raw arguments. Symlink resolution remains the core's responsibility. The source does not add target aliases under symlinks.

At successful outer exit, finalize order and no-op suppression, assign sequences, then synchronously call `completed`. The plugin tests filters, reserves capacity, captures requested content, and retains records. Only after that call returns may core acknowledge success or accept another mutation. Sending a later notification cannot move capture outside this point.

If any nested call throws, mark the outer operation failed. Keep a separate impact marker from successful record staging. Before an irreversible data write or namespace edit, register the possibly affected inode or paths; after a proven no-change validation failure, leave it empty. A lower-level I/O error can leave the marker conservative even if rollback restored state. On failed outer exit discard all its records, then call `invalidated` for the conservative affected names. Do not infer loss of impact information merely from event-staging overflow. Use the independent bounded impact description below; invalidate all only when it cannot safely cover the affected paths. Preserve the original thrown filesystem error.

The additional accumulator is capped at 4,096 descriptors and 4 MiB of charged path/record metadata. Check before allocating each descriptor. Exceeding it sets one overflow flag, stops event recording for that scope, and discards its staged records while filesystem work continues. Call `invalidated` with `record-limit` and the conservative impact description so only overlapping subscriptions terminate with overflow. Do not retain an unbounded snapshot of a moved tree just to produce notifications.

Maintain impact independently, before mutations, with at most 128 regions and 64 KiB charged metadata. Each region records a normalized path and whether it includes the subtree; charge UTF-8 path bytes plus 256 bytes per region. Rename/removal root regions continue to cover their descendants after event recording stops. Exact inode updates cover every live hard-link name. The description must cover every subsequent mutation in the scope, not only the first overflowing record. If complete coverage cannot remain within the impact budget, switch to `all` before omitting a possibly affected name. Matching tests watched-path overlap before event-type/regex filters, including watchers rooted inside a moved/removed subtree. Existing filesystem traversal allocations are unchanged; all additional subscription allocations obey these caps.

### Shared I/O correctness prerequisite

Core `98e49fc` ignores returned counts in disk `writeSync`, `readBlocks`, and memory hydration. Other unchecked data writes initialize block edges, fill zero ranges, and persist dirty pages. These are correctness problems without subscriptions. Fix them first in a standalone core PR, independent of the subscription stack, rather than adding a capture-only reader.

Audit all shared data-handle callers. Reuse `writeAll` or the same checked progress logic for each physical write, and a shared exact-read helper for ordinary block reads and hydration. Advance by actual positive counts; reject zero progress, invalid counts, and unexpected physical EOF instead of reporting unfilled bytes as valid zeroes. Preserve intentional sparse holes and documented unbacked logical tails. Preserve the original storage error when present. Cover block initialization, zero filling, dirty-page persistence, and reopening in the fault tests, not just foreground reads/writes. Update callers together without legacy compatibility wrappers.

Subscription scopes must mark possibly affected inodes before physical writes. An operation that throws after a possible partial overwrite causes resync, not a successful full-write event. A supported API that deliberately returns a positive short count must update size/cursor to the actual bytes and capture that state. This documentation branch implements none of these runtime fixes.

### Whole-file preflight

In the proposed `writeFileBufferSync`, resolve the target and validate final size and configured logical/block quotas before `O_CREAT` inserts a missing entry. Reuse core quota calculations, including append size, existing allocation, and memory/disk accounting. The worker already validates the message's byte-length limit before opening; that does not substitute for owner-specific quota checks. Tests must prove a predictable rejection leaves a missing path missing and an existing file unchanged.

Preflight cannot predict physical OPFS quota exhaustion or later I/O failure. Do not add unconditional unlink-on-error compensation: cleanup may fail, earlier persistence may already have changed, and existing inodes have different semantics. Retain conservative resync and the original filesystem error after actual or uncertain partial mutation. This helper is not a transaction or crash-atomic replacement.

### Adapter completion limits

PGlite `adapter.ts` implements `writeFile` using open/truncate, write, close, then optional chmod. Just-bash uses awaited open/write/close loops and can make several owner commands; Wasmer and DuckDB similarly call low-level methods. Each core operation remains observable. Do not add a scope around asynchronous adapter work because it would merge interleaving clients. A future grouping change must route a compatible whole-file helper into one owner command and preserve its size, mode, append, and error behavior. V1 claims whole-file grouping for `WRITE_FILE_BUFFER`, the proposed direct `writeFileBufferSync`, and nested work already inside one synchronous core mutator.

## Snapshot module

Add a private no-atime snapshot path to `OpfsVfs`, exposed only as the scoped `capture` function. Validate record membership, current inode identity, regular-file kind, path search permission, file read permission, completed size, and caller limit. Use `lookupFileDataForInode` plus a bounded copy in memory mode, and the existing block traversal into an exact-size array in disk mode. Both read mounted logical contents. Do not call `openSync`/`readSync`/`closeSync`: ordinary reads touch atime and would perturb metadata.

Capture uses the shared checked reader corrected by S0, including corrected hydration for memory-mode data. Do not add a second capture-only reader while ordinary reads remain unchecked. Retry positive short progress only within the completed-operation scope. A checked-reader failure yields `unavailable` for capture; normal reads still fail with their applicable error. Unfilled physical bytes must never be reported as included zeroes. Intentional sparse holes remain zeroes. Add capture fault tests on top of S0 ordinary-read and hydration tests.

Capture catches its own permission, allocation, and read failures and returns `unavailable`. It never overwrites an operation's result or persistence error. No retry after finalization is allowed. Recheck authorization for every path before sharing a cached operation/inode capture. Keep the shared buffer private to the subscription owner module and copy before local delivery or transfer. Transfer a full, isolated `ArrayBuffer`; never transfer VFS memory or a shared capture out from under another queued record.

The plugin first matches records, computes completed sizes from owner-only record metadata, and decides omission reasons. It reserves one shared capture and every admitted recipient's delivery/relay credits before calling `capture`. The shared capture is keyed by operation/inode and exists only while `completed` runs: every recipient's isolated copy is made there, then the capture and its reservation are released. Path authorization is checked separately for every use. Recipient copies keep their reservations for their delivery lifetimes. If a capture is unavailable, release the content reservation and retain the metadata event. Events that exceed a listener's `maxBytes` reserve no content space and report `too-large`. Budget exhaustion is a terminal overflow, not a silent substitution of `unavailable`.

## Registration and callback state

Owner subscription states are `held`, `active`, `retiring`, and `closed`. Caller states are `registering`, `resolved`, and `closed`. Separate IDs for channel, subscription, and delivery avoid using an event cursor as a transport acknowledgement.

1. The helper snapshots and validates local options, installs an abort handler, and opens the shared core channel after readiness.
2. It allocates a subscription ID, records a cancellation tombstone locally, and sends `register`. The owner validates the wire fields, compiles its regex copy, validates the target, reserves a registration slot, and installs a held subscription before replying.
3. Completed changes after installation enter its bounded held queue. The helper processes the reply, rechecks abort/disposal, resolves the public handle, and schedules `activate` in a later task. It does not schedule the first listener in a promise-resolution microtask that could precede the caller's continuation.
4. Activation permits one event frame. The local dispatcher schedules the listener in a later task. It acknowledges that delivery only after the callback promise settles successfully. That acknowledgement frees the reservation and permits the next frame.
5. Throw or rejection closes local state immediately, reports callback failure once, and sends cancel. Pending deliveries are suppressed. The owner's final `closed` frame releases transport retirement independently of the rejected callback.

Abort and unsubscribe set the local closed bit before doing transport work. Cancel is safe before registration acknowledgement and is replayed against any late acknowledgement. The owner remembers a canceled setup ID until its bounded channel setup request completes, so delayed registration cannot revive it. If the caller observes overflow or interruption before local resolution, reject the setup promise rather than calling `onError`. Once resolved, terminal errors use `onError` exactly once, including a delayed terminal message from an owner that had already closed the held subscription. Error handlers execute outside listener serialization and a `Promise.resolve` rejection handler contains an async error handler despite the public `void` return type.

Each subscription has one callback task and one in-flight delivery at most. The helper must not schedule one task per queued record. A callback writing to the filesystem may enqueue more records, but its own next callback waits for acknowledgement. Other subscriptions have their own task and credit.

## Normal-client transport and memory accounting

Both asynchronous and SAB mutations run through `handleSyncCommand`. SAB remains request/response only. All change registration, event delivery, and acknowledgements use the asynchronous normal-client transport, even when mutations arrive over SAB. Do not invoke callbacks from `SyncMessenger.listen` or wait for page code while a synchronous caller is blocked.

The current follower `COMMAND` envelope contains tab/client identity, but the leader forwards only the command and payload to its worker. Add a closed `FILE_CHANGES` control envelope that the leader stamps with the verified normal-client route and current generation. Future unsolicited worker frames must return that route, not merely the original request ID. The owner client accepts them only from its current worker and forwards them only to the subscribing client. Direct instances use the same protocol state in process.

The existing shared BroadcastChannel is also used for ownership discovery and copies messages to every listener, even when a payload has a target ID. Sending subscription contents there would multiply memory with unrelated tabs. Extend the existing normal-client command transport with a recipient-specific delivery lane for this feature. The established normal client opens a BroadcastChannel named from the volume channel, generation, and client ID, then confirms the lane before registration. Only that client and its current owner relay open the lane. Register/activate/cancel/ack requests still use the existing command route. Event and terminal frames use the per-client lane; no discovery message contains them. Close the lane with the normal client or generation.

This is an explicit extension of the normal-client transport requested by issue #11, not an observer connection, another ownership scheme, a general plugin bus, or a capability that can be enabled independently of a mounted profile. It does not authenticate same-origin code. A same-origin script that deliberately opens another client's channel remains within the existing trust model. Do not log payloads, filters, or secrets.

Reserve the specification's limits in one owner ledger, including held queues and transport retirement. Charge each subscription the full file size for each content-bearing record. At mount level, charge a retained operation/inode capture once, one delivery copy per recipient record, and a relay copy only for follower recipients. Reserve all these credits before allocation, including copies needed later for delivery. Shared capture entries have reference counts covering queued, in-flight, and retiring uses; release the shared reservation only when the last use is released. Discarding one recipient's unsent record does not free another recipient's capture. All recipient records count separately against record/metadata budgets, including metadata-only records. Failed capture releases content reservations for its uses but retains their metadata events.

Send only one event per subscription until its matching acknowledgement. Recipient reservations remain charged through acknowledgement or conclusive disposal; the shared capture was already released when completion returned. A follower relay drops its buffer after posting. There is no unbounded postMessage stream and no additional client-side backlog hidden behind the owner queue. Each lane is FIFO for owner event and terminal frames.

Overflow immediately removes matching registration state and unsent events. It sends a small terminal frame without waiting for event credit; callback failure/explicit cancel gets the corresponding terminal or closed control. Keep the one in-flight event's reservation and a bounded retiring slot until the caller processes that control and sends `terminal-ack`. Receipt proves earlier lane frames have been processed or discarded. The caller drops library references before acknowledging, even if an already-running application callback never settles. User-owned references cannot be reclaimed by the plugin.

Both the 32-per-client and 128-per-mount registration limits include these retiring slots across all channels, so a stalled recipient cannot generate an unbounded sequence of terminal messages by repeatedly registering. Even a held registration with no event in flight keeps its retiring slot and control metadata until `terminal-ack` or conclusive disposal; settling the setup response does not prove that a terminal frame on another lane has drained. Do not release in-flight credit merely because a timeout elapsed. Conclusive client/lane disposal or mount destruction releases the retained state; stale acknowledgements remain fenced. Connect cleanup to the existing `watchClient` Web Lock, whose release detects a departed normal client, and to direct channel disposal. If a client is stalled while retaining its lock, reservations remain. One client can exhaust its own 32 slots; all clients together can exhaust the mount cap. Shared record/byte budgets still permit starvation, so this is not a fairness guarantee. Writes remain available.

The memory guarantee concerns owned buffers and bounded managed routes, not JavaScript-engine object sizes, browser internals, arbitrary same-origin listeners, or application code retaining a delivered array. The new lane is necessary for that claim: recipient tags alone would not bound copies in unrelated managed followers.

### Throughput and response-routing follow-ups

The initial protocol has one unacknowledged event per subscription. Test fast-listener bulk imports after fixing burst admission. If bounded transport batching is needed, revise `ChangeFrame` and the specification to one bounded frame with an explicit record/byte ceiling before implementing it. Charge each event, preserve operation versions/order, serialize callbacks, acknowledge only after that frame's callbacks settle, and keep terminal errors independent. Do not hide arbitrary records inside one nominal queue item.

Ordinary follower `RESPONSE` payloads currently fan out on the shared channel. Migrating them to the same typed recipient lane is a separately scoped follow-up, not a prerequisite for v1 subscriptions or S0. It requires generation, cancellation, disposal, and error-response regression coverage. It does not introduce a generic plugin bus or change discovery.

## Implementation layers and review gates

Keep this follow-up separate from the completed encryption refactor. Use repository-local `gh stack` branches and one reviewable concern per layer. These are implementation dependencies, not changes made by this documentation branch.

| Layer | Repository                                 | Concrete change and gate                                                                                                                                             |
| ----- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0    | Core, standalone prerequisite              | Correct shared short-read/write handling, hydration, initialization/zero filling, and persistence with fault-injection coverage. No dependency on subscription code. |
| S1    | Core                                       | Contribution union, dedicated `/changes` types and bridge declaration, validation, profiles, lifecycle disposal; a core test plugin exercises the declarations.      |
| S2    | Core, after S1                             | Bounded logical scopes, mutation recording, whole-file preflight/finalization, inode fanout, independent impact and failure invalidation; direct memory/disk tests.  |
| S3    | Core, after S2                             | Async/SAB integration, normal-client controls, recipient lane, generation fencing, bounded metadata delivery and retirement tests.                                   |
| S4    | Premium, using packed S3                   | Metadata-only owner matcher/ledger, factory, `/config`, `/client`, abort/callback lifecycle and encryption composition. Measure metadata-only capacity/throughput.   |
| S5    | Core, after S3                             | Scoped no-atime capture using S0 checked readers, operation-version tests and capture-failure behavior.                                                              |
| S6    | Premium, after S4 and packed S5            | Shared capture accounting, recipient delivery/relay reservations, completed-operation contents and cross-tab capacity tests.                                         |
| S7    | Premium and existing documentation process | Packed examples, complete browser/load acceptance, docs and distribution gates.                                                                                      |

Every numbered layer is a separate `gh stack` PR; S1, S2, and S3 cannot share a branch. Keep repository-local dependency chains. S0 remains a standalone PR and must land on core `main` before S5 implementation or testing begins. Once S0 has landed, rebase any existing S1 → S2 → S3 stack onto updated `main` with `gh stack rebase --remote origin`. Verify that the commit which landed S0 on `main` is an ancestor of the rebased S3, then rerun the affected core checks before creating S5 above it. Use the landed commit, not the original PR-head SHA, which a squash merge may replace. Do not duplicate or cherry-pick S0 into S5.

After that rebase, core can build S5 while premium validates S4, then premium S6 advances to the verified S5 artifact. S4 is an intermediate development layer, not a complete v1. In S4, omitted `content` or `content: false` works normally; a valid `content: { maxBytes }` request rejects setup with `ENOTSUP` before installing an owner registration and does not call `onError`. Enforce this in the client helper and owner register validation, and test that no registration or capture survives the rejection. Malformed options still reject with `EINVAL`. S6 removes the temporary unsupported-content rejection and replaces its tests with completed-operation content acceptance against packed S5. Completed-operation contents remain mandatory for v1 acceptance.

Do not publish core merely to test premium. Build and pack the selected core commit using the established `pnpm pack` workflow. Update `core-artifact.json` with its exact commit, version, and SHA-256, then run `scripts/prepare-core.mjs` before the first frozen install. Repeat the pin and verification when advancing from S3 to S5. A registry package with the same version is not interchangeable. Build/install the premium tarball beside that verified core artifact for declaration and browser consumer checks.

### Expected file changes

| Existing or new path                                                                    | Purpose                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Core `packages/opfs-vfs/src/plugins.ts`, `plugin-config.ts`, `worker-plugins.ts`        | Contribution shape, claim rules, request/profile validation.                                                                              |
| Core `packages/opfs-vfs/src/changes.ts`, package exports and library build entries      | Closed protocol types and bridge declarations.                                                                                            |
| Core `packages/opfs-vfs/src/opfs-vfs.ts`                                                | One private recorder/scoping implementation beside mutation sites; bounded whole-file helper, private capture and lifecycle connection.   |
| Core `packages/opfs-vfs/src/worker-runtime.ts`, `worker-client.ts`, `index_internal.ts` | Command scope, typed normal-client forwarding, unsolicited frame handling, lane/credit disposal, worker declarations.                     |
| Core `packages/opfs-vfs/src/__tests__`                                                  | Small change-contribution fixture and browser tests using the same supported seam as subscriptions. Reuse storage-fault and SAB fixtures. |
| Premium `packages/plugin-subscriptions/src/{index,config,client,owner}.ts`              | Factory/request, local callback lifecycle, owner matching and ledger. Add internal files only when the implementation needs them.         |
| Premium package manifest, build/declaration config, packed consumer tests               | Main/config/client exports without cross-entry owner imports; exact core dependency pin.                                                  |
| Premium existing docs and core artifact preparation files                               | Consumer examples, package verification, reviewed documentation distribution.                                                             |

No filesystem format, encrypted sidecar, observer protocol, billing system, or server-sync module changes are required.

## Acceptance map

These tests gate implementation, not this documentation-only branch. Use existing Vitest/Playwright suites and fault hooks; do not introduce another test framework. Assert externally observable records, contents, completion timing, errors, and disposal through the proposed interface.

| Issue requirement                                                  | Required evidence                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logical-change contribution and independent encryption composition | A core test plugin mounts with default storage and beside one test storage provider. Two providers and two change contributors reject. Direct instances cannot be reused. Initialization failure, close failure, and replacement each clean up once.                                                                                                                    |
| Factory, request and client entries                                | Packed declarations compile direct and worker examples with strict TypeScript. `/config` and `/client` do not import owner/encryption implementation. Bundled worker rejects requests; inactive capability rejects registration; custom worker rejects malformed and unknown fields.                                                                                    |
| Matching                                                           | Exact path and missing targets, immediate/recursive directories including root itself, `/notes` versus `/notes-old`, every nonempty event combination, regex `g`/`y` repeated-path determinism, symlink ancestors and missing ancestors that later become links.                                                                                                        |
| Mutation coverage                                                  | Create, append/write, zero write, truncate/no-op, explicit mode/times, hard-link create/delete and update fanout, rename replacement, subtree moves/removal, symlink entry/target distinction, unlinked descriptors in memory and disk modes.                                                                                                                           |
| Operation scopes                                                   | Direct nested `open(O_TRUNC)`, recursive mkdir/remove, async/SAB commands, and representative PGlite/just-bash/Wasmer paths produce no duplicate nested records. Adapter multi-command behavior matches the documented low-level distinction.                                                                                                                           |
| Whole-file completion                                              | Create emits one final create; overwrite emits one final update per live name after truncation; update-only filtering ignores new-file internal writes. Expected-content mismatch emits nothing. Append content is complete. Captures happen before direct return or worker/SAB success acknowledgement.                                                                |
| Versioned payloads                                                 | Queue writes `A`, `B`, then delete/recreate while delivery is held. Included bytes remain `A`, `B`; a listener's later ordinary read sees current state. Do not accept a test that supplies bytes by an extra read command at delivery.                                                                                                                                 |
| Partial failures and short writes                                  | Exercise direct, asynchronous worker, and SAB routes with fault-injected disk short count, zero progress, partial overwrite throw, recursive mkdir failure, and whole-file truncate failure. Successful short results reflect actual state; thrown partial changes produce resync and preserve the original error. Unchanged validation failures emit nothing.          |
| Content policy                                                     | Instrument reads to prove metadata-only performs none. Verify 16 MiB and per-listener size limits, empty files, normal path/read permission checks including hard links, short-read retry and zero-progress/invalid-count omission, no atime/dirty/persistence changes, and isolated delivered arrays.                                                                  |
| Registration race and reentrancy                                   | Place mutations before registration, between registration and acknowledgement, and between resolution and activation. Assert no callbacks before resolution, no post-registration loss, abort at every setup step, late acknowledgements, reentrant writes, serial async listeners, independent listeners, contained error handlers.                                    |
| Bounded transport                                                  | Hold callback completion and worker/page/follower delivery separately. Fill count, content, metadata, aggregate, staging, and registration limits. Assert reservation before allocation, one unacknowledged event, terminal bypass, retiring credit retained until acknowledgement/disposal, and no content on shared discovery channel.                                |
| Multi-tab lifecycle and profiles                                   | Same-profile clients observe each other's writes; unequal profiles reject; one follower closes without affecting others. Owner crash/takeover and replacement interrupt, fence old events/acks, and require explicit fresh subscription. Existing observer restrictions remain.                                                                                         |
| Packed and browser integration                                     | Build core, run relevant core suites, pin/prepare its tarball, build premium, run existing packed checks plus subscription consumers against installed tarballs. Run real Chromium using the current cross-origin-isolated setup; run Firefox/WebKit when supported by the repository's test setup and record unsupported configurations rather than claiming coverage. |
| Load and inactive cost                                             | Compare no plugin, active metadata-only, and content-enabled mounts in both buffer modes. Report write latency, snapshot bytes/copies, queued/reserved high-water marks, and overflow behavior with a held listener. Inactive runs allocate zero subscription records and read zero snapshot bytes. All active high-water marks remain within the specified limits.     |
| Documentation and distribution                                     | Examples compile from docs against packed artifacts. Publish through the public workspace Changesets release process under the repository PolyForm Noncommercial License. No invented access, pricing, contact, or server-sync promise.                                                                                                                                 |

### Capacity and performance gates

Run the following with otherwise empty queues and bounded paths/configuration, checking every simultaneous record, content, metadata, and registration limit:

- Two follower subscriptions each retain two successive 16 MiB versions before delivery. Each receives A then B, including after a later deletion. Assert 32 MiB logical content per subscription and 128 MiB of held delivery and relay reservations, with one capture per operation/inode released when completion returns. Verify content isolation and release when recipients finish or terminate at different times.
- Two metadata-only recursive subscriptions receive a removal with more than 256 records, a subtree rename producing more than 256 final records, and a supported operation at the 4,096-record staging ceiling. Assert no overflow with the proposed 16,384-recipient-record and 16 MiB metadata budgets. Include all configuration and retirement charges. Long-path metadata overflow remains explicit rather than silently unbounded.
- Exceed staging with known rename/removal roots while a recursive `/` watcher and an unrelated `/settings.json` watcher are active. The root watcher terminates with `SUBSCRIPTION_OVERFLOW`; the unrelated watcher survives. Verify subscription-first recovery without claiming an atomic live handoff. Exercise hard-link fanout beyond the impact budget and a later nested mutation after staging stops; incomplete impact coverage must fall back to all.
- Exercise current-view loading and recovery with writes after registration but before scanning, during scanning, and while the same path is being reread. The application listener returns promptly, invalidations remain bounded, and one serialized updater preserves arrivals during pending reads. Verify reconciliation reads current state instead of replaying older payloads over a newer scan, and that overflow, interruption, or read failure abandons the candidate. Late results from an abandoned attempt cannot overwrite its replacement. An empty local buffer is not a transport barrier.
- Hold one client's callbacks and delivery lane, then run another client's fast listeners. Assert 32 registrations per client across multiple channels and 128 across the mount, including retiring slots. Record shared-budget starvation honestly; do not infer fairness from registration caps.
- Run 10,000 separate small-file commands from an owner-local `OpfsVfsWorker` producer while a different tab is a follower with a fast subscriber. Await each write command's completion before sending the next, without waiting for subscription callbacks. This required topology lets the producer progress without the follower command round trips that would otherwise throttle it, while event acknowledgements still traverse the follower route. Compare the same workload with direct producer/subscriber, owner-local producer/subscriber, and follower-producer baselines. Record producer rate, acknowledgement latency, peak queue/byte charges, callback lag, and overflow. The owner-local-producer/follower-subscriber case must complete without overflow from protocol round-trip overhead alone. If it fails, revise and review the bounded-frame protocol and rerun before accepting v1; do not weaken the gate by waiting for callbacks between writes.
- Fault-test shared I/O with subscriptions disabled: positive short progress, zero/invalid counts, throws, ordinary reads, hydration/reopen, sparse holes, zero filling, and dirty-page persistence. With subscriptions enabled, distinguish predictable preflight rejection with no namespace change from physical failure requiring resync. Capture failure must still omit bytes without failing a successful mutation.
- Measure `chmod`/explicit timestamp updates with content enabled. V1 retains their snapshots; adding a discriminator or skipping capture requires a separately reviewed contract change.

The proposed 32 MiB per-subscription and 192 MiB mount content ceilings are capacity candidates, not measured performance claims. Before accepting them, record capacity and load measurements on at least one physical mobile device running mobile WebKit or Android Chrome, in addition to desktop measurements. Desktop browser emulation does not satisfy this requirement. Include the two-follower A/B case, the owner-local-producer/follower-subscriber import, and held deliveries near the proposed ceiling followed by cleanup. Record device model, OS/browser versions, workloads, write latency, copy allocations, reservation high-water marks, tab/worker termination, and recovery behavior. Record actual memory measurements where the platform exposes them; reserved bytes alone do not establish physical memory use or tab stability.

If the device or required topology cannot be tested, the mobile gate remains unverified. If the proposed ceilings are unsuitable on mobile, revise the fixed defaults and their capacity promises together and rerun the gates before v1 acceptance. Do not silently lower limits through device detection or add an unreviewed configuration interface. No documentation-only check establishes these runtime results. Initial enumeration and atomic live handoff remain separate future work.

## S7 implementation update: S3 and S5b corrections

This section updates the reviewed baseline without removing its detailed seam, ordering, partial-failure, whole-file, adapter, or acceptance requirements.

### Transport and accounting

The normal-client route is core-stamped and immutable. `local` identifies direct and owner-local clients; `follower-relay` identifies verified followers and drives S6's extra relay reservation. The core registration ledger is separate from subscription record/content accounting. Its 32/client and 128/mount slots span setup through retirement, and release only on definite setup failure, terminal/closed completion with the required acknowledgement where applicable, or conclusive disposal.

The existing worker/relay transport has an implementation guard of 32 queued control envelopes per client across channels and one executing control per channel. It is not a separately configurable or public capacity promise. Its 16 MiB owner relay-control guard and 16 MiB per-local-client pre-admission/in-flight guard are additive to the subscription 16 MiB owner metadata ledger. They charge retained strings before copying/queueing. Required release controls either enter or dispose the channel. S7 reports their high-water separately; it does not present subscription metadata as an all-inclusive control-memory measurement.

### Content ownership and failure cleanup

S5b narrows the core ownership seam instead of adding a buffer manager. S5 source capture bytes are borrowed and may be internally shared only after literal-path authorization. S6 reserves before it copies a full ordinary ArrayBuffer-backed delivery view for each recipient, and one extra view for each follower relay. `send` consumes that view. No contributor may read or write the sent view or any alias afterward. Core validates shape and attachment without copying; the runtime transfers owned included views only. Direct delivery uses the existing deferred reference path, while BroadcastChannel creates the reserved relay clone. The shared source capture never transfers.

On an included-frame post failure, the runtime closes/releases itself and the core channel before one nonrecursive metadata-only interruption attempt. Cleanup survives a failed interruption post. The owning mutation remains successful and unaffected sibling channels continue. S7 retains direct isolation, owner/follower relay-copy, invalid-view, post-failure release, and captured A/B source-integrity evidence.

### S6/S7 status and acceptance reporting

S3, S5, and S5b have implementation evidence in their reviewed core stack. S6 implements the subscription shared-capture, reservation, and content layer; S7 consumes its exact verified core artifact, compiles examples against installed tarballs, and records the asserted, inferred, and unverified acceptance gates.

The current-view example uses the reviewed subscription-first algorithm: bounded invalidations during scan, a serialized reread updater that reads a candidate before replacing a path or subtree, `ENOENT` deletion, and an attempt fence after every awaited read. Overflow, terminal, and non-`ENOENT` read failure abandon the candidate and require explicit restart. Historical content is never a current-state upsert.

Reports distinguish measured harness values from inferred calculations and unavailable values. The two-follower/two-16-MiB case holds 128 MiB of reservations, asserted by the owner unit test; it is not a measured allocation peak. Desktop Chromium does not close the physical-mobile condition. Without a real WebKit or Android Chrome device run, S7 records the device gate as **unverified** and makes no publication claim.

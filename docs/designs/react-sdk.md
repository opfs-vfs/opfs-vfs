# React SDK design

Status: proposed implementation design, September 26, 2026. No SDK implementation is included. This document turns the [specification](../specs/react-sdk.md) into module responsibilities, state transitions, and testable contracts. The [research note](../research/react-sdk-patterns.md) records the external precedents. Repository observations use core `5bddbcc` and premium `dd24f15`.

## Decisions

Build `@opfs-vfs/react` around the existing async worker client and subscriptions plugin. Use React context for volume lookup and `useSyncExternalStore` for changing state. Keep writes as promises used by React Actions or ordinary event handlers. Do not add TanStack Query, Effect, a mutation engine, or another filesystem event protocol.

The first stable release includes explicit loading/error hooks, render callbacks, managed and borrowed providers, persistence requests, and premium plugin compatibility. Defer Suspense exports until a separate lifecycle experiment passes the gate below. This keeps the first release from depending on an unproved render-time read cache. Suspense remains a planned addition, not an implicit promise of v1.

Use React `>=19.0.0 <20` as the proposed peer range. Test 19.0.0 and the latest stable 19.x at release. Core and subscriptions versions must include the prerequisites in this design. Select their actual published peer/dependency ranges from installed-consumer tests before release, without inventing future version numbers. Ship one community package with no premium import; use the real private encryption plugin in its separate integration test.

React, core, and subscriptions are peers of the SDK, with workspace/dev dependencies for development. The application supplies subscriptions to both its worker and the SDK page client. Verify the actual resolved core/subscriptions artifacts on both sides; peers and a matching plugin compatibility key do not by themselves prove wire compatibility.

## Responsibilities and dependency direction

| Part                          | Owns                                                                                     | Does not own                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Core worker/client            | Capability checks, lifecycle status, safe error transport, generation checks at dispatch | React, query caching, credential UI                  |
| Existing subscriptions plugin | Bounded logical mutation delivery and terminal errors                                    | Initial reads, automatic recovery, React lifetimes   |
| SDK volume binding            | Context lookup, managed client retention, generation changes, reporting                  | Filesystem semantics or election                     |
| SDK resource store            | Active reads, shared root watch, reread scheduling, stable snapshots                     | Writes, transactions, persistence grants             |
| React hooks/components        | External-store subscriptions and typed results                                           | Another cache or observer implementation             |
| Persistence helper            | One page-local browser grant state/request                                               | Filesystem synchronization or per-volume permissions |

Keep these as internal modules in `packages/react/src`, initially `volume.tsx`, `resources.ts`, `errors.ts`, and `persistence.ts`, with a small public entry. Split only when implementation needs it. Components call the same hooks; the resource store has no React dependency. Core additions stay in the existing worker/client, error, and filesystem modules. No generic service container or adapter interface is needed.

## Public contract

The types below establish behavior, not a replacement for core declarations. Reuse core option, stat, and method types. Export only the symbol, provider, six ordinary hooks, three read components, and their public types in v1.

```ts
export const DEFAULT_VOLUME = Symbol('opfs-vfs.default-volume');
export type VolumeName = string | typeof DEFAULT_VOLUME;

type SharedProviderProps = {
  name?: VolumeName;
  persistentStorage?: 'manual' | 'request-on-mount';
  onError?: (error: VolumeError) => void;
  children: React.ReactNode | ((volume: VolumeResult) => React.ReactNode);
};

type VolumeProviderProps = SharedProviderProps &
  (
    | {
        fileName: string;
        worker: VfsWorkerFactory;
        plugins?: readonly VfsPluginRequest[];
        options?: ManagedOptions;
        client?: never;
      }
    | { client: OpfsVfsWorker; fileName?: never; worker?: never; plugins?: never; options?: never }
  );

type ReadOptions = { volume?: VolumeName; enabled?: boolean };
type ContentOptions = ReadOptions & { format?: 'bytes' | 'text'; limit?: number };

type ResourceState<T> =
  | { status: 'idle' | 'pending'; data: undefined; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: T | undefined; error: VolumeError };
type ResourceResult<T> = ResourceState<T> & {
  isRefreshing: boolean;
  isStale: boolean;
  refresh(): Promise<void>;
};
```

`ManagedOptions` excludes `worker`, `plugins`, and `attachTo`. Passive attachments cannot support the required custom plugin worker. Other accepted fields retain core defaults, including `noatime` and `openMode`. Compare a documented allowlist of normalized core fields, including omitted defaults; reject unsupported fields. Core should expose/reuse its option validation and basename validation rather than have React duplicate them. Plugin options remain opaque construction data. Validation exceptions must not include their contents.

Keep `useVolume(name?)`, `useVolumeClient(name?)`, `useFolder(path, options?)`, `useFile(path, options?)`, `useFileContent(path, options?)`, and `usePersistentStorage()`. `Folder`, `File`, and `FileContent` add `path` and `children(result)` to the matching options. Content overloads return `ResourceResult<Uint8Array | null>` for omitted/bytes format and `ResourceResult<string | null>` for text. Text is UTF-8 using `TextDecoder` with replacement for malformed input; the limit applies to bytes before decoding. Default limit is 16 MiB; reject noninteger, negative, or larger limits before I/O. Zero is allowed for empty-file checks.

`FileInfo` uses exactly the six fields in the spec. A missing file is successful `null`; a missing folder is an error. Folder listing uses `readdirEntries`, file metadata uses `stat`, and content uses one `readFileBuffer` command, without a stat-then-read race. All preserve core path/link semantics. Resource keys use the caller's validated path string, not a new normalization algorithm. Two spelling variants may occupy separate resources.

### Lookup and provider stability

Each context value is an immutable link containing `{ name, binding, parent }`. Walk to the nearest matching key. An omitted selector is `DEFAULT_VOLUME`, even under a named provider. Strings are exact, nonempty keys; the string `default` differs from the symbol. Reject other symbols. Missing providers throw during render and are catchable by the application's error boundary.

Each provider creates a local inert binding during render. Context links remain stable unless the alias or ancestor link changes; file events never replace them. `getSnapshot` only returns cached state. The binding acquires a client after commit, so abandoned renders create no worker, registry entry, watch, or persistence request. The server snapshot and first hydration snapshot are the same pending constant. Server imports perform no browser access.

Changing `name` changes lookup only. A physical filename, normalized non-secret option, or borrowed client change requires a keyed remount; detect and throw a configuration error rather than reopen during render. Ordinary equivalent option literals are allowed. Treat the worker factory and opaque plugin `options` as construction-only; do not compare their identities or contents on rerender. Inline worker factories are supported. The first committed acquisition supplies them to core. Later factories/options on a compatible retained entry are ignored, including after a keyed remount. Replacing a live client's worker or credentials requires explicit close followed by a fresh mount; a failed entry follows the retry rule below.

### Volume result and operation handle

`VolumeResult` has `status: pending | ready | recovering | unsupported | error | closed`, normalized `error`, `missingCapabilities`, `role`, `generation`, `persistence`, `isClosing`, and `ownership: managed | borrowed`. A generation is an opaque SDK token combining local client lifetime with core owner generation; callers can use it as an editor key. Unavailable fields are `null` or empty arrays consistently, never leftovers from an earlier generation.

Managed results expose `close(): Promise<void>`; borrowed results do not. There is no volume `retry()` method. After terminal initialization failure or unsupported detection, dispose partial resources and remove the reserved entry before publishing the terminal snapshot. Existing bindings retain the error; a keyed provider remount is an explicit new attempt with fresh inputs. This also applies to terminal takeover failure. Borrowed failure requires caller replacement. A successful retained managed client still needs explicit close before replacement.

For example, the credential form prepares a new encryption request and increments the provider key after `EVOLUMELOCKED`. The remount acquires a fresh entry, without calling close on the failed volume or reusing the rejected secret. Publication of the retry-ready error and registry removal must be atomic from the page's perspective; an immediate remount must not encounter a cleanup reservation containing the old inputs.

`close()` starts a local close, invalidates handles and clears read caches immediately, then awaits core `closeVfs()`. It rejects if synchronization fails, also retaining that error in closed state. The application must catch it. Repeated close calls share the same promise. Close during initialization uses the new core cancellation path described below, with independent readiness and cleanup settlement. No successful save is inferred from disposal.

`useVolumeClient` returns `null` outside ready or during close, otherwise the same `VolumeClient` object for the generation. Construct an actual object containing only these bound async methods:

- `readFileBuffer`, `writeFileBuffer`, `stat`, `lstat`, `readdirEntries`, `readlink`, `realpath`.
- `mkdir`, `unlink`, `rmdir`, `remove`, `rename`, `renameNoReplace`, `truncate`, `chmod`, `utimes`, `link`, `symlink`.
- `sync`.

Each signature is the corresponding core signature. No proxy to arbitrary methods, descriptor I/O, synchronous method, plugin transport, or lifecycle control. Use core's buffer-preserving whole-file write. Do not add automatic sync or optimistic cache updates. Each command is independent; the write-then-sync Action in the spec remains the application pattern. Capture the handle and inputs when dispatching an Action, including queued Actions; key Action state by `generation`.

## Managed lifetime and ownership

Use a module-local `Map<fileName, ManagedEntry>` for one JavaScript realm and one installed SDK instance. The SDK owns at most one managed client per basename. Separate React roots share it. A second bundle copy has a different `DEFAULT_VOLUME` and registry; require a single resolved SDK copy and document this packaging constraint. No `Symbol.for` or global registry is needed.

An entry stores frozen public configuration, initialization/close promises, a client, its generation state, and committed binding references. Compare normalized public core options, not worker function identity. Compare plugin ID, contract version, compatibility key, and required open mode, with a deterministic plugin ordering; never compare or fingerprint plugin options. Append the subscriptions request once, validating any supplied request and rejecting duplicates. Actual owner profile compatibility still belongs to core. Core retains the original factory and prepared plugin options for takeover; the SDK drops its temporary construction-input references immediately after handing them to core, including failure paths. It keeps no second credential copy for retry. An ignored alternate factory is never instantiated or validated by profile negotiation; matching declared profiles are not proof that two factories contain identical code.

Acquisition runs synchronously inside the committed effect up to entry reservation, then initializes asynchronously. This prevents two effects from creating two clients. Strict Mode cleanup releases the binding reference; immediate setup reacquires the same entry. Ignore old effect completions using a binding attachment token. Unmount never implies orderly close.

| Event                             | Managed entry                                            | Binding/read behavior                                                                 |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| First committed acquisition       | Reserve entry, feature-check, construct once             | Pending until core ready                                                              |
| Compatible alias/root acquisition | Reuse entry, including pending initialization            | Observe the same generation                                                           |
| Conflicting public configuration  | Keep current entry untouched                             | Store a configuration exception and throw it on the next provider render, no fallback |
| Last provider unmount             | Retain client; only core retains private takeover inputs | Drop SDK read resources and detached binding listeners                                |
| Initial mount failure             | Dispose partial client, evict, then publish error        | Error tombstone; keyed remount uses fresh inputs                                      |
| Owner loss, client still viable   | Core negotiates replacement                              | Recovering; clear old bytes/handles                                                   |
| Ready replacement                 | New generation                                           | Recreate root watch before active reads                                               |
| Explicit close                    | Mark closing; synchronize and dispose                    | Clear all aliases; closed even if flush fails                                         |
| Close settles                     | Remove entry only if map still refers to it              | Existing bindings remain closed tombstones                                            |
| New keyed mount after close       | Reserve fresh entry                                      | New lifetime and credentials                                                          |

A new provider encountering a closing entry binds to its closed outcome; it never queues an automatic reopen. Once removal completes, a deliberate remount opens fresh. Existing closed or failed bindings must not silently bind to a subsequently opened client. On terminal close/failure, drop the entry's client and any remaining SDK-owned input references even if bindings remain mounted. Keep only the terminal snapshot and public identity. Remove a registry entry only if the map still refers to that exact entry. Provider props and application copies remain the caller's responsibility.

Borrowed providers share a resource store through a `WeakMap` keyed by actual client identity. They never assume ownership, even if that object also belongs to a managed entry. The same client object gets the same store in both forms. Different borrowed clients for the same basename remain distinct client stores and use one watch each. SDK managed sharing cannot prevent independently constructed clients outside its registry. Core remains responsible for their ownership negotiation.

Last provider unmount clears unused read caches, but retaining a managed client can retain a worker, shared memory, and prepared credentials. Document this cost. Applications that need to release them should call and await managed `close()` before removing their last provider, or use caller-owned borrowed clients. Do not add another global close manager in v1.

## Core changes required first

These are additive core work, separately testable before React. They apply to normal async clients and their custom workers. Existing synchronous APIs keep their signatures and behavior.

### Mixed-build compatibility

Before changing wire envelopes, define readiness/init capability negotiation on the existing channels. A new client rejects missing required capabilities before ready with `VFS_PROTOCOL_MISMATCH`, surfaced as a reload/update error. Missing negotiation fields identify a legacy peer; they do not establish compatibility. For new owners serving old clients, preserve tested legacy reply shapes or refuse through a path the frozen legacy bootstrap understands, such as its existing profile mismatch check. An old client cannot be promised a newly introduced error code, and an ignored extra field cannot enforce rejection. No compatibility failure may silently reroute to a separate owner or volume.

Record the supported matrix and chosen bootstrap in this design during P1a, then test exact old/new core and subscriptions artifacts in both owner/follower directions, cached page/worker combinations, and takeover. Unsupported pairs must fail before ready instead of losing strict-validator responses until timeout. P1c and P1d must recheck this policy as their contracts change. This is a compatibility gate for changed messages, not a replacement generation or filesystem-event protocol.

#### Implemented bootstrap

The existing INIT reply `profile` and `LEADER_READY` `profile` are the bootstrap. New builds send MountProfile version 2 with `capabilities` (`error-details` and `persistence-status`). A new client requires every capability it knows, accepts extra capabilities, and otherwise rejects `ready`, disposes, and fails before timeout with `VFS_PROTOCOL_MISMATCH`. Legacy clients reject version 2 through their existing `VFS_PLUGIN_MISMATCH` path before ready. INIT payloads remain unchanged, so a legacy worker never receives new fields. The worker sends persistence only after a `PERSISTENCE_STATUS` request for its generation. Worker transitions are coalesced per event-loop turn. Transitions while handling a command ride its reply; others use `PERSISTENCE_FRAME` after the turn. The leader requests after the profile check and, after a follower sends `PERSISTENCE_REQUEST`, forwards accepted frames on its next relayed response or one task-coalesced broadcast; receivers accept only higher sequences for the current owner generation. A follower's request carries an id, and until the reply tagged with it arrives the follower accepts no other frame. Resume nulls the value and resyncs: a follower renegotiates through `LEADER_PING`, and a leader waits for the reply to a new worker request.

| Pair                               | Result                                 | Error code              |
| ---------------------------------- | -------------------------------------- | ----------------------- |
| Legacy owner / new follower        | Refused before ready                   | `VFS_PROTOCOL_MISMATCH` |
| New owner / legacy follower        | Refused before ready                   | `VFS_PLUGIN_MISMATCH`   |
| New page / legacy worker bundle    | Refused before ready                   | `VFS_PROTOCOL_MISMATCH` |
| Legacy page / new worker bundle    | Refused before ready                   | `VFS_PLUGIN_MISMATCH`   |
| Sequential ownership across builds | Supported after the prior owner closes | —                       |
| Both new                           | Supported                              | —                       |

Version 1 has no mixed-build interoperability; tell users to reload and close older tabs using the volume. `SHUTDOWN_LEADER` takeover is deferred. Passive observer attachments (protocol 1, devtools only, not used by the SDK) are outside this negotiation. P1c/P1d must add their capability names and rerun `pnpm --filter @opfs-vfs/opfs-vfs test:mixed-build`.

### Observable status

First expose local client lifecycle through `client.getStatus()` and `client.subscribeStatus(listener): () => void`, with no new wire protocol. File name, opening/readiness, role, owner generation, routing loss, failure and disposal are already known in the client. Add closing notification with the separate close fix. Keep `persistence: null` until the later owner-persistence work lands. Snapshots are immutable and reference-stable until a meaningful change. Subscribe before reading a snapshot and recheck after subscription, as required by external stores.

```ts
interface ClientStatus {
  readonly fileName: string;
  readonly state: 'opening' | 'ready' | 'recovering' | 'closing' | 'failed' | 'closed';
  readonly role: 'leader' | 'follower' | null;
  readonly ownerGeneration: string | null;
  readonly error: RemoteErrorDetails | null;
  readonly persistence: null | {
    readonly state: LocalPersistenceState;
    readonly lastError: RemoteErrorDetails | null;
    readonly failureRevision: number;
    readonly lastSalvage: DataWalSalvageEvent | null;
  };
}
```

The readonly `fileName` identifies borrowed clients through a public contract; never reach into their private fields. The later persistence projection includes only state, last error/revision, and salvage. It omits dirty-page counts, flush/checkpoint timestamps, and pending-byte scans. `persistence: null` means the current owner state is unknown; no separate freshness field is needed. It is a reported owner state, not a command-specific durability receipt. Preserve the last failure and its increasing revision for that owner generation even if a later dirty/clean transition happens before delivery. Current `LocalPersistenceStatus.lastError` clears when leaving error; the new observable projection needs its own retained failure field so coalescing cannot erase a background failure. A successful later sync changes state but does not rewrite failure history. The UI uses state plus revision, not mere error presence, to describe current persistence.

Wire local status notifications into the existing mount, role, routing invalidation, failure, and disposal transitions. React listeners do not determine whether core notices these events. The provider, command handles, and cache invalidation can use this local snapshot before persistence transport is implemented.

Owner-persistence observation is a separate prerequisite PR. Add compact versioned persistence frames over the existing worker and owner/follower channels, with owner generation and increasing sequence. Publish an initial persistence snapshot during readiness negotiation or on request, then subsequent meaningful changes. Initial snapshot plus sequenced updates must not miss the subscribe/read race. Reject old-generation or out-of-order frames. Coalesce worker transitions per event-loop turn. When a command causes a transition, attach the frame to its reply. Otherwise post it after the turn, while retaining the most recent failure revision. Observe persistence state, retained failures, and salvage at their source, including swallowed pagehide/timer failures and SAB operations. Do not serialize the whole local lifecycle, calculate dirty-page counts on each write, or change storage scheduling. No new periodic polling or per-operation metrics.

Unknown readiness/owner status, routing loss, and page resume set `persistence` to null until a current-generation resync arrives. Retain no old-generation persistence data. A sleeping follower cannot promise immediate loss detection; on return, resync through existing owner negotiation, invalidate handles while recovering, and then revalidate reads. Document this observation limit rather than invent a heartbeat service.

Map opening to pending, failed to error, and closing/disposed to closed, with `isClosing` true only until cleanup settles. Unsupported is the SDK's pre-construction feature-check result. A subscription failure affects read resources, not the core volume's readiness. A ready volume can therefore have failed live queries and still support explicit user commands.

`getSupport()` reports page-detectable prerequisites without allocation or I/O. Worker initialization checks worker-only sync access handles. Browser presence tests do not guarantee permissions or a successful mount.

### Commands bound to a generation

Add a core `client.forGeneration(ownerGeneration)` method returning the same narrow async path-method set as `VolumeClient`. It captures the client object and expected owner generation. The SDK wraps its errors and assigns the SDK lifetime token; it does not reimplement command serialization. Use shared existing method bodies/argument preparation with an explicit dispatch context, avoiding a second mapping from public methods to wire commands.

Reuse the existing generation-bearing relay field, `sendToWorker(..., generation?)` checks after readiness awaits, leader-side relay validation, response-generation validation, and pending-request rejection in `invalidateRouting()`. Descriptor generation tracking already exists and remains outside this facade. These are existing protections to preserve, not a new relay protocol.

The missing link is the caller-captured owner generation on an ordinary follower command. Make the first dispatch comparison role-aware, against `this.isLeader ? this.generation : this.leaderGeneration`; it currently compares only the client's private `generation`, which is wrong for a follower's captured owner token. Thread the captured token through `sendToLeader` and its existing wire `generation` field instead of substituting the latest discovered owner. Preserve/reuse the existing checks after awaits and before owner dispatch, plus response/liveness validation. Add close-admission checks from step 1b at those same boundaries. A new owner identity invalidates old handles; no duplicate validation or command serialization framework is needed.

Generation loss after a mutation was sent rejects as potentially applied; it cannot undo the mutation. A response which completed and resolved before loss remains a completed command. An old handle cannot issue the next command against the successor. Read responses from ended generations are discarded. No command is replayed because of takeover, timeout, React retry, or boundary reset.

### Close admission and initialization cancellation

Core must synchronously stop public command admission when local close starts, before its first await. Check this barrier at every dispatch boundary, including commands that entered earlier and are still awaiting readiness. Keep a private path for the close/flush barrier; normal methods must not bypass the gate. Publish closing status immediately so borrowed providers also invalidate their data and handles. A follower flushes the captured owner and disposes locally; it must not move its closing flush to a replacement owner. Commands already sent remain subject to their completion/uncertainty contract.

Current follower `closeVfs()` flushes before disposal without closing admission, so this requires a core change. Also fix readiness settlement independently of shutdown: if close occurs after election acquires leadership but before worker initialization completes, reject pending public readiness/commands as closed and release acquired resources. The implemented interpretation rejects public `ready` immediately during an in-flight INIT, then settles close on that INIT response, with late success receiving orderly cleanup and late failure resolving close, bounded by the INIT deadline. It does not terminate the worker mid-mount. A late successful worker initialization must be disposed through the initialization cleanup path without awaiting the public `ready` promise it can no longer resolve. If initialization reached a writable mounted state, perform its supported orderly cleanup; report any failure and dispose in all cases. Test no leaked worker, lock, or unresolved readiness/close promise. Do not claim that cancelling initialization rolls back storage creation or recovery already performed.

### Structured errors and dispatch evidence

Extend both serializers and reconstruction paths in [worker runtime](../../packages/opfs-vfs/src/worker-runtime.ts), [worker client](../../packages/opfs-vfs/src/worker-client.ts), and the SAB path. Define one validated `RemoteErrorDetails` envelope containing bounded `message`, optional `name`, `code`, `errno`, corruption `category`, and numeric `offset`. Do not send stacks, arbitrary causes, raw option objects, or enumerable properties wholesale. Preserve the current sanitized plugin-validation message and code before creating the envelope.

Async command failures also carry local dispatch evidence: definitely refused before send, sent but completion unknown, or unavailable. The implemented per-invocation `VfsCommandError.dispatch` states are `refused | sent | replied`. The SDK maps `refused` to `not-applied`, `sent` on a mutation to `possibly-applied`, and `replied` or no `VfsCommandError` to `unknown`; only `forGeneration` calls carry this evidence. Keep it separate from remote error details and attach it per invocation, not to a reused Error instance. A synchronous postMessage rejection before delivery is a pre-dispatch refusal. Once sent to the owner, treat lost responses conservatively even if the worker might not have received them. Do not infer application from error names or codes. SAB error details can share the envelope without claiming dispatch evidence the synchronous transport cannot prove.

The SDK `VolumeError extends Error` contains `kind`, `operation`, physical `volume` basename or `null` when no volume is selected, optional `path`, the preserved details, and `outcome: not-applied | possibly-applied | unknown`. Kinds are `configuration`, `unsupported`, `filesystem`, `conflict`, `quota`, `corruption`, `encryption`, `lifecycle`, `subscription`, `persistence`, and `unknown`. Use an explicit code mapping with an unknown fallback. Missing-file handling is decided by the read hook, not by swallowing every filesystem error.

Only proven before-send refusals get `not-applied`. A mutating command with a known send and unknown completion gets `possibly-applied`. Remote execution failures remain `unknown` unless their existing contract proves more; partial mutation is possible. These labels describe one command. A multi-command Action retains its own save error and cannot inherit a later command's `not-applied` claim.

Validate envelopes at every trust boundary, including follower relay and status frames. Update strict allowed-key validators where necessary; merely adding fields to the serializer would otherwise cause messages to be dropped. Test sanitized plugin failures through leader, follower, initialization, subscription, and SAB routes.

## Live resource algorithm

Each client store owns a generation token, a root-watch session, an active-resource map, and cached volume status. A resource key includes generation, read kind, exact path, format, and limit. Client identity already scopes the map; aliases do not enter its key. Resource records hold subscriber references, immutable result snapshots, an in-flight read token, a dirty bit, and settled-attempt waiters. No historical event queue or inactive content LRU.

### Render, subscribe, and release

A hook creates only an inert local subscription adapter during render. `getSnapshot()` looks up the current resource or returns a stable pending/idle snapshot; it neither inserts a shared entry nor starts a read. Its subscription function, called after commit, observes binding lifecycle as well as resource state, acquires the shared resource when ready, attaches the listener, rechecks the snapshot, and schedules work. Binding initialization or generation replacement therefore moves an already mounted hook to the current store even if it first subscribed while pending. Concurrent committed consumers select the same record. An abandoned render has nothing shared to clean up. Include binding attachment/generation in adapter identity so changing path or volume never returns a previous key's data.

Disabled reads return idle with no watch. They do not expose retained data, and `refresh()` is a resolved no-op while disabled. Pending volume initialization produces pending reads; unsupported, failed, or closed volumes produce a corresponding read error without I/O. During recovery, clear old data and remain pending until a ready generation exists. Validate configuration even when disabled.

The first active read starts one recursive `/` subscription using `content: false`. Await `subscribe()` resolving registration before scheduling initial resource reads. The owner already buffers changes in the held registration. The existing plugin activates delivery in a later task; an activation failure invalidates this watch through its terminal-error path. Do not describe the resolved registration promise as an activation or atomic-snapshot barrier. A second resource joins this watch and is independently marked dirty. The last active resource unsubscribes and releases cached data. Mark disposed records invalid immediately; their in-flight reads may complete but cannot publish. A registration that resolves after last release must unsubscribe immediately. Strict Mode can request reacquisition while teardown is pending; coalesce that request and await the retirement completion described next before registering its replacement. Bound the store to one registered or retiring root at a time.

Provider unmount does not delete resources still used through another alias/root. The store's status listener remains while a provider/read binding needs it and clears caches on external borrowed disposal as well. The retained managed client continues core lifecycle tracking without keeping React query data alive.

### Acknowledged watch retirement

The current plugin's `unsubscribe(): void` stops local callbacks but does not confirm owner-side capacity release. Add a readonly `Subscription.closed` promise, keeping `unsubscribe()` synchronous and idempotent. The promise resolves to `{ status: 'released' }` after the owner processes terminal acknowledgement or the old owner generation is definitively gone. It resolves to `{ status: 'unknown', error }` if transport failure/timeout prevents confirmation. It never rejects merely because the consumer ignored it. This is an additive client contract over the existing cancel/terminal-ack replies, not a new event protocol.

Do not resolve released when the local entry is removed, a channel is merely closed locally, or the owner has only acknowledged cancel: retiring reservations still count until terminal acknowledgement. Retain only the small completion state needed to track that acknowledgement. Subscription setup failure must also settle its internal retirement before a retry can allocate another registration, even when no public handle was returned. Each source's plugin client must serialize this cleanup with subsequent registrations or expose its failed cleanup to them; the React layer cannot recover an unreturned handle.

The SDK waits for `closed` before replacing its root watch in the same generation. Unknown retirement blocks further SDK watch registration for that client/generation and exposes an actionable subscription error; manual refresh cannot override this safety stop. The application must close/replace the client, or core must establish a new owner generation, before automatic observation can resume. Existing explicit filesystem commands remain available if the client is otherwise ready. This bounds stale registrations without retrying forever or adding a polling service. Test delayed/lost terminal acknowledgements and rapid release/reacquisition. Include this additive plugin contract in step 1d and its compatible-version requirement.

Provider-scoped watches would reduce read-navigation churn but would still retire on provider unmount and overflow. Repeated replacements can exhaust the plugin's 32-per-client or 128-per-mount reservation limits if acknowledgements lag or disappear; there is no proved maximum of two. Keep the active-read lifetime and acknowledged retirement. This also avoids delivering and acknowledging every mutation while a mounted provider has no live queries.

### Event processing and reads

The root callback selects affected active resources, marks them dirty, and schedules one microtask. It performs no filesystem I/O, awaits, or application callbacks, and retains no event history or captured bytes. Pending work is bounded by active keys. Use two invalidation rules in v1:

- For `type: 'update', kind: 'file'`, dirty file/content resources whose resolved path equals the event path, and folder resources whose resolved directory equals the event path's parent directory. Folder entry mode can change on chmod. Hard-link updates already fan out to every live name.
- For every other event, dirty all active resources and invalidate their resolved paths. This covers namespace changes, directories, symlinks, and ancestor renames. Resources without a valid resolved dependency also use conservative invalidation for file updates.

Resolve both file paths and folder paths with core `realpath` during their initial read attempt and after dependency invalidation. Folder symlink aliases need resolved-directory matching too. A resolution failure leaves the dependency unknown; the actual read still decides null/error semantics. Guard dependency publication with resource identity, generation, watch-session token, and a namespace epoch incremented on broad invalidation. An event during resolution/read schedules another attempt and prevents an old dependency from becoming authoritative. Clear all dependencies on root-watch replacement or resume reconciliation because missed namespace events could have changed the target, even within the same owner generation. This is an optimization of an eventually reconciled view, not an atomic realpath/read promise. No reverse dependency index is needed; scan active keys using cached resolved paths.

Targeting avoids unrelated content transfers but does not coalesce the plugin's event stream or prevent overflow from a busy writer. Keep root scope in v1; a provider `watchPath` would need new rules for out-of-scope resources and symlink targets. It is not part of this design.

Use one FIFO drain per client with at most one resource read in flight. Each resource has at most one queue membership. Remove it from the queue and clear its dirty bit immediately before awaiting the command. A later event sets the bit again and queues it at the tail. Thus bursts coalesce, later events are not lost, and a frequently changing resource cannot starve other keys. A refresh arriving during an in-flight read requests a following attempt, rather than treating a possibly older read as its refresh.

Capture both generation and watch-session tokens for each attempt. On success, publish only if both still match and the resource still has consumers. If another event arrived meanwhile, the value can be published with `isStale: true` until its queued reread settles. Do not wait for global silence before displaying initial data. This is an eventually reconciled view; there is no atomic cross-resource snapshot or sequence-gap inference.

An unchanged read preserves the data reference. Compare folder entry fields and the six `FileInfo` fields, text by equality, and byte buffers by length then byte comparison. Replace the result object only when data, error, or visible loading/stale state changes. Beginning a real refresh sets `isRefreshing`; mere React renders do nothing. Arrays and records are readonly; byte arrays are shared read-only by contract because JavaScript typed arrays remain mutable. Tell callers to copy before editing. Core write operations must not detach them.

Initial read failure gives error with undefined data. A failed reread retains only that generation's previous data with `isStale: true`. Errors settle the current attempt; no time-based retries. A later logical event can trigger another read. `refresh()` marks that resource dirty, resolves after the requested attempt settles, and reports errors in the snapshot. Concurrent refresh calls before dispatch share one attempt. If its resource is released or generation ends first, settle the waiters without accepting old data; the caller observes the new key/lifecycle state. Never leave refresh promises hanging after teardown.

Broad invalidation on namespace changes preserves correctness for rename and symlink retargeting; resolved-path matching and the plugin's hard-link fanout handle ordinary file updates. Read-atime does not emit logical events; do not turn persistence status updates into file invalidations. A status change to dirty caused by a read must not cause a read loop. Preserve the core's `noatime` default.

### Terminal watch recovery

Overflow/resync-required terminates the watch. Invalidate its session token immediately, discard unpublished candidate data/dependencies, and mark existing same-generation data stale. Settle the interrupted scan and any current refresh waiters as a failed attempt, with the subscription error visible in resource state. Do not wait for a scan that can no longer succeed. An already sent read may finish, but its result cannot publish; await its settlement before dispatching the next read.

After confirmed retirement, recover automatically while active reads remain. Use one client-wide recovery operation and one timer, with delays of 1, 2, 4, 8, 16, then at most one attempt every 30 seconds. Start a replacement only after the preceding attempt has settled. Reset backoff after a full recovery scan has settled and the watch has remained healthy for 60 seconds, or after a new owner generation. Track that healthy interval without a second polling timer. These are internal defaults, not public tuning props. Repeated overflow never exhausts a lifetime budget, but cannot create a tight registration/rescan loop.

Each recovery subscribes before rereading all active keys and rebuilding resolved dependencies. Keep the error and `isStale` visible while waiting; `isRefreshing` indicates actual rereading, not the backoff delay. Successful resource rereads clear their recovery error. A continually overloaded stream may remain stale; do not claim bounded convergence until the writer subsides. Neither path-targeting nor retry pacing replaces the plugin's bounded queue contract.

Classify by terminal code before registration phase: `SUBSCRIPTION_OVERFLOW` and `SUBSCRIPTION_RESYNC_REQUIRED` use paced recovery even if they reject initial/replacement registration or arrive during deferred activation. Wait for the plugin's confirmed internal retirement when setup returned no handle. Other registration errors, callback failures, and interruption with a still-ready owner require manual retry after confirmed retirement. Unknown retirement retains its safety stop. These failures do not trigger the paced overflow loop. Manual refresh joins an existing scheduled recovery and does not bypass its delay or allocate another watch. With no scheduled recovery it can request one client-wide resubscribe/rescan after a recoverable manual error. Refresh waiters settle on their attempt's success, failure, interruption, or teardown, never after an unlimited chain of future retries. Resource-specific read errors stay local and do not restart the watch. Cancel recovery timers on last-read release, generation change, and disposal.

Treat `SUBSCRIPTION_INTERRUPTED` according to core status; it does not itself prove owner loss. A control timeout can terminate the watch while core remains ready at the same generation. In that case expose the subscription error and allow manual same-generation resubscribe after confirmed retirement, without waiting for an owner change that may never occur. `SUBSCRIPTION_CALLBACK_FAILED` is likewise visible and manual-retry only. Unknown retirement retains the safety stop above.

When status enters `recovering` with no owner generation, clear resource data and refresh waiters. The public status contract cannot distinguish page resume from owner loss there. Stop the old watch and wait for a ready owner before opening a fresh watch and scanning. A same-generation return rescans after confirmed retirement; unknown retirement stays as an actionable stop. A new generation starts its recovery backoff fresh. Failed/disposed clients do not auto-reopen.

## Error reporting and persistence requests

`onError` is reporting, never the mechanism for making an error visible. Catch reporter exceptions and keep the original failure. Route errors after publishing state, outside render and the serial root callback. Do not report ordinary missing-file `null`, an expected persistence denial, or a successfully recovered transient watch overflow as a fatal error.

Report resource errors once per failed attempt to each committed provider binding using that resource, even if several children subscribe. Report command errors once to the provider binding that produced the handle. Report lifecycle/background persistence failures once per entry event to each attached binding; use the failure revision to deduplicate. This is once per provider, not a claim of one callback across multiple user-supplied reporters. Newly attached providers observe existing state but do not replay historical error callbacks. Generation changes reset the appropriate event identities. The application can add central logging deduplication if it deliberately repeats the same reporter across providers.

`usePersistentStorage` uses a separate module-local store, without requiring a volume provider. Start its initial check after commit. SSR/initial hydration are checking. API absence is unsupported; `persisted() === false` is not-granted. `request()` checks the current grant, deduplicates an in-flight check/request, and then calls `persist()` if needed. Its promise resolves after state settles, including rejection represented as error. A manual request after denial starts a new attempt. No permission request is made during render or because a read fails.

Automatic provider requests share the same operation and one page-session attempted flag, set before requesting. If a manual request is already pending, join it and consume the automatic opportunity. Denial/error does not reset that flag. Multiple providers and Strict Mode therefore cannot repeatedly prompt. Persistence errors live in this hook's state, independently of volume errors. The browser grant neither blocks readiness nor proves a particular write was synchronized.

## Premium and plaintext lifetime

Reuse the registered encryption plus subscriptions application worker and prepared `encryptionRequest` shown in the spec. Secrets stay out of SDK keys, comparisons, reporting, and serialized diagnostics. Private prepared options are intentionally retained by core for takeover until disposal. Managed props can be inspected by React DevTools; borrowed construction keeps them out of provider props but does not hide them from same-origin code.

Matching follower profiles do not authenticate the follower's secret. A follower can read an already-unlocked owner with a wrong local secret, then fail with `EVOLUMELOCKED` on takeover. Include this real test. Local close cannot revoke other tabs or enforce an origin-wide lock. There are no invented lock/unlock/rekey events or automatic background credential prompts.

Close and owner/client generation end clear SDK snapshots, pending candidates, text, and byte references. Ignore all late completions. Unsubscribe/disposal must also release listener closures holding results. The application owns draft copies, object URLs, and credentials outside the store. JavaScript does not guarantee zeroization of copied buffers or strings. Do not add a pretend secure-memory mechanism. Replacing credentials on a live retained client requires explicit close followed by a fresh mount. After terminal failure, a keyed remount supplies fresh credentials without closing the failed entry. Enrollment through the premium passkey helper retains its create-new requirement.

## Suspense gate

Do not export `useSuspenseFolder`, `useSuspenseFile`, or `useSuspenseFileContent` in the first stable package. No reserved throwing stubs. Ordinary hooks/render callbacks cover every first-release use case and work in SSR shells.

Before adding Suspense, create a disposable experiment with a committed volume owner above the Suspense boundary. Use cached promises with React `use`, as described in the primary-source research. A new design addendum must choose an explicit read-start/retention mechanism for a resource whose consumer has never committed. The ordinary commit-only acquisition algorithm above cannot be reused unchanged for initial suspension.

The experiment must prove stable promise identity, first-render progress, path changes, initial rejection and boundary retry, Strict Mode, abandoned renders, provider replacement, bounded plaintext retention, and no fallback on ordinary background refresh. Test provider-inside-boundary ordering; either support it or enforce a documented restriction with a useful diagnostic. Do not promise that a timeout alone makes a repeatedly abandoned read correct. If no small mechanism meets these conditions, keep Suspense deferred rather than adopt a query framework solely to hide the unresolved lifecycle.

## Implementation sequence and release gates

These are reviewable work packages for the later implementation plan, not permission to begin coding.

| Work package                | Deliverable                                                                  | Dependencies and evidence                                                                          |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1a. Local client contract   | Support detection, safe error envelope, local status, thin generation facade | Existing worker/relay/SAB tests plus captured-follower-generation races; no persistence frames     |
| 1b. Core close fixes        | Close admission and initialization cancellation                              | Independent core fixes; tests pause commands/init at awaits and prove cleanup/settlement           |
| 1c. Owner persistence       | Minimal persistence frames and retained failure revisions                    | Builds on 1a status/error types; idle-provider, SAB, lost-owner and frame-order tests              |
| 1d. Subscription retirement | Acknowledged cleanup via existing cancel/terminal-ack replies                | Separate plugin change; delayed/lost acknowledgement and setup-failure tests                       |
| 2. Provider and handles     | Package exports, managed/borrowed lifetime, symbol lookup, Actions           | Can start after 1a; managed cleanup and close acceptance require 1b                                |
| 3. Live reads               | Store, root watch, hooks/render callbacks, targeting and paced recovery      | Can start after 1a; complete lifecycle tests need 1b and safe watch replacement needs 1d           |
| 4. Persistence and premium  | Grant helper and real private-plugin consumer test                           | Independent grant work; complete save/background-error UX needs 1c, encrypted lifecycle needs 1b   |
| 5. Demos and docs           | Website demos, React docs, package README                                    | Browser/bundler/accessibility checks and installed-package imports against all completed contracts |

These are dependency edges rather than a single serial core stage. Every prerequisite has its own baseline/performance check. Provider/read development can begin with 1a; it must not ship close or watch-recovery guarantees before 1b/1d. Stable release requires all listed work packages and evidence. Suspense remains a separate follow-up gate. Pin both core and subscriptions artifacts and their digests in installed-consumer and private premium tests. Before independently releasing an affected prerequisite, run its relevant real premium regressions, including packed composition when subscription paths change; final combined tests do not replace this release gate. Community builds must not resolve premium code. Broaden version ranges only with compatibility tests.

### Required behavior tests

Use the repository's Vitest browser and Playwright infrastructure. Test public interfaces in real workers for concurrency and lifecycle; use deterministic failure injection for unsafe or unreliable failures. Cover these timelines explicitly:

| Timeline                                                                                          | Expected result                                                                                      |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A default provider, a string `default`, named shadowing, two roots, and an absent name            | Exact lexical selection; one managed physical client when compatible; missing selection fails        |
| Render is abandoned before provider/hook commit                                                   | Zero new client, permission request, shared resource, or watch                                       |
| Strict Mode setup/cleanup/setup; initialization resolves after cleanup                            | One retained managed client, no orphan watcher, only current binding receives state                  |
| Wrong secret fails; immediately remount when the error is visible with a corrected secret         | Failed reservation already removed; new client gets fresh inputs, old aliases retain only the error  |
| Inline worker factory rerenders, then a compatible alias supplies another factory                 | No identity error; first construction factory remains in use until explicit replacement              |
| Symlink retargets between realpath and read; folder aliases; overflow misses a rename             | Guarded dependencies cannot suppress rereads; unresolved paths stay conservative                     |
| Unrelated database file updates beside 100 resolved content resources                             | No unrelated content reads; namespace events still invalidate broadly                                |
| Old Action waits at readiness, owner changes, Action continues                                    | Dispatch rejects before sending to successor                                                         |
| Write is sent, owner disappears before reply; sync is then called on old handle                   | Write outcome uncertain, no replay; sync cannot target successor                                     |
| Event arrives during read; second resource becomes active; repeated writes continue               | One in-flight read, fair queue, eventual current data once changes stop                              |
| Release/reacquire repeatedly while terminal acknowledgement is delayed or lost                    | Wait for released capacity; unknown retirement stops registration until client/owner replacement     |
| Control acknowledgement times out while owner stays ready; callback throws                        | Visible subscription error, no wait for a nonexistent takeover, explicit retry only after retirement |
| Borrowed-client failure in each of two physical volumes                                           | Error basename comes from public status, never an alias or private field                             |
| Close starts while a command awaits readiness, or after election but before worker initialization | No later public dispatch; initialization/close settle without their timeout; resources released      |
| Closed managed aliases remain mounted                                                             | No SDK construction-input copy remains; terminal state remains readable                              |
| Terminal event arrives during registration/read; last subscriber leaves                           | No late publication or leaked watch; waiters settle                                                  |
| Held initial/replacement registration overflows before subscribe returns a handle                 | Terminal code selects paced recovery after internal retirement; no accidental manual-only stop       |
| Repeated overflow in one long-lived generation; refresh during backoff                            | Paced single recovery, settled waiters, visible staleness, eventual recovery after bursts stop       |
| Failed partial mutation, rename, parent rename, hard link, symlink target, chmod/utimes           | Active views reconcile from current filesystem state                                                 |
| Default atime-changing read with status subscribers                                               | Persistence state updates without a file reread feedback loop                                        |
| Background flush fails then state changes before delivery, with no active file reads              | Idle provider observes retained failure once and current persistence state                           |
| Borrowed caller disposes; managed close fails; keyed remount follows failure                      | Data/handles clear, close error persists, no automatic reopen                                        |
| Alias changes, path changes, generation changes, disabled read, manual refresh during teardown    | No cross-key data leak, unnecessary watch, or hanging refresh                                        |
| Error serializer receives plugin validation failure or malformed remote fields                    | Sanitized message survives accepted transports; malformed envelopes fail safely                      |
| Encryption owner/follower use different secrets, then owner exits                                 | Follower readiness is not key verification; invalid takeover fails visibly                           |

Verify read components and hooks give identical results; 100 consumers of one resource share a read. Mutation errors remain locally catchable, and reporter exceptions never replace them. Check failure fields, not only messages. Tests for generation refusal must actually pause at the dispatch awaits, since a pre-call snapshot test misses the race.

### Performance evidence

Compare the same deterministic datasets and browser builds on the same machine, with warmup and repeated runs. Record raw samples and medians/p95, not a single percentage. Compare before/after each prerequisite in 1a–1d separately with zero status listeners and zero file subscribers, then repeat against the combined result. Gate on no reproducible throughput or median latency regression above 5%, or p95 regression above 10%, after accounting for the baseline's measured variability. If variability is too high to decide, rerun under controlled conditions; do not label an inconclusive result a pass. These are proposed release tolerances, not current measurements or an exemption from investigating slower paths.

Then compare SDK versus direct worker+subscription usage. Exact structural gates are one managed client per compatible basename, one root registration per active client, one initial listing for 100 simultaneous consumers of one folder, one queued membership per key, no I/O on unrelated renders, no inactive content retention, and no atime feedback loop. Keep a core baseline without the React package to confirm it adds no React/query/crypto dependency to core.

Measure 1/100 active resources, 100 consumers of one resource, 10,000-entry folders, 1 KiB/1 MiB/16 MiB files, bursts and continuous writes, two tabs, and real encryption. Track command counts, transferred bytes, main-thread time, live retained bytes, startup, and convergence after a burst. Active memory scales with requested resource data; do not claim a fixed cap across unlimited active hooks. Include binary equality scans and simultaneous old/new read buffers in peak memory measurements.

Event selection scans O(active resources) cached dependencies. An unrelated file-content update must issue no content reads for 100 active 1 MiB files elsewhere, once their dependencies are resolved; a containing folder may reread for entry metadata. Broad namespace events still reread all active resources. Measure real busy-writer workloads as well as isolated updates, including event delivery/ack overhead and paced overflow recovery. Require no SDK-caused main-thread task over 50 ms in the recorded 100-resource workload on the test machine. Retain correctness tests for missing dependencies and aliases when optimizing. Serial reads may delay large workspaces; add bounded parallel reads only if measurements identify the queue as the bottleneck.

### Documentation and demos

Add `apps/website/src/content/docs/docs/react/` and its sidebar entry when the package is implemented. Include quickstart with an actual application worker, named/default lookup, ownership/close, ordinary reads, Actions and save failures, errors/recovery, storage grants, premium setup, and reference pages. Clearly label Suspense as deferred until its addendum ships. Verify Vite, webpack, and Next client-component worker examples from installed packages, including required cross-origin-isolation headers; unsupported SSR storage access must be explicit.

Use `/demos/react/` for the two-volume explorer and conflict-aware editor, with a second-tab flow, explicit persistence opt-in, loading/error announcements, and keyboard access. Use dedicated demo basenames and explicit cleanup. A real premium credential/write/reload/close/reopen demonstration must use the private package when deployable; a clearly marked simulation does not replace the integration test. Show that another tab can retain access after local close. Keep a Suspense demo out until the experiment gate passes.

The [implementation plan](../plans/react-sdk.md) sequences these work packages into PRs and excludes Suspense for a separate follow-up. Revisit the public design only when a prerequisite test disproves a contract or a measured performance limit requires a narrower promise.

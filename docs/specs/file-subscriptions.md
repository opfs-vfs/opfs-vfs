# File and directory subscriptions specification

Status: S7 normative documentation. This document preserves the reviewed PR #17 baseline and adds the accepted S3 and S5b amendments below. Where an amendment conflicts with an earlier baseline statement, the amendment controls. It describes the v1 contract implemented through S6; it does not publish a package or claim that physical-mobile acceptance is complete.

This specifies [premium issue #11](https://github.com/opfs-vfs/opfs-vfs-premium/issues/11). The historic commit references below are review baseline, not a release claim. The [design](../designs/file-subscriptions.md) defines the core contribution, transport, implementation layers, and verification required to satisfy this specification.

Subscriptions report logical changes on one mounted filesystem. They support document previews, import processing, and file browsers shared by normal clients of an owner. They are ephemeral local notifications. V1 includes neither server sync nor billing, persistent event storage, historical lookup, replay, initial enumeration, framework hooks, or an application-defined batch interface. Package access and pricing remain undecided.

## Compatibility policy

Core and premium have no existing users. Fixes and implementation changes do not need backward compatibility with earlier APIs, exports, worker protocols, or stored formats. Choose the simplest correct contract and update both repositories, adapters, tests, and documentation together. Do not add legacy aliases, compatibility shims, dual protocols, or migration machinery solely to preserve pre-release behavior. Runtime profile validation, data integrity, and error handling remain correctness requirements.

## Proposed consumer interface

The package is `@opfs-vfs/plugin-subscriptions`, in `packages/plugin-subscriptions` of the `opfs-vfs/opfs-vfs` repository. It contributes no storage and creates no sidecars. Its main entry exports the direct-instance factory and worker registration. Its `/config` entry exports a lightweight mount request. Its `/client` entry exports `subscribe` and these types, without importing owner implementation code.

```ts
import type { FileChange as CoreFileChange, FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';

export type ChangeType = 'create' | 'update' | 'delete';

export interface SubscribeOptions {
  path: string;
  scope: 'file' | 'directory';
  recursive?: boolean;
  events?: readonly ChangeType[];
  match?: RegExp;
  content?: false | { maxBytes: number };
  signal?: AbortSignal;
  onError: (error: SubscriptionError) => void;
}

export interface SubscriptionError extends Error {
  code:
    | 'SUBSCRIPTION_OVERFLOW'
    | 'SUBSCRIPTION_INTERRUPTED'
    | 'SUBSCRIPTION_CALLBACK_FAILED'
    | 'SUBSCRIPTION_RESYNC_REQUIRED';
}

export type SubscriptionRetirement =
  { readonly status: 'released' } | { readonly status: 'unknown'; readonly error: SubscriptionError };

export type FileChange = CoreFileChange;

export interface Subscription {
  readonly closed: Promise<SubscriptionRetirement>;
  unsubscribe(): void;
}

export declare function subscribe(
  fs: FileChangeSource,
  options: SubscribeOptions,
  listener: (change: FileChange) => void | Promise<void>,
): Promise<Subscription>;
```

`recursive` defaults to `false`; `recursive: true` is invalid with file scope. Omitted `events` selects all three types. A supplied array must be nonempty and contain only those types; duplicate values are collapsed. `content` defaults to `false`. `maxBytes` must be a positive safe integer no greater than 16 MiB, the existing worker whole-file limit. `onError` and `listener` must be functions. Unknown option fields reject with `EINVAL`.

The helper snapshots options before waiting for readiness. Changing the caller's array, regex, or options later has no effect. Callbacks and `AbortSignal` remain local. Only normalized, validated data crosses the worker transport. Regex source and flags cross as strings and are compiled again at the owner. Each test starts at `lastIndex = 0`, including regexes with `g` or `y`. Regexes are trusted application configuration; v1 does not provide a safe evaluator for arbitrary user patterns.

Invalid options reject with `EINVAL`; a target conflict, inaccessible ancestor, closed filesystem, or readiness failure preserves the applicable core error. An inactive or absent change capability rejects with `ENOTSUP`. An already-aborted signal rejects with an `AbortError`, without registering. Exhausting registration capacity rejects with `ENOSPC`. These setup failures reject the returned promise and do not call `onError`. `closed` never rejects and resolves `released` only after the owner processed terminal acknowledgement or the owner mount closed, otherwise `unknown`. A failed setup's internal cleanup is serialized before later registrations on that source, and an unconfirmed one makes later `subscribe()` calls on the same owner generation reject with `SUBSCRIPTION_RETIREMENT_UNKNOWN`.

## Activation and registration

`subscriptions()` creates a fresh configured instance for one direct mount. `subscriptions` is also the static worker registration, following encryption's factory convention. `subscriptionsRequest()` returns `{ id: 'subscriptions', contractVersion: 1, compatibilityKey: 'subscriptions-v1', options: {} }`. Both entry points accept only the empty configuration in v1. Queue limits are fixed below, not per-listener tuning options.

Activation is fixed for the mount. A compatible normal follower must request the same active plugin profile even if it never calls `subscribe`. An owner without the plugin cannot gain it through a follower. The bundled worker keeps its empty registry and rejects a subscriptions request. Registering the factory in a custom worker makes it available; the request enables it. Encryption and subscriptions may run together while the maximum remains one storage provider.

`subscribe` waits for `fs.ready`, then for owner-side registration. Registration establishes the first observable point, after path validation and before acknowledging the request. Mutations completed before that point are outside the contract. Later matching events enter a bounded held queue, including events produced while the acknowledgement travels to the caller.

The helper resolves the handle before activating delivery in a later task. Neither a listener nor `onError` runs before resolution. A terminal condition observed locally before resolution rejects the promise and returns no handle. A terminal message first observed after resolution calls `onError`, even if the owner sent it earlier; setup replies and terminal delivery can travel independently. There is no initial state snapshot or replay. Applications needing current state must establish the subscription before scanning, then reconcile notifications received during the scan as described below. V1 does not promise an atomic enumeration-plus-live handoff.

## Building or recovering a current view

For initial loading and recovery after a terminal subscription error, use this application-managed ordering:

1. Create a fresh subscription and await its registration before scanning. Choose scope and filters that cover every mutation relevant to the view. The listener should quickly record affected paths in a bounded application-owned invalidation set; it must not wait for the scan to finish.
2. Scan current state into a candidate view while continuing to collect invalidations. Treat buffered events as paths needing reconciliation, not as state to replay blindly. Metadata-only events are not complete upserts, and an included historical payload may be older than the scanned state.
3. Use one serialized updater to reconcile the pending paths against current filesystem state. Remove a path from the pending set before awaiting its read, so notifications arriving during that read can add it again. Refresh affected directory listings as needed; `ENOENT` removes a missing entry. Other read failures do not prove deletion. Keep the subscription active and process later invalidations through the same updater.

If the application buffer fills, the subscription terminates, or the scan/reconciliation fails, discard that candidate and unsubscribe the attempt. Fence outstanding reads/callbacks so an abandoned attempt cannot overwrite a restarted view. Start again when the filesystem is usable, or coordinate a quiet period across writers. Applications needing a consistent baseline must keep writers quiet across registration and scanning; subscription-first ordering alone is not an atomic snapshot. An empty local invalidation set does not prove that all transport events have arrived. This is current-view reconciliation, not durable event replay or permission to repeat side effects.

## Paths and filters

Paths use core normalization and case sensitivity. Relative paths are rooted; repeated separators, `.` and `..` follow `normalizeFsPath`. NUL bytes are invalid. A trailing slash requires directory scope. File scope matches exactly one namespace path, not an inode that moves. An existing directory conflicts with file scope, and an existing regular file or symlink conflicts with directory scope. A symlink entry is allowed with file scope. Missing targets and missing ancestors are allowed when existing ancestors satisfy normal core search checks.

A subscription path must not traverse a symlink ancestor at registration. Reject that case with `EINVAL`; do not resolve it into another watched path. Matching never follows directory symlinks. If a previously missing ancestor later becomes a symlink, the subscription keeps its literal path and does not observe the target. It can match again if that literal namespace is recreated. A watched path remains subscribed after deletion, rename away, or a later change of entry kind. Scope controls path matching, not a perpetual kind restriction.

A directory subscription matches its own entry and immediate children. `recursive: true` adds every descendant. `/notes` never matches `/notes-old`; `/` matches the root and its children, or the entire namespace when recursive. All supplied filters are ANDed. The `events` values are ORed. Regexes test the complete normalized absolute event path.

Writes through symlinks report the actual affected target path and its hard-link names. An exact subscription to the symlink entry receives its creation, replacement, or deletion, not updates to the target. No synthetic descendant paths are created below a symlink.

## Logical records and ordering

| Record   | Meaning                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create` | A file, directory, symlink, or hard-link name entered the namespace.                                                                                            |
| `delete` | A namespace entry was removed. The record retains its former path and kind.                                                                                     |
| `update` | A live inode received a content write, size change, explicit permission change, or explicit timestamp change. Every live name for that inode receives a record. |

Hard-link creation reports only the new name. Unlink reports only the removed name. Link counts, incidental ctime changes from namespace maintenance, and parent directory timestamps do not create additional updates. Writing an unlinked open inode produces no path event unless that inode still has another live name.

Reads, implicit atime maintenance, descriptor close, sync, flush, WAL replay, checkpointing, compaction, and encryption sidecar work do not produce logical records. Notifications are not durability receipts. Existing persistence status and sync operations retain their meaning.

A successful nonempty write counts as an update even if bytes happened to be identical; detecting that case must not add a read-and-compare pass. A zero-byte write, unchanged truncate size, same-inode rename, existing recursive-mkdir target, unchanged permission bits, and unchanged explicitly requested timestamps produce no record. Existing metadata bookkeeping may still update ctime; that incidental maintenance is not a subscription change.

Rename produces destination deletions first when replacing an entry, then source deletions, then destination creations. Each side is filtered independently. Moving or removing a directory covers its descendant entries, including subscriptions rooted inside the old tree. Deletions order children before parents; creations order parents before children. Equal-depth paths use ascending JavaScript string order. Inode update fanout uses the same path order. A symlink remains one entry during a directory traversal.

Each final logical record receives a sequence before subscription filtering. A generation identifies the mounted owner, and sequences start at 1 and increase without wrapping. Filtered listeners may see gaps. Gaps alone do not signal lost delivery. If the safe-integer sequence range is exhausted, the change capability terminates with `SUBSCRIPTION_INTERRUPTED` and requires a fresh mount generation.

## Completion and failure

Core finalizes records only after the outer operation succeeds and before another mutation can change its result. Direct synchronous mutators, one asynchronous worker command, and one SAB command establish operation scopes. Nested calls contribute to the outer scope and cannot deliver intermediate records.

`OpfsVfsWorker.writeFileBuffer` and the proposed direct `OpfsVfs.writeFileBufferSync` are each one whole-file operation. A new file produces one `create` after the write and final truncation; a changed existing file produces one `update` for each live hard-link name. An empty write to an existing empty file with unchanged size produces nothing. Internal open, create, write, truncate, and close steps do not escape. Filters run after this grouping, so an updates-only listener receives nothing for a new-file create. Append options produce the final appended file. A failed expected-content comparison produces no update. Both helpers use the existing worker limit of 16 MiB.

Separate low-level calls remain separate operations. `open(O_CREAT)` may create an empty file; later writes are updates. A descriptor close is not an application save signal. Client-side chunking can produce several independently observable owner operations, with other clients interleaving between chunks.

Adapters inherit the operations they invoke. Their reads and writes are covered because they reach the same core mutators. V1 does not promise one event for a PGlite `writeFile`, just-bash `writeFile` or `appendFile`, a copy tree, or an application save assembled from separate calls. Those helpers currently lack a shared non-interleaved owner scope. A future adapter may claim whole-file grouping only after routing the entire helper through such a scope. There is no heuristic debounce or close-based grouping. An application may finish a file elsewhere and rename it into a watched directory.

A low-level write that returns a short count reports the actual resulting state. A rejected operation that changed nothing reports nothing. If an operation throws after changing state, core discards all successful records for that operation and terminates affected subscriptions with `SUBSCRIPTION_RESYNC_REQUIRED`. Path overlap determines affected subscriptions before event-type or regex filters, since a partial operation has no trustworthy final record. If affected paths cannot be established, core terminates all subscriptions on the mount. It preserves the original filesystem error and does not roll back or conceal partial changes.

Whole-file helpers must preflight final size and configured logical/block quotas before creating a missing namespace entry, using the shared core quota rules. Predictable size/quota rejection leaves no new empty file and emits nothing. Physical OPFS quota exhaustion and I/O failure remain possible during writing. Do not promise unconditional unlink rollback or atomic replacement; genuine or uncertain partial mutations still require resync.

## Completed-operation contents

Metadata-only subscriptions perform no file-content reads. With content enabled, `included` means a copied complete regular file from that operation's final state. Core captures it inside successful scope finalization, before a direct call returns, before a worker or SAB success acknowledgement, and before the next mutation. Delivery later never rereads the path.

Two whole-file writes of `A` then `B` must deliver the corresponding copies of `A` then `B`, even when callbacks start after both writes, and even after deletion or recreation. Calling `fs.readFileBuffer(change.path)` inside a listener has a different meaning: it reads current state and may return newer bytes or fail with `ENOENT`.

Omission reasons follow this order: `disabled` when not requested; `deleted` for deletes; `not-file` for directory or symlink entries; `too-large` when the completed file exceeds `maxBytes`; otherwise `unavailable` if normal path-search/read permission checks or capture fail. A zero-byte regular file is included as an empty array. Permission checks apply to each reported path even when hard links share the same underlying capture. Attached content never follows a symlink.

Capture does not open a public descriptor, move a descriptor cursor, touch atime, dirty metadata, create another event, or change persistence status. It reads the logical contents through the mounted storage, including decryption where active. Capture failure omits the bytes and never converts a successful mutation into a failed write. Partial bytes are never delivered.

Metadata-only inode updates such as `chmod` and explicit timestamp changes retain the same content policy. V1 does not add a `contentChanged` field or silently omit requested bytes for these events. Measure their capture cost separately before proposing a different contract.

Captures may share an internal immutable copy for the same operation and inode after path-specific authorization. Each listener receives its own buffer. It cannot mutate VFS memory or another listener's queued or delivered result. No persistent cache is created.

## Delivery, bounds, and cleanup

Each subscription invokes its listener serially, awaiting a returned promise before the next callback. Distinct subscriptions make progress independently. Listeners run in later tasks outside the mutation and SAB paths. Listener writes are allowed and generate later records; the application is responsible for avoiding a self-triggering write loop.

These are proposed implementation ceilings, subject to the capacity and performance acceptance checks in the design before v1 is accepted. They are not measured production defaults. Acceptance requires physical mobile WebKit or Android Chrome measurements as well as desktop measurements; see the design's capacity and performance gates. MiB means 1,048,576 bytes. A pending record includes an event being delivered or a callback whose promise has not settled.

| Resource                                                                             | Proposed limit                       |
| ------------------------------------------------------------------------------------ | ------------------------------------ |
| Pending records per subscription                                                     | 4,096                                |
| Logical attached content per subscription                                            | 32 MiB                               |
| Pending recipient records per mount, across clients                                  | 16,384                               |
| Reserved content-copy bytes per mount                                                | 192 MiB                              |
| Charged event/configuration metadata per mount                                       | 16 MiB                               |
| Registrations per normal client, across channels, including setup and retiring state | 32                                   |
| Registrations per mount, including setup and retiring state                          | 128                                  |
| Additional core operation-record staging                                             | 4,096 records and 4 MiB metadata     |
| Additional conservative operation impact                                             | 128 path regions and 64 KiB metadata |
| Unacknowledged event deliveries per subscription                                     | 1                                    |

While an operation completes, reserve its capture once per operation/inode, plus one isolated delivery copy per recipient record and one relay copy per follower recipient record. Direct and owner-local recipients reserve no follower relay copy. Reserve before allocation. Each subscription still charges the file size once per pending record against its own 32 MiB limit, regardless of shared capture accounting. Delivery copies are made during completion, so the shared capture is released when completion returns; recipient credits remain charged until acknowledgement or conclusive disposal. Every use requires its own path permission checks.

With otherwise empty queues, two follower subscriptions receiving two 16 MiB versions hold 64 MiB of delivery copies and 64 MiB of relay copies, 128 MiB in total, under the proposed 192 MiB mount ceiling; each completion briefly adds its 16 MiB capture. Each subscription holds 32 MiB. Two metadata-only subscriptions receiving one 4,096-record operation need 8,192 recipient records. These are required capacity tests, including metadata/configuration charges, not guarantees under arbitrary existing occupancy. `maxBytes` limits one attached file; it does not guarantee capacity for an unlimited number of versions or recipients.

Metadata accounting charges UTF-8 string bytes plus 256 bytes per record and 512 bytes per registration. Impact regions charge their UTF-8 path bytes plus 256 bytes each. Actual engine object overhead is not a portable byte count; bounded record counts also constrain it. The design specifies the recipient-specific normal-client delivery lane that prevents a content copy in every managed follower.

The limits cover library-owned captures, queues, reservations, and transport deliveries. They exclude buffers retained or copied by application code after delivery, arbitrary same-origin channel listeners, and browser-internal overhead. They do not claim a bound on total browser-process memory. Retiring in-flight deliveries keep their reservations until acknowledged or their channel is conclusively disposed, rather than making space by forgetting an undelivered buffer.

Capacity is checked before capture or transfer allocation. A slow listener never blocks a write. A subscription that cannot reserve its next matching record terminates with `SUBSCRIPTION_OVERFLOW`; its queued records are discarded. The owner processes candidate subscriptions in registration order, so aggregate-cap behavior is deterministic. The per-client registration cap limits slot monopolization, but shared record/byte budgets do not guarantee fairness: a stalled client can still consume capacity needed by another client. Extra channels do not bypass the client cap; a direct mount has one local client identity.

Oversized core staging discards that scope's records while allowing the mutation to finish. Core retains a separate bounded conservative impact description and terminates only subscriptions whose watched paths overlap it, before regex/event filtering. Rename source/destination roots and removal roots describe affected subtrees even after staging stops. Every later mutation must remain covered; incomplete hard-link/path coverage switches to all-subscription invalidation. Use mount-wide overflow only when a safe impact description cannot be retained. An unrelated exact-file watcher survives a large removal elsewhere when those roots are known.

A recursive directory watcher also overlaps operations below it. In particular, a recursive watcher on `/` terminates with `SUBSCRIPTION_OVERFLOW` when an operation anywhere in the tree exceeds the 4,096-record or 4 MiB staging limit. File-browser consumers must discard assumptions based on the incomplete event stream and use [subscription-first recovery](#building-or-recovering-a-current-view): register the fresh subscription, scan, then reconcile buffered invalidations. There is no atomic rescan-plus-subscribe handoff.

Start with one unacknowledged event per subscription and test a fast listener during bulk imports over the follower route. If round-trip overhead still causes unacceptable overflow after correcting admission capacity, revise the protocol explicitly to one bounded frame before adding batching. That revision must charge every record/byte, preserve per-record order and completed-operation payloads, run callbacks serially, acknowledge after the frame's callbacks settle, and keep terminal errors independent of a stalled callback. Batching does not coalesce events or remove queue ceilings.

Listener throw or rejection terminates only that subscription with `SUBSCRIPTION_CALLBACK_FAILED`. Terminal errors bypass a stalled listener, remove the owner registration, discard queued data, and call `onError` once. An error-handler throw or rejection is contained. A terminal subscription cannot receive another listener call. The callback already executing may finish and cannot be undone.

`unsubscribe` is idempotent and stops new local callbacks immediately. Abort and client disposal do the same. They clear local queues, release owner registrations, and do not call `onError`. Abort during setup rejects with `AbortError`; a late registration acknowledgement must still be canceled. Closing one follower cannot remove another client's registrations.

Unexpected owner loss, replacement, or takeover terminates established subscriptions with `SUBSCRIPTION_INTERRUPTED`. There is no automatic resubscription. Once its filesystem is usable, the application follows [subscription-first recovery](#building-or-recovering-a-current-view) to establish a fresh subscription and rebuild current state. Explicitly closing or disposing the subscribing client is normal cleanup. Closing an owner interrupts other clients. Direct mounts receive no new ownership coordination model.

All control and delivery messages carry the owner generation, normal-client identity, channel identity, and subscription identity. Delivery acknowledgements additionally carry a delivery ID. Stale messages cannot restore a registration or release another generation's credit. Terminal control has a separately bounded path and never waits for event credit or the listener's promise.

Plugin cleanup runs after initialization failure, normal close, and worker replacement. It cancels registrations and releases retained captures even if storage cleanup fails. Custom/plugin workers retain their existing passive-observer restrictions. Discovery messages contain only the existing non-secret profile and ownership data, never filters, file contents, or secrets. Routing identities do not authenticate same-origin code.

## Usage examples

These examples use the implemented exports. Packed-artifact acceptance compiles them against the selected core and subscription artifacts.

```ts
// filesystem.worker.ts
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [subscriptions] });
```

```ts
// Application page
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

const fs = new OpfsVfsWorker('documents.bin', {
  worker: () => new Worker(new URL('./filesystem.worker.ts', import.meta.url), { type: 'module' }),
  plugins: [subscriptionsRequest()],
});
const onError = (error: Error) => console.error('Subscription stopped', error);

// The path may not exist yet. There is no initial callback.
const settings = await subscribe(
  fs,
  {
    path: '/settings.json',
    scope: 'file',
    onError,
  },
  async (change) => {
    if (change.type !== 'delete') {
      // Current state: this may be newer than the event or reject after deletion.
      console.log(await fs.readFileBuffer(change.path));
    }
  },
);

const controller = new AbortController();
await subscribe(
  fs,
  {
    path: '/inbox',
    scope: 'directory',
    recursive: true,
    events: ['create', 'update'],
    match: /\.(csv|json)$/i,
    content: { maxBytes: 1024 * 1024 },
    signal: controller.signal,
    onError,
  },
  (change) => {
    if (change.content.status === 'included') {
      // The complete bytes from this event's completed operation.
      console.log(change.path, change.content.bytes);
    }
  },
);

await fs.writeFileBuffer('/settings.json', new TextEncoder().encode('{}'));
settings.unsubscribe();
controller.abort();
```

Use `events: ['delete']` for deletion-only delivery. Any nonempty combination is valid. Change the directory example to `events: ['create']` when importing completed files. Prepare a multi-call import elsewhere and rename it into `/inbox` after writing it.

## S7 accepted amendments and implementation status

This section is normative and supersedes an earlier baseline statement where necessary.

### S3 normal-client transport

`ChangeClient.route` is required and immutable for the channel. Core stamps `local` for direct and owner-local worker clients, and `follower-relay` for verified normal followers. Registration options and raw follower messages do not choose a route. S6 uses the stamped route to reserve the follower relay copy.

Core holds a small registration-ID admission ledger that is distinct from subscription event/content accounting. A slot spans accepted setup, registered/active use, and retirement; a registered reply does not release it. Definite setup failure, an observed terminal/closed outcome with required terminal acknowledgement where applicable, or conclusive channel/mount disposal releases it. The 32/client ceiling covers accepted local setup attempts and active/retiring IDs across channels. The 128/mount ceiling begins at synchronous owner admission. Independent tabs can have bounded pre-admission attempts before the owner observes them; that memory cannot be synchronously counted mount-wide.

The transport has a fixed 32 queued-control-envelope guard per client across channels, with one executing envelope per channel. This is an implementation guard, not a separate tuning option or new public capacity promise. New registration may reject with `ENOSPC` when it is full. Required cancel, acknowledgement, and terminal acknowledgement controls either enter or force conclusive channel disposal; no owner credit is released simply because a request timed out. Cancellation before accepted setup dispatch elides that setup. After dispatch it follows the held owner registration. Unknown cancellation is an idempotent no-op. A close during pending channel opening cancels its reservation and any delayed channel cannot revive.

One follower client uses one recipient-lane name and exactly two BroadcastChannel endpoints, one in the owner and one in that follower. Multiple subscription channels reuse that pair.

The 16 MiB subscription owner metadata ledger covers admitted event/configuration metadata. It is additive to two transport-control guards: 16 MiB across queued and executing owner relay-control payloads, and 16 MiB for each local client's own pre-admission/in-flight controls. Both charge retained strings before copying or queueing and release only when no longer retained. These guards do not change content capacity or record ceilings, do not imply a single all-inclusive metadata budget, and do not create a synchronous cross-tab memory bound.

### S5 and S5b completed content and delivery ownership

The S5 core layer captures completed-operation contents with checked mounted readers. It validates record membership and path authorization, uses no public descriptor, does not alter atime/cursor/dirty/persistence state, and returns an omission rather than converting a successful mutation into a failed write. Metadata-only delivery does not allocate or read content.

The S5b core layer makes delivery ownership explicit. `CapturedContent` included bytes are borrowed shared capture data. After S6 has admitted and reserved a recipient, its contribution copies those bytes into a fresh isolated exact `Uint8Array` backed by an ordinary `ArrayBuffer`. `LogicalChangeHost.send` consumes that delivery buffer. After calling it, the contributor must not read or write the buffer or any alias, including an alias retained for the same recipient. Core validates an ordinary attached full-buffer view; it rejects subarrays, `SharedArrayBuffer` views, and detached views through the existing logical-capability failure path rather than silently allocating a copy.

The worker runtime transfers the owned included delivery buffer in `FILE_CHANGES_FRAME`. Direct delivery retains the owned deferred reference. Follower forwarding uses the separately reserved relay clone. The shared S5 source capture is never transferred. If the worker post fails, the runtime closes and releases its entry and core channel, then makes one guarded metadata-only interruption attempt. A failed interruption post cannot retain that channel; sibling channels and the already-successful filesystem mutation remain usable.

The S3 transport and S5/S5b core layers have implementation and packed-artifact evidence in their stacked work. S6 implements subscription content admission, accounting, and delivery reservations; S7 documents and verifies that implementation. No statement here says S6/S7 has shipped or that a registry package is interchangeable with the selected verified core artifact.

### Acceptance and device status

S7 reports browser timings and delivered-record counts only when observed by the harness. Capture-copy counts, reservation totals, owner-ledger peaks, transport-control peaks, callback lag, and acknowledgement latency are measured only by identified test-owned counters at existing seams; otherwise they are labelled inferred or unavailable. The 128 MiB two-follower/two-version figure is a reservation total asserted by the owner unit test, not a measured allocation high-water.

Desktop Chromium and packed-consumer evidence do not satisfy the physical-mobile gate. Until a real mobile WebKit or Android Chrome run is recorded, physical-mobile acceptance remains **unverified**. Desktop emulation is not a device run. This documentation draft makes no publication claim.

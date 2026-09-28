# React SDK: first specification

Status: proposal for design discussion, September 25, 2026. The SDK, demos, and documentation described here are not implemented. Names and signatures are illustrative, not a published contract.

## Recommendation

Build `@opfs-vfs/react` as a small React integration over the existing asynchronous worker client. Give each volume a provider, provide observable file and folder reads, and make loading, errors, save failures, and recovery visible. Keep encryption in premium.

Start without TanStack Query or Effect. Reuse the existing subscriptions plugin for change notifications, improve worker error transport where needed, and use React's external-store subscription mechanism. Include optional Suspense reads after proving their lifecycle works with Strict Mode and abandoned renders.

This spec defines behavior and design constraints. The [companion design](../designs/react-sdk.md) settles module responsibilities, core prerequisites, lifecycle and read algorithms, and release gates. Both remain proposals; neither authorizes implementation or a core rewrite.

## What exists today

Repository facts checked against core `5bddbcc` and premium `dd24f15`. Proposed SDK exports and core additions below do not exist yet.

| Existing behavior                                                                                                                                                                                                                            | Consequence for the SDK                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`OpfsVfsWorker`](../../packages/opfs-vfs/src/index_internal.ts) wraps the shared worker client and defaults to `pgdata.bin`.                                                                                                                | Reuse this asynchronous interface. Do not mount the synchronous filesystem on the React thread.                                                                             |
| The [worker client](../../packages/opfs-vfs/src/worker-client.ts) manages readiness, leadership, remote commands, shutdown, and buffer transfer. Its constructor allocates a `SharedArrayBuffer`.                                            | Even an async-only React consumer currently needs secure context, cross-origin isolation, Web Locks, Worker, BroadcastChannel, and OPFS support. Check before construction. |
| Core defines [`VfsError` and `VfsCorruptionError`](../../packages/opfs-vfs/src/fs-errors.ts). The initial worker serializer drops fields other than message and code before any follower relay.                                              | Extend the worker error envelope and preserve it end to end. Classify errors by stable code, not cross-worker `instanceof`.                                                 |
| The [subscriptions plugin](../../packages/plugin-subscriptions/README.md) provides bounded live changes, direct and worker registration, and explicit terminal errors. It has no initial enumeration or atomic scan-plus-subscribe snapshot. | Reuse its observation and current-view reconciliation contract. The SDK must configure a compatible worker/plugin profile and report interruption or resync needs.          |
| Core has `getLocalPersistenceStatusSync()`, but its async client has no public status subscription for persistence, role, owner generation, owner loss, or disposal.                                                                         | Add a shared status snapshot and signal. A one-time `ready` promise and `disposed` getter cannot drive live React lifecycle state.                                          |
| [Whole-file worker operations](../../packages/opfs-vfs/src/worker-runtime.ts) have a 16 MiB ceiling, support exclusive creation and expected-content comparisons, and close descriptors within the command.                                  | Reuse them for content hooks and examples. Do not silently read arbitrarily large files into React state.                                                                   |
| The [storage plugin contract](../API.md#storage-plugins) and [application worker setup](../API.md#application-workers) support encryption plus subscriptions on the ordinary core worker client.                                             | Premium uses `@opfs-vfs/plugin-encryption`, not a separate premium client. Managed and borrowed forms can both use it.                                                      |
| [Devtools retains owned workers for the page lifetime](opfs-vfs-debugging-panel.md#discovery-and-ownership) because followers can depend on the owner.                                                                                       | Provider unmount is not sufficient proof that a worker is safe to close.                                                                                                    |

## Scope and package

The first release includes named providers, volume/file/folder hooks, function-as-children equivalents, generation-pinned write handles, structured errors, browser persistence requests, live subscriptions, and encryption plugin integration. Suspense is deferred from the first stable release until the companion design's lifecycle experiment passes; the section below records its intended follow-up behavior.

Use a separate workspace package at `packages/react`. React and a compatible core version are peer dependencies. Reuse `@opfs-vfs/plugin-subscriptions` as the filesystem observation dependency; select compatible released versions using installed-consumer tests. The design proposes React `>=19.0.0 <20`, tested at the minimum and latest stable 19.x. V1 requires an application worker. React 18 compatibility is outside this release. The package must not introduce React dependencies into core.

React, core, and `@opfs-vfs/plugin-subscriptions` are explicit peers, with workspace/dev dependencies for SDK development. The application installs subscriptions for both its worker and the SDK page client. Verify supported resolved versions on both sides; a matching plugin profile key is not proof of package or wire compatibility.

No new query, state-management, error-boundary, or Effect dependency by default. No styled file explorer, recursive tree scanner, cloud sync, backup service, automatic volume deletion, or general transaction system in this SDK. Reuse the existing preview and devtools packages in demos where useful.

## Providers and volume identity

Proposed ordinary use:

```tsx
import { VolumeProvider, useVolume, useFolder } from '@opfs-vfs/react';

// filesystem.worker.ts registers the subscriptions plugin, as shown below.
const worker = () => new Worker(new URL('./filesystem.worker.ts', import.meta.url), { type: 'module' });

function App() {
  return (
    <VolumeProvider fileName="documents.bin" worker={worker}>
      <VolumeProvider name="assets" fileName="assets.bin" worker={worker}>
        <Workspace />
      </VolumeProvider>
    </VolumeProvider>
  );
}

function Workspace() {
  const documents = useVolume();
  const assets = useVolume('assets');
  const images = useFolder('/images', { volume: 'assets' });
  // Each result exposes its own loading and error state.
  return <WorkspaceView documents={documents} assets={assets} images={images} />;
}
```

`name` is a React lookup key and defaults to the exported `DEFAULT_VOLUME` symbol. Define it once at module scope, not during render:

```ts
export const DEFAULT_VOLUME = Symbol('opfs-vfs.default-volume');
export type VolumeName = string | typeof DEFAULT_VOLUME;
```

Providers and hooks share that exact symbol. Its description is only a debugging label; a developer's string `"default"` or a separately created `Symbol('opfs-vfs.default-volume')` is a different key. Do not use `Symbol.for`, stringify keys, or accept arbitrary symbol names in the initial interface. Exporting the symbol lets a deep hook explicitly select the unnamed binding, for example `useFolder('/', { volume: DEFAULT_VOLUME })`.

`fileName` is required for managed providers and is always an explicit core basename, including `.bin`. There is no filename inference or SDK default basename. Existing users pass their actual name, such as `fileName="pgdata.bin"`. `name` only controls React lookup; neither strings nor symbols rename, move, or select physical storage implicitly.

Use these lookup rules:

- `useVolume()`, `useVolume(DEFAULT_VOLUME)`, and omitted `volume` options select the nearest ancestor bound to `DEFAULT_VOLUME`, even inside a provider named `"assets"`.
- `useVolume('assets')` selects the nearest ancestor with that exact string key. An inner provider with the same key shadows the outer provider for its subtree. Nested unnamed providers therefore shadow one another intentionally.
- `useVolume('default')` selects an explicitly string-named provider and never an unnamed one. Two providers share storage only when their explicit physical basenames select the same volume.
- Missing keys throw a descriptive configuration error. Never fall back to another volume or create one during lookup.
- Siblings are not visible through context. Put shared providers above both branches. Separate React roots must each provide their own bindings.
- Each provider contributes a binding to its ancestor context. No globally selected current volume. Context carries stable handles; file updates do not replace the entire context value.

String keys are case-sensitive and nonempty. Validate explicit basenames against the core's basename rules. Cache and ownership identity uses the physical basename within the current origin and storage partition, not the lookup key. Two keys pointing to the same owned volume share one managed client and its resource store. Conflicting non-secret initialization settings for an already managed volume produce a configuration error. Compare ordinary core options and plugin profile declarations: ID, contract version, compatibility key, and required open mode. Never serialize, log, deep-compare, hash, or diff plugin `options`. Matching profiles mean compatibility, not matching credentials. The worker factory and opaque plugin options are construction-only. The first committed acquisition supplies them to core; later compatible aliases/rerenders do not replace them. Core retains its private takeover inputs; the SDK keeps no second copy for retry. Replacing a live retained client requires explicit close and a fresh mount, or a fresh borrowed client. Terminal failed entries are disposed and evicted before publishing the error, so a keyed remount after failure can use corrected credentials.

Providers support two mutually exclusive forms:

| Form                                   | Proposed props                                                                                                  | Ownership                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Managed volume, plaintext or encrypted | `name?`, required `fileName`, required `worker`, `plugins?`, `options?` excluding worker/plugin/attachTo fields | SDK creates the core client after browser mount.                                           |
| Borrowed core client                   | `name?`, `client`                                                                                               | Caller creates and closes the client. No filename, worker, or initialization options here. |

For v1 require an application worker factory, rather than rely on the bundled core worker's empty registry. The SDK appends `subscriptionsRequest()` to managed plugin requests exactly once, validates an already supplied subscription request, and rejects duplicates or incompatible profiles. It cannot add the plugin to an existing owner. The application worker must register every requested implementation:

```ts
// filesystem.worker.ts
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [subscriptions] });
```

Inline worker factories are supported; their function identity is not compared across renders. Core keeps the first factory for that client's lifetime. An ignored alternate factory is not instantiated or validated by profile negotiation. There is no SDK-bundled worker entry in v1; document application-worker bundling for supported Vite, webpack, and Next setups. The premium example below registers both plugins.

Both forms accept `persistentStorage?: 'manual' | 'request-on-mount'`, default `manual`, `onError?`, and ordinary children or a function receiving the volume result. Borrowed clients must already request a compatible subscriptions profile. Failure reports incompatibility instead of pretending to be live.

Changing only a lookup alias does not reopen storage. Changing physical identity, non-secret initialization settings, or borrowed client requires an explicit keyed remount. Worker factories and plugin options are construction-only data; a keyed remount alone does not replace them on a successfully retained managed client. Do not require callers to memoize ordinary option literals. A managed encrypted provider receives prepared request options after foreground credential collection; those options never enter cache keys, configuration diagnostics, or reporting payloads.

### Lifetime and server rendering

Never create a worker or touch browser storage while importing the package or rendering the provider. Propose a shared core `getSupport()` helper for page-detectable prerequisites: secure context, cross-origin isolation, SharedArrayBuffer, Worker, Web Locks, OPFS entry access, and BroadcastChannel. Return missing capabilities and let the provider show `unsupported` with reasons before constructing a client. Do not mistake the absence of worker-only sync-handle APIs on Window for lack of support; validate those during worker initialization. Feature detection does not guarantee a mount will succeed. Devtools can reuse this helper. Render a deterministic pending state on the server and during initial hydration. Start managed clients after the provider commits. Server rendering does not read a user's browser files, and Server Components cannot access a volume.

Strict Mode setup/cleanup must reuse initialization, release listeners, and avoid duplicate persistence requests. An initialization failure releases partial resources. Old async results cannot populate a new client generation.

Proposed ownership default: managed workers remain available for the page session after the last provider unmounts, as current devtools owners do. Release query subscriptions and content caches when unused. Document that visiting many distinct volumes retains worker resources until an explicit orderly close. Do not disguise this cost as automatic cleanup.

The managed volume result exposes explicit `close()`, mapped to that tab's `client.closeVfs()`. A leader synchronizes and ends the owner; a follower flushes through the owner and disposes locally. All same-tab aliases using that managed client become closed and lose their cached data. Close may dispose the client even when flushing fails: retain the close error alongside closed state and never report saved. Remove the closed entry when close settles; existing bindings remain closed. A fresh open requires a new keyed provider mount. There is no managed `retry()` method. Failed/unsupported opens dispose partial resources and remove their entry before publishing the terminal state. A keyed remount retries with fresh inputs; existing aliases retain the terminal snapshot. Borrowed clients require caller replacement. Borrowed clients are closed only by their caller.

Other tabs can lose the old owner, receive `SUBSCRIPTION_INTERRUPTED`, and elect a replacement. Show recovering state and invalidate the old generation; resume reads only after the new generation is ready and a fresh subscription/scan succeeds. Never replay uncertain writes. Takeover can fail, including when the successor has invalid encryption credentials.

`dispose()` is local teardown without the same save guarantee; `shutdownSharedVfs()` can request owner shutdown from a follower. Neither is the SDK's close action, and closing this tab does not guarantee the origin stays locked while others can take ownership. Do not automatically close page-session owners on provider unmount. Normal browser unload is not a reliable save point.

### Core prerequisites for lifecycle and commands

Propose `client.getStatus()` and `client.subscribeStatus(listener)` with stable immutable snapshots, separate from file-change subscriptions, including a public physical basename for borrowed-client error attribution. Include readiness/failure, role, current owner generation, disposal, last lifecycle/close error, and persistence status with `lastError` and `lastSalvage`. Unknown or stale owner persistence state must be explicit. Notify on background flush failure, role changes, owner loss, takeover readiness, and externally initiated disposal. Local lifecycle status needs no new wire protocol. Owner persistence is a separate addition with a minimal state/error/revision/salvage projection; null means unknown. The signal must work while no file read is active. Borrowed clients use the same signal to clear React state when their caller closes them.

Status alone cannot pin a command. Core already checks generations across worker dispatch, relays, responses, and routing invalidation. Expose those protections through a thin facade, making the first comparison role-aware and threading the caller-captured owner token into follower sends instead of selecting the latest owner at dispatch. The SDK handle described below must carry that expected generation through dispatch, not only check a snapshot before calling an async method. Specify this alongside the error envelope before implementing the React layer. The design also requires immediate core command-admission closure and independent initialization cleanup when close races readiness, plus acknowledged subscription retirement to bound replacements.

Different deployed builds can share a volume. Before sending changed wire shapes, negotiate required capabilities during readiness/init and verify frozen old/new owner/follower and page/worker combinations. New clients report `VFS_PROTOCOL_MISMATCH` for unsupported peers before ready. Legacy clients must either receive tested compatible messages or reject through an error path their existing bootstrap understands; they cannot be expected to recognize a new code or field. A compatibility failure must not become a silently dropped reply, automatic mutation retry, or separate owner/volume. The design and implementation plan define this P1a gate and its later rechecks.

## Reads, subscriptions, and mutations

Proposed hooks:

| Hook                             | Result and behavior                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `useVolume(name?)`               | Status is pending, ready, recovering, unsupported, error, or closed; normalized error, capability reasons, role/generation and persistence snapshot, keyed-remount open retry, and managed-only close. No raw lifecycle-capable `fs` or file-content subscription. |
| `useFolder(path, options?)`      | A subscribed, direct-child `ReadonlyArray<VfsDirEntry>`. No recursive scan or content reads. A missing folder is an `ENOENT` error.                                                                                                                                |
| `useFile(path, options?)`        | Subscribed `FileInfo` or `null` for an ordinary file. Missing file is successful `null`; a directory is `EISDIR`. Follow core `stat` semantics for links.                                                                                                          |
| `useFileContent(path, options?)` | Subscribed `Uint8Array` or `null`, or `string` or `null` with `format: 'text'`. Default is bytes. Missing file is successful `null`, not empty content.                                                                                                            |
| `useVolumeClient(name?)`         | A generation-pinned async path-operation handle, or `null` until ready. Use inside React Actions or explicit async handlers. No mutation state engine or volume lifecycle methods.                                                                                 |
| `usePersistentStorage()`         | Origin/bucket-level persistence grant state and an explicit request action; no volume selector.                                                                                                                                                                    |

`FileInfo` contains `ino`, `size`, `mode`, `mtimeMs`, `is_file`, and `is_dir` from `VfsStat`. Omit `atimeMs` because implicit read-atime changes emit no event. Also omit incidental `ctimeMs` and `nlink` changes that need not notify the original path. Full `stat()` remains an explicit one-time read through the operation handle. Preserve core `noatime` defaults; applications may opt into `noatime: true`. Do not claim all of `VfsStat` is a live view, especially for borrowed volumes.

Read options include `volume?: VolumeName` and `enabled?: boolean`. Content reads additionally accept `format` and a byte limit no larger than the core whole-file ceiling. A disabled read is idle and holds no watch subscription. All paths use core semantics; do not introduce an independently implemented path normalizer or assume syntactically similar paths are equivalent across symlinks.

A common resource result has `status: 'idle' | 'pending' | 'success' | 'error'`, `data`, `error`, `isRefreshing`, `isStale`, and `refresh()`. Use a discriminated union so successful reads have known data types. An initial failure has no data; a failed refresh may retain prior data while explicitly reporting both error and stale state. `refresh()` updates this result and resolves when the attempt settles; applications inspect the result rather than receiving a second rejected promise for the same read failure.

Changing volume, path, format, or limit selects another resource. Never display bytes from the previous volume while a new one is loading. There is no automatic previous-path placeholder. Hooks and render callbacks expose read-only snapshots. Consumers must copy byte arrays before changing them; SDK writes must never detach shared cached buffers.

### Function-as-children interface

Expose `Folder`, `File`, and `FileContent` wrappers around the corresponding hooks. Their props and result types are identical. A provider's child function receives only its own volume result. Do not maintain a separate subscription implementation for components.

```tsx
<VolumeProvider name="documents" fileName="documents.bin" worker={worker}>
  {(volume) => (
    <section aria-busy={volume.status === 'pending'}>
      <Folder volume="documents" path="/">
        {(folder) => {
          if (folder.status === 'error') return <ReadError error={folder.error} retry={folder.refresh} />;
          if (folder.status !== 'success') return <p>Opening documents…</p>;
          return (
            <ul>
              {folder.data.map((entry) => (
                <li key={entry.name}>{entry.name}</li>
              ))}
            </ul>
          );
        }}
      </Folder>
    </section>
  )}
</VolumeProvider>
```

These callbacks return React nodes; they are not places to call hooks. Examples above use application-defined view components.

### Writes and save semantics

Use React 19 Actions for pending and error UI. Drop `useVolumeMutation`, `mutate`, and `mutateAsync` from v1. The SDK-specific part is `useVolumeClient(name?)`, which returns a stable handle bound to the client and owner generation selected when it was created. It returns `null` while not ready. A previously captured handle rejects after its generation ends and cannot reroute a queued action into a newly selected volume.

Expose an allowlisted runtime facade, not a raw client with a narrower TypeScript annotation. Include the asynchronous path operations needed for reads, whole-file writes, directory operations, metadata changes, links, and explicit `sync()`. Exclude `closeVfs`, `dispose`, `shutdownSharedVfs`, transport/plugin controls, synchronous methods, and descriptor-level I/O in v1. Use `writeFileBuffer` to preserve caller-owned buffers; do not forward a shared cached buffer to the transferring descriptor-write API. Advanced applications retain their original borrowed client outside this facade.

```tsx
import { startTransition, useActionState } from 'react';
import { useVolumeClient, type VolumeClient } from '@opfs-vfs/react';

type SaveInput = { fs: VolumeClient; path: string; bytes: Uint8Array; previous: Uint8Array };

const fs = useVolumeClient('documents');
const [error, save, isPending] = useActionState(async (_previousError: Error | null, input: SaveInput) => {
  try {
    await input.fs.writeFileBuffer(input.path, input.bytes, { expected: input.previous });
    await input.fs.sync();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}, null);

// Capture the handle with the input, including when React queues the Action.
<button
  disabled={!fs || isPending}
  onClick={() => {
    if (fs) startTransition(() => save({ fs, path, bytes, previous }));
  }}
>
  Save
</button>;
// Render error locally and preserve the editor draft on failure.
```

This is a client-component excerpt; the application owns draft and result state. Key editor/action state by volume generation so an old save cannot report success for a new volume. React's [`useActionState`](https://react.dev/reference/react/useActionState) supplies pending state and sequential dispatch; uncaught Action errors go to the nearest error boundary. Expected conflicts and save failures should normally stay local, as above. Ordinary async handlers still need `await`/`catch`; parallel operations require handling every outcome. The SDK does not retry commands or supply transaction/ordering guarantees across calls.

Every method validates its pinned generation at core dispatch. A write that succeeded before takeover is not followed by a sync against another owner through the old handle. Ending a generation cannot cancel an already sent write or prove whether it ran; report uncertainty instead of reporting a safe retry.

A successful write means the operation completed under the core contract. A successful explicit `sync()` means its synchronization barrier completed. The example treats write plus sync as one user-visible save. If sync fails after the write, report a save failure with potentially modified data. Do not imply rollback. Expected-content comparisons prevent silent concurrent overwrites, but existing whole-file writes are not crash-atomic replacements.

## What live subscriptions promise

The data source is the filesystem owner, not the React mutation hook. Use `subscribe()` from `@opfs-vfs/plugin-subscriptions/client` and its existing worker registration/profile contract. Do not add a parallel `subscribeChanges()` protocol. Managed providers need a worker with that plugin registered; borrowed clients must already use a compatible profile. A follower cannot add a plugin to an owner that lacks it. Core lifecycle/status observation remains a separate prerequisite as defined above.

Observe changes made through the same instrumented owner, including asynchronous commands, synchronous/SAB commands, compatible follower tabs, and adapters using that core instance. Current devtools passive attachments target bundled workers and cannot attach to application workers with plugins; do not promise live devtools discovery of SDK-managed volumes without a separate integration. Direct `OpfsVfs` instances must register the subscriptions plugin and arrange delivery through their host. Raw edits to OPFS container files and older/custom workers without the contract are unsupported. No browser-wide file watcher is implied.

Use exactly one recursive `/` subscription per client with active React reads, shared across aliases and React roots and fanned out to resource listeners in JavaScript. The plugin permits 32 registrations per client and 128 per mount; one subscription per hook or resource key would exhaust it. Unsubscribe the root listener after the last live read leaves. The design adds an acknowledged retirement result to the plugin client so replacement waits for released capacity; unknown retirement blocks further SDK registrations in that client generation. Lifecycle status observation remains separate and continues while the provider is mounted.

Requirements for the adapter:

1. Successful mutations emit logical changes. A partially successful operation that throws invalidates affected reads through the existing resync-required error; never leave them apparently current. Notifications are not synchronization receipts.
2. Await subscription registration before the initial read; the owner buffers held registrations before deferred delivery activation. Reuse the [current-view reconciliation pattern](../../packages/plugin-subscriptions/examples/current-view.ts): collect changes while scanning, serialize rereads, and clear pending work before awaiting a read so a later event can schedule it again. Ignore results from ended generations. Neither an empty pending set nor event sequence gaps prove an atomic snapshot or lost delivery.
3. The serial root listener only marks resources dirty and schedules work; it does not await filesystem I/O or user callbacks. Request `content: false`; historical captured event bytes must not overwrite the current-view cache. Coalesce bursts and bound pending adapter work, collapsing to an all-active-resources dirty flag when necessary.
4. For `update`/`file` events, invalidate file/content resources matching the resolved event path and folder resources matching its resolved parent directory. Record core `realpath` for file and folder aliases. Unknown dependencies remain conservatively invalidated. Hard-link updates already fan out to live names; chmod can change a folder entry's mode.
5. Every other event invalidates all active resources and resets resolved dependencies. Guard resolution/read results by resource, generation, watch session, and namespace epoch. Clear dependencies after a watch gap or resume as well. This handles symlink retargeting and ancestor renames without a reverse dependency index. Keep root scope; no `watchPath` option in v1.
6. Overflow/resync-required ends the subscription. Discard candidates, mark same-generation data stale, and settle interrupted refresh attempts. After confirmed retirement, automatically resubscribe/rescan with one recovery in flight and 1, 2, 4, 8, 16, then 30-second delays. Reset after a settled recovery scan plus 60 healthy seconds or a new generation. Repeated overflow does not exhaust a lifetime budget. Show errors/staleness while delayed, cancel on teardown, and let manual refresh join rather than bypass scheduled recovery. Overflow/resync-required uses this policy even during registration or deferred activation, after confirmed internal cleanup if no handle was returned. Other registration failures and callback failures stay manual; unknown retirement still blocks registration. Recovery never repeats writes.
7. On owner interruption, clear old-generation caches and operation handles, show recovering, and wait for status to identify a ready replacement before resubscribing/scanning. A disposed or failed client requires explicit replacement. A subscription interruption while core remains ready at the same generation is a visible subscription error with manual resubscription after confirmed retirement, not a reason to wait indefinitely for takeover. Callback bugs and unrecoverable reread failures remain visible. Recovery only repeats subscriptions and reads, never mutations. Returning from browser suspension also requires revalidation.

The existing plugin does not retry for us. These paced recovery steps are SDK policy layered on its terminal-error contract, with no replay history or cross-resource atomic snapshot guarantee.

A React store shares one in-flight read per resource key within a client generation. Its key includes read kind, volume identity, path, format, and byte limit. Publish a stable immutable snapshot through `useSyncExternalStore`; resource changes notify affected subscribers, not every descendant of the provider. See [React's external-store reference](https://react.dev/reference/react/useSyncExternalStore).

Dispose read observers and ordinary inactive content caches after their last subscriber leaves. In-flight reads may finish because the current transport has no general cancellation contract; ignore their output after disposal or generation changes. Do not claim that unmount cancels a filesystem write. Bound retention for suspended reads that never mount, and clear all corresponding cached plaintext when the client or owner generation ends.

Manual `refresh()` is always available. Do not silently substitute polling for live support, persist query caches to another database, or reread file contents on every React render.

## Error handling

Normalize expected failures at the worker/client seam into an SDK error with a stable `kind`, message, operation, volume identity, and optional path. Preserve core `code`, `errno`, corruption category/offset, and browser exception name when available. The SDK assigns `outcome` conservatively: `not-applied` only for a rejection it proves happened before dispatch, such as a stale handle or SDK validation failure; `possibly-applied` for a mutation known to have been sent before timeout or attachment loss; `unknown` otherwise. Core does not currently provide a general outcome classifier. Without reliable send evidence, use `unknown`, not an inference from the error code or message. Preserve a local cause where available, without promising that arbitrary Error objects survive structured cloning.

Command errors describe that command's outcome only. An application Action containing multiple commands has an unknown aggregate outcome unless the application has additional evidence; retain the underlying command error separately. For example, a refused sync says nothing about whether its preceding write changed the file. Do not copy a command's `not-applied` classification onto the entire callback. A pre-dispatch rejection for a later command still says nothing about earlier commands in the Action.

| Failure                                                         | Required behavior                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing provider, conflicting configuration                     | Descriptive configuration exception, catchable by an application error boundary. No filesystem operation.                                                                                                                                                      |
| Unsupported browser, mount failure                              | Unsupported state with missing capability reasons, or a separate mount error. A keyed remount creates a fresh client after terminal mount failure. No silent memory fallback.                                                                                  |
| File absent                                                     | `null` for file reads; `ENOENT` for folder listing. Other errno failures remain errors.                                                                                                                                                                        |
| Permission, quota, oversized content, expected-content conflict | Local actionable error. Preserve draft/input. No automatic retry.                                                                                                                                                                                              |
| Corruption or recovery failure                                  | Preserve typed details and the volume. Never repair by clearing storage. Surface nonfatal salvage separately as a recovery notice.                                                                                                                             |
| Worker loss or response timeout                                 | Invalidate ended generations and show recovering or error. A timed-out mutation may have happened; never replay it. Read recovery waits for a ready generation and fresh subscription/scan.                                                                    |
| Background synchronization failure                              | Update volume persistence status and report once even without an active content query. Never show saved solely because an earlier write resolved.                                                                                                              |
| Encryption mount or takeover failure                            | Classify `EVOLUMELOCKED`, `EVAULTCORRUPT`, `EKDF`, `ECRYPTOINTEGRITY`, and `ECRYPTSIDECAR` separately by code. A follower's secret is not checked until ownership acquisition; ready does not certify that secret. Never reopen plaintext or reset the volume. |

Provider `onError(error)` is optional reporting, not a replacement for local state; the structured error contains operation context. Fire once per failed resource attempt or operation invocation per affected provider binding, not once per hook subscriber/render. The design defines routing across shared aliases and deduplication of background failures. Applications decide how to report an aggregate Action; the SDK does not wrap arbitrary callbacks. Background refresh errors remain visible with stale data. A reporter exception must not hide the original storage failure or change its outcome.

Use application error boundaries for configuration/render failures and opt-in Suspense read failures. Ordinary reads expose state. React Actions can propagate uncaught errors to boundaries; other async event handlers must catch rejected promises themselves. The optional [react-error-boundary library](https://github.com/bvaughn/react-error-boundary) is useful in examples, not required at runtime. Retry resets the corresponding failed resource or initialization attempt and the boundary; it does not clear storage or automatically retry a mutation.

Core prerequisite: extend the initial worker serializer, where fields are first lost, then validate and preserve the envelope through client reconstruction, follower/observer relays, and SAB where supported. Retain compatibility with code-based callers and classify premium errors by `code`, never `instanceof` across a worker boundary. Preserve existing sanitization for plugin-option validation errors, including allowed codes and generic messages. Do not attach the original validation exception, raw cause, plugin options, secrets, bytes, or command payloads to the transported envelope or reporting context.

## Optional Suspense

For a later addition, propose explicit `useSuspenseFolder`, `useSuspenseFile`, and `useSuspenseFileContent` exports. They are not part of the first stable package. The [Suspense gate](../designs/react-sdk.md#suspense-gate) requires an experiment and design addendum before exporting them. Keep ordinary hooks as the default. Separate exports give successful initial reads non-optional data types without a boolean option changing return types. Missing-file `null` remains a successful value.

Suspend only for the first read of a resource or an explicitly selected new path. Throw an initial read error to the application's error boundary. After data is visible, keep it during refresh and expose refresh failures; do not blank a working editor whenever a change notification arrives.

Use a cached Promise with React `use`; do not create a new Promise per render. Current [React Suspense documentation](https://react.dev/reference/react/Suspense) permits this without a framework. React separately warns against suspending on external-store updates, which is why live refresh must retain its current snapshot. This distinction needs tests, not just an example.

```tsx
<VolumeProvider fileName="documents.bin" worker={worker}>
  <AppErrorBoundary>
    <Suspense fallback={<p>Opening document…</p>}>
      <Document />
    </Suspense>
  </AppErrorBoundary>
</VolumeProvider>
```

Provider initialization must commit outside the suspending subtree. A Promise cannot depend on an effect inside the very subtree it prevents from mounting. Keep the cache above suspended children, keep snapshots pure, and define read-start and abandoned-read cleanup before claiming support. Test the inverse provider/boundary ordering and either support it without deadlock or fail with a clear documented restriction. Suspense never requests storage permission, unlocks a vault, or starts mutations during render. Server output uses a client-only/loading fallback; it cannot resolve browser file reads.

## Browser persistence requests

`persistentStorage="request-on-mount"` opts into checking `navigator.storage.persisted()` and, if needed, requesting `navigator.storage.persist()` after client mount. This is a browser request, not a guarantee that a permission dialog appears. The browser owns that decision. Persistence applies to the current storage bucket, normally the origin's default bucket, rather than one logical VFS volume. The standard defines `persist()` for secure Window contexts. See the [Storage Standard](https://storage.spec.whatwg.org/#dom-storagemanager-persist).

`usePersistentStorage()` returns `status: 'checking' | 'requesting' | 'granted' | 'not-granted' | 'unsupported' | 'error'`, an error where applicable, and `request()`. A `false` result is `not-granted`, not a thrown filesystem error. Unsupported API or denied permission does not prevent volume use. An actual rejected request is visible separately from volume readiness.

Deduplicate concurrent requests across providers and Strict Mode, allow at most one automatic attempt per page session, and never repeatedly prompt because a provider remounted. After denial, the app can explain the tradeoff and offer an explicit user-triggered request. Do not block readiness or first paint on the request.

Docs and demos must distinguish the persistence grant, local synchronization, and backup. A grant does not enlarge the quota, make a write durable, prevent explicit site-data deletion, or create a backup.

## Premium encryption

Premium is `@opfs-vfs/plugin-encryption` on the ordinary core `OpfsVfsWorker`. The contract is concrete: [premium README at `dd24f15`](https://github.com/opfs-vfs/opfs-vfs-premium/blob/dd24f15/packages/plugin-encryption/README.md), including ownership and key lifetime. That repository/package is private. React implements no cryptography, key derivation, licensing check, or migration.

```ts
// filesystem.worker.ts
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { encryption } from '@opfs-vfs/plugin-encryption';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [encryption, subscriptions] });
```

```tsx
import { encryptionRequest } from '@opfs-vfs/plugin-encryption/config';

// Prepare secret in the application's foreground credential flow before mounting.
<VolumeProvider
  name="private"
  fileName="private.bin"
  worker={worker}
  plugins={[encryptionRequest({ secret })]}
  options={{ openMode: 'open-existing' }}
>
  <PrivateDocuments />
</VolumeProvider>;
// The provider appends subscriptionsRequest(). Crypto runs in the worker.
```

A caller-owned core client configured with both requests also works through the borrowed form. One storage plugin and one logical-change plugin can coexist. The separate premium `/passkey` preparation flow runs in the foreground; enrollment requires `openMode: 'create-new'`, which managed options must allow. Preserve the existing exact tested core/premium artifact coupling.

There is no runtime lock/unlock/rekey method or premium lock event. Opening after credential entry constructs a new client. Closing that client ends the local session; a later open uses a new generation. Failed `ready` is terminal and requires a new client. Never change credentials by remounting a provider around an old retained client. The SDK drops temporary construction inputs after handing them to core and retains no credential copy for retry. Terminal failure/close releases client references even if aliases remain mounted; application props and copies are still application-owned. Never prompt for credentials during background takeover.

Matching same-origin followers use the owner's already-unlocked volume. Their secrets are not authenticated merely by reaching ready, and React cannot report a wrong-secret error in that situation. If such a follower later becomes owner, its credentials are tested and may fail with `EVOLUMELOCKED`. Closing one tab does not revoke another tab's access or prevent its takeover. This SDK offers no origin-wide lock guarantee.

Use the core status signal to clear plaintext snapshots and invalidate handles when a client or owner generation ends, including a borrowed client closed outside React. In-flight results from an ended generation cannot refill caches. Provider unmount does not itself close a borrowed client. Applications must clear their own drafts, copied bytes, credential references, and preview URLs as their policy requires.

The client privately retains prepared options for takeover until disposal. Plugin options may pass through managed props, but never through SDK configuration diffs, cache keys, errors, persisted React state, URLs, or SDK-generated logging/devtools payloads. React DevTools or same-origin debugging code can inspect managed props; this interface does not conceal secrets from them. Use a caller-created borrowed client to keep request options out of provider props, while recognizing that the page client still retains private options for takeover. JavaScript cannot promise complete zeroization of immutable strings or structured-clone copies. Document encryption at rest and same-origin access honestly. Never silently recreate a volume or fall back to plaintext, and keep crypto implementation out of the community-only bundle.

## What to borrow from established libraries

The [research notes](../research/react-sdk-patterns.md) record primary sources and GitHub popularity observations. These are interface precedents, not proposed dependencies.

| Library                                                                 | Adopt                                                                                                    | Do not copy by default                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [TanStack Query](https://github.com/TanStack/query)                     | Explicit query/mutation states, shared in-flight reads, separate Suspense hooks, deliberate error reset. | Network retry/focus-refetch defaults, persisted caches, optimistic rollback machinery. Local uncertain writes cannot be blindly replayed. |
| [SWR](https://github.com/vercel/swr)                                    | Scoped cache ownership, keyed reads, stale-data-plus-error behavior.                                     | A module-global cache that can mix volumes or unlocked sessions.                                                                          |
| [Zustand](https://github.com/pmndrs/zustand)                            | Stable stores supplied through context; updates scoped to actual consumers.                              | A second public general-purpose state model for applications to learn.                                                                    |
| [Dexie](https://github.com/dexie/Dexie.js)                              | Live reads observe changes made through the storage system, including other contexts.                    | Assuming OPFS offers IndexedDB's transaction observation or Dexie's query tracking automatically.                                         |
| [react-error-boundary](https://github.com/bvaughn/react-error-boundary) | Local fallback UI and explicit reset/retry examples.                                                     | Treating error boundaries as handlers for every asynchronous mutation.                                                                    |

### TanStack Query decision

Keep a private resource store if it remains limited to deduplication, snapshots, invalidation, and listener cleanup. Build the actual read/subscription prototype before choosing a dependency based on predicted complexity.

Reconsider Query if we need substantial scheduling, cancellation coordination, configurable retention, prefetching, or repeated error-reset machinery. Compare a native implementation and a Query implementation using identical error, ownership, subscription, Suspense, and bundle requirements. Query still needs filesystem events, a client lifecycle, premium handling, and a safe mutation policy. It cannot replace those requirements.

If adopted, make the dependency explicit in a separately named integration or an intentional package decision. Do not make consumers install it secretly, or ship two complete cache engines in one initial package. A recipe using `fs` and change notifications in an application's existing Query client may be enough.

### Effect v4 decision

Do not rewrite the filesystem to obtain typed React errors. First preserve the error types the core already has, expose background failures, and classify worker failures. Keep Promise-based public worker methods and existing synchronous storage paths.

The research found an Effect v4 release candidate, not a stable v4 release, on September 25, 2026. Effect offers typed error channels and resource-management facilities, but no cited evidence establishes that converting this filesystem would preserve its performance. See [Effect releases](https://github.com/Effect-TS/effect/releases) and the [v4 error model](https://effect.website/docs/v4/error-management/two-error-types).

If lifecycle orchestration remains difficult after the small core changes, evaluate Effect in a separate experiment around worker startup/cleanup. Do not put a fiber, allocation-heavy wrapper, or async operation around each block read/write, metadata update, or synchronous adapter call. Preserve error serialization and the existing public interface regardless of the experiment.

Gate any migration on measured improvements and no reproducible performance regression: initialization, sequential and random I/O, metadata operations, sync/checkpoint latency, memory, worker message costs, and browser bundle size. Run current and proposed code against identical workloads in disk/memory modes and relaxed/balanced/strict durability, including premium overhead. Report median and tail latency plus repeated-run variance. Agree numerical acceptance budgets before implementation; "should be zero-cost" is not evidence. Reject or narrow the migration if it misses those budgets.

## Demos and documentation to ship with the SDK

Add a React SDK section in the existing Starlight sidebar, with source pages under `apps/website/src/content/docs/docs/react/`. Proposed pages:

1. Getting started: install, browser headers, first provider, ordinary reads, and explicit save.
2. Volumes and lifecycle: default/named lookup, nesting, physical basenames, borrowed clients, Strict Mode, server rendering, close behavior, and migration from `pgdata.bin`.
3. Files and subscriptions: hooks, render callbacks, missing files, byte limits, cross-tab updates, refresh, and observation limits.
4. Errors and recovery: read/mutation/background failures, uncertain outcomes, conflicts, error-boundary reset, and optional Suspense.
5. Persistence and encryption: browser grants versus synchronization, manual/automatic requests, plugin setup, follower credential semantics, and client close/reopen.
6. Reference: public types, defaults, compatibility matrix, and an optional existing-TanStack-Query recipe.

Link this section from getting started, integrations, and the SDK package README. Publish examples only once their imports exist. Use the repository's release/changeset workflow for the actual packages.

Build these real-browser demos after the SDK works:

| Demo                                    | What it must demonstrate                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-volume workspace at `/demos/react/` | Default documents volume plus named assets volume; deeply nested explicit selection; folder hook and render-callback versions; writes reflected in a second tab.                                                                                                                                |
| Editor and failure cases                | Conflict-aware save with explicit sync, preserved drafts on failure, missing/large files, local error state, ordinary first-load state, deliberate retry, and a later Suspense demo after its gate passes.                                                                                      |
| Persistence and premium                 | Manual persistence request and opt-in automatic mode with actual browser outcomes. Real premium credential-entry/write/reload/close/reopen flow when the private dependency can be deployed. A simulated premium story must be labeled simulated and does not satisfy integration verification. |

Demos use dedicated basenames, never discover and modify arbitrary user volumes, never request persistence on first visit without the demo opt-in, and provide explicit cleanup. Reuse website styling and preview UI. Include keyboard-accessible controls and announced loading/error states. Keep a deterministic test harness for quota, worker, and sync failures instead of filling a user's real storage to demonstrate them.

## Acceptance criteria and decisions for final design

The implementation is ready only when these cases are verified through the public interface:

- Two providers and multiple React roots cannot mix data. Omitted keys equal `DEFAULT_VOLUME`; the string `"default"` and a fresh symbol with the same description do not equal it. Explicit symbol lookup, named lookup, shadowing, missing keys, conflicting options, borrowed clients, remounts, and explicit close follow the documented rules. Storage sharing follows `fileName`, independently of lookup keys.
- Strict Mode and server import/hydration allocate no duplicate workers or listeners and cause no repeated permission request. Closing and reopening never accepts a stale generation's response.
- Core status changes reach idle providers: background sync errors, role changes, owner loss, takeover, disposal, and failed close are visible without an active file read. Repeated overflow in one owner generation recovers automatically with paced, nonoverlapping rescans. Interrupted refreshes settle; non-overflow registration failures and callback failures remain manual, and unknown retirement stops registration.
- Hooks and render callbacks produce equivalent results. Several subscribers share a read. Unchanged state preserves snapshot identity; equal rereads reuse data references. Disabled/inactive resources release observers and content memory.
- Writes from React, another compatible client/tab, SAB, and supported direct adapters update affected views. Devtools attachment to plugin workers remains a separate integration follow-up. Rename, deletion, partial mutation, link aliases, missed events, atime changes, and owner loss cannot leave indefinitely stale results.
- No mutation retries automatically. Generation-pinned handles reject after takeover at actual dispatch, including after readiness awaits and between write and sync. Error fields survive each transport with validation messages sanitized; refresh failure keeps explicitly stale data, sync failure cannot display saved, and failed initialization never triggers data deletion.
- Before a later Suspense release, verify stable Promises, no effect deadlocks, boundary reset and abandoned-render cleanup, and no fallback on normal live refresh. These are not first-stable-release gates.
- Persistence denial, rejection, unsupported APIs, concurrent providers, and explicit retry behave independently of volume readiness.
- Real premium tests cover wrong credentials at initial ownership, a matching follower reaching ready with a wrong secret, failure when that follower takes ownership, close during read/write, externally closed borrowed clients, plaintext invalidation, fresh-client reopen, passkey enrollment mode, and bundle separation.
- Compare SDK overhead with direct worker usage: 100 distinct active resources consume one root subscription per client, and 100 subscribers to one folder produce one shared initial listing; unrelated renders perform no I/O; reads cause no atime feedback loop; event bursts are coalesced. Measure active large-folder/content workloads to decide whether volume-wide invalidation is acceptable. Core workloads with zero subscribers must show no reproducible throughput regression beyond agreed measurement noise.

Use the existing Vitest browser and Playwright infrastructure. Run real Chromium, Firefox, and WebKit scenarios where the required browser features are supported, and test a clear unsupported state elsewhere. Mock only failures that cannot be reproduced safely and reliably. Exercise default and nondefault storage modes, worker leadership changes, and the production website headers.

The [design](../designs/react-sdk.md) now defines the proposed React baseline, status snapshot, expected-generation dispatch, safe errors, managed lifetime, read store, paced recovery, and performance gates. The implementation plan should use its work-package sequence. Remaining release evidence is concrete:

1. Select actual released core/plugin versions using installed-package compatibility tests.
2. Verify Vite, webpack, and Next application-worker examples and required headers.
3. Measure targeted file updates, broad namespace invalidation, busy-writer recovery, and the proposed numerical regression/interaction budgets before accepting the implementation.
4. Verify the real premium integration and determine whether its demo can be deployed with private-package access.
5. Keep Suspense out of the first stable package until its separate lifecycle experiment and design addendum pass.

Defer a default `noatime` policy, `useFileObjectURL`, and devtools registration to follow-ups. Object URL ownership can build on existing preview code when needed. Custom plugin workers currently do not advertise passive devtools support, so registration alone would not make them discoverable or attachable. Do not claim these conveniences in v1.

The [implementation plan](../plans/react-sdk.md) follows the reviewed design and leaves Suspense to a separate follow-up. Local core contracts unblock React development while close, persistence, and retirement changes remain separate required release gates; the initial package remains independent of Query and Effect.

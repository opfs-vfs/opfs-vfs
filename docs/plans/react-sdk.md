# React SDK implementation plan

Status: implementation and P7 evidence complete, September 27, 2026. `@opfs-vfs/react` 0.0.3 (changeset `5fc8f70`) documents the existing preview capabilities in the package's release history, with no new runtime behavior, and the preview is published as a preview release. Recorded core performance-budget exceptions remain open follow-up. This plan implements the reviewed [design](../designs/react-sdk.md) and [specification](../specs/react-sdk.md) from `628e200`. Those documents define behavior; this document defines delivery order, checks, and release evidence. Recheck source locations against the implementation branch before changing them.

## Scope

Ship `@opfs-vfs/react` with managed and borrowed volume providers, the exported `DEFAULT_VOLUME` symbol, six ordinary hooks, three read components, typed errors, explicit command handles, persistence requests, premium compatibility, demos, and a React documentation section. Reuse core, the subscriptions plugin, React context, and `useSyncExternalStore`.

Suspense is excluded from every work package and release gate below. Its [disposable experiment](https://github.com/opfs-vfs/opfs-vfs/tree/f8bf54d178e2eb47ea9bc71bed96b56e92f5603a/prototypes/react-suspense) informs a separate design follow-up. Do not add Suspense exports, stubs, preparation APIs, caches, or demos during this implementation. TanStack Query, an Effect rewrite, React 18 support, devtools attachment, object-URL ownership, and changes to the default `noatime` policy are also outside this plan.

The public package imports no premium implementation. Encryption remains in the real private plugin and is exercised by a separate consumer test. No automatic mutation retry, volume deletion, transaction abstraction, or SDK-owned worker entry is included.

## Delivery order

Use the following work packages as PR boundaries. Split a package further only when its checks remain independently meaningful. Keep core lifecycle fixes separate from the React package so their correctness and performance can be reviewed without React.

| ID  | Deliverable                                          | Can start after        | Required before acceptance                                                     |
| --- | ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| P0  | Baselines and test wiring                            | Plan approval          | Recorded source/artifact versions and repeatable checks                        |
| P1a | Local core contracts, safe errors, generation facade | P0                     | Worker/relay/SAB and generation race evidence                                  |
| P1b | Core close admission and initialization cancellation | P0                     | P1a integration, close and cleanup races                                       |
| P1c | Owner persistence observation                        | P1a                    | P1b integration, idle-client and transport evidence                            |
| P1d | Acknowledged subscription retirement                 | P0                     | P1a error integration, delayed/lost acknowledgement and setup-failure evidence |
| P2  | Package, providers, command handles, error reporting | P1a                    | P1b, provider/ownership/Actions tests                                          |
| P3  | Live reads, hooks, render callbacks, recovery        | P1a and P2 interfaces  | P1b, P1d, integrated P2, read/recovery tests                                   |
| P4  | Browser persistence grant helper                     | P2 package skeleton    | Provider integration and Strict Mode/request tests                             |
| P5  | Real premium integration                             | P2 and basic P3        | P1a–P1d, P2–P4, private consumer evidence                                      |
| P6  | Demos, docs, installed-consumer examples             | P2 and basic P3        | P1a–P1d, P2–P5; bundler, browser, accessibility checks                         |
| P7  | Compatibility, performance, release readiness        | Each completed package | Every gate below, selected published version ranges                            |

P1b and P1d can be developed while P1a is in review. P2 and P3 need not wait for persistence frames in P1c. P4 does not depend on owner persistence: a browser grant and a filesystem synchronization result are different state. P5/P6 authoring can overlap implementation, but mocks do not satisfy their acceptance gates. P7 measurements began after implementation completed and are recorded in the acceptance index. Structural correctness checks remain required; recorded core budget exceptions require follow-up rather than a waiver.

“Can start” permits implementation against the agreed interface. It does not permit merging an integrated change with unresolved dependencies or publishing an incomplete stable package. Core prerequisite PRs may land independently once their own checks pass. They carry no changesets; a separate release PR adds changesets after the premium evidence below is recorded. Keep the React package unmerged, and therefore unpublished, until P7. Before independently releasing any affected P1 artifact, run the relevant real premium regressions against that exact candidate. This is required before a release-enabling merge because publishing is automatic; P5/P7 combined verification does not replace it. Error/validation changes require premium error-code and secret-sanitization cases; lifecycle changes require affected encrypted close/takeover cases; subscription-path changes also require the private `test:subscriptions-packed` composition check. Record these results in the evidence index. Missing private test access blocks that artifact's release, not ordinary public CI. If a core test disproves a design contract, update and review that contract before implementing a workaround.

## P0. Establish baselines and test wiring

1. Record the actual starting core/subscriptions commits, runtime and browser versions, storage modes, machine, and datasets. The design's historical observations use core `5bddbcc` and premium `dd24f15`; they are not substitutes for recording the implementation baseline.
2. Reuse existing tests in `packages/opfs-vfs/src/__tests__`, `packages/plugin-subscriptions/src/__tests__`, their Vitest browser configurations, and website Playwright tests. Use dedicated disposable basenames and deterministic worker barriers for race tests. Inject quota/transport/sync failures rather than filling a user's storage.
3. Create `docs/REACT-SDK-ACCEPTANCE.md` using `docs/SUBSCRIPTIONS-ACCEPTANCE.md` as the evidence format. Record each run's commands, environment, artifact versions/source commits/SHA-256 digests, outcomes and limitations. Store raw machine-readable samples under `docs/benchmarks/react-sdk/<run-id>/` and link them from the index. Each work package appends its evidence; do not overwrite the baseline. These files are P0 deliverables, not results claimed by this plan.
4. Build one shared worker-client benchmark driver at `packages/opfs-vfs/scripts/benchmark-worker-client.mjs` with browser/worker fixtures in the existing test tree. Reuse the fragmented disk/memory datasets and correctness assertions from `perf-coalescing*.ts`, SAB setup from `sab-parity*`, and leader/follower/two-tab orchestration from `plugin-subscriptions/src/__tests__/subscription-load.test.ts` and `scripts/two-tab-load.mjs`. These are starting points, not existing p95 benchmarks. Add no-observer async leader and follower read/write/metadata/sync workloads plus worker-hosted synchronous SAB workloads. Measure cold readiness/close separately from warm dispatch and throughput, using fixed datasets, supported disk/memory modes, and identical harness code/configuration for baseline, each P1 change and their combination. Keep observers disabled for the P1 baseline; retain separate observer-load measurements for P1d/P3.
5. Record raw per-operation durations, not just five run summaries. Define warmup exclusion, operation counts, concurrency and percentile calculation once in the driver. For fast dispatch cases collect at least 1,000 measured operations per case in each of five independent runs; report per-run median and nearest-rank p95 alongside throughput and variability. Separately size startup/close and large-content samples, record their counts, and treat unstable tails as inconclusive. Measure in the calling page/worker so host orchestration time is not command latency. The website collector's direct PGlite path and median/min/max summaries do not satisfy this worker-dispatch gate.
6. Extend test configurations only as needed for the new package and browser matrix. Existing CI installs Chromium only. Explicitly add Firefox/WebKit coverage for the SDK acceptance job or provide a reproducible release job that runs it and stores results; do not infer three-browser coverage from a green existing workflow.

Done when maintainers can reproduce the baseline and existing relevant checks pass, or pre-existing failures are recorded with a concrete disposition. No public API is added in P0.

## P1a. Local core contracts and dispatch errors

Primary locations: `packages/opfs-vfs/src/worker-client.ts`, `worker-runtime.ts`, `worker-errors.ts`, `fs-errors.ts`, `sync-messenger.ts`, their public entries, and existing option/path validators. Reuse validation rather than create a React-specific interpretation of core options or basenames.

Implement:

- A mixed-build compatibility policy for changed wire contracts before sending enriched envelopes or P1c frames. First record the readiness/init bootstrap and supported capability/version combinations in the design. Missing capability/version is legacy, not automatic compatibility. A new client rejects an owner/worker lacking required capabilities before ready with `VFS_PROTOCOL_MISMATCH`. The SDK exposes it, and a legacy peer's `VFS_PLUGIN_MISMATCH`, as a typed volume error that applications can handle, for example by showing a notification asking the user to reload or close older tabs. V1 does not interoperate across builds. For an old client with a new owner, either preserve tested legacy reply shapes or use a refusal understood by that exact legacy bootstrap, such as its existing profile mismatch path. Adding a field an old client ignores is not rejection, and old clients cannot be promised the new code. Do not silently downgrade SDK guarantees or create a second owner/volume to bypass incompatibility. Negotiate on existing channels; the generation facade and retirement promise still reuse their existing protocol mechanisms.
- Allocation-free page capability reporting through `getSupport()`, with worker-only sync-access-handle validation left to worker initialization. Detectable support is not proof of a successful mount.
- Immutable, reference-stable `getStatus()` / `subscribeStatus()` snapshots with public physical `fileName`, opening/ready/recovering/failed/closed state, role, owner generation, and safe errors. Add closing in P1b; leave persistence null until P1c. Publish local changes without active React listeners or file queries. Close the subscribe/read race.
- The validated, bounded `RemoteErrorDetails` envelope at each worker, initialization, relay, subscription, status, and SAB boundary. Update strict allowed-key validators as well as serializers. Preserve sanitized plugin-validation errors; exclude stacks, arbitrary causes and option objects.
- Per-invocation dispatch evidence separate from remote details. Distinguish refusal before send, known send with unknown completion, and unavailable evidence. A delivered mutation failure can have partial effects. Never classify it as not applied from an error code alone.
- `client.forGeneration(ownerGeneration)` with exactly the design's async path-method allowlist. Reuse command preparation and dispatch. Make the first generation check role-aware, forward the caller-captured generation through follower relay, and preserve checks after readiness awaits, before dispatch, and on responses.

Acceptance checks:

- Install frozen pre-change core/subscriptions artifacts beside the candidate, in separate page/worker bundles. Test old-owner/new-follower and new-owner/old-follower, cached page versus worker builds, and mixed-version takeover/reconnection. Verify each supported combination preserves its declared fields and behavior; unsupported combinations refuse before ready through a legacy-readable path where needed, rather than dropping a response until timeout. Recheck the matrix as P1c/P1d change capabilities or assumptions, and before each independent affected release. Current plugin profile keys alone are not wire compatibility evidence.
- Import/support checks allocate no worker, lock, shared buffer, or storage access. Missing capabilities are deterministic and worker-only checks do not falsely reject Window support.
- Pause leader and follower commands at readiness/dispatch awaits, change ownership, then release them. Old handles cannot dispatch to the successor. Lose a reply after a write was sent: report uncertainty and observe no replay. A later sync on that old handle must refuse the successor.
- Round-trip all allowed error fields through real transports and reject malformed envelopes. Verify sanitization for initial plugin failure, follower relay, subscriptions, and SAB. A synchronous postMessage failure before delivery reports pre-dispatch refusal; no send evidence is invented for SAB.
- Exercise stable status identity, notification ordering, idle-client failure/takeover/disposal, and the unchanged signatures/behavior of existing synchronous APIs.

Done when these public core contracts and existing affected core tests pass, the package declarations export them, and the P1a no-observer performance comparison is acceptable.

## P1b. Stop command admission and cancel pending initialization

Primary locations: existing client close, readiness/election, initialization and worker cleanup paths in `worker-client.ts` / `worker-runtime.ts`, plus the relevant lifecycle tests. Keep this fix usable outside React.

Implement a synchronous public-command admission barrier at local close, checked at all dispatch boundaries including operations already awaiting readiness. Publish closing immediately. Keep a private close/flush path. A follower close flushes its captured owner and disposes locally; it cannot retarget a replacement owner.

Separate public readiness settlement from initialization cleanup. Close rejects public readiness and pending work immediately. If INIT was already sent, close settles on that INIT response: a late success receives orderly cleanup and a late failure resolves close. It does not depend on the public `ready` timer, and the INIT command deadline bounds it if the worker never answers. Close never terminates a worker mid-mount, because that could release the owner lock while the worker still holds OPFS access handles. Before INIT is sent, close terminates immediately. If storage reached a writable mounted state, perform supported orderly cleanup, report failure, and dispose in all cases. Cancellation does not imply rollback of storage creation or recovery.

Acceptance checks pause before/after election, during worker initialization, during follower readiness, and before close flush dispatch. Assert settled readiness and close promises, no command admitted after close, no successor flush, and no leaked worker or lock. Cover close-flush failure, late successful initialization, external borrowed disposal, repeated close, and already-sent command uncertainty. Reuse P1a envelopes and generation checks. Record the independent and combined performance comparison.

## P1c. Observe owner persistence without polling

Primary locations: persistence transitions in `packages/opfs-vfs/src/opfs-vfs.ts`, worker/client channels and their validators, plus storage lifecycle and transport tests. Use the existing source transitions rather than inspecting dirty pages on each operation.

Add only the design's state, retained last failure/revision, and salvage projection. A later dirty/clean transition must not erase a failure before subscribers see it. Send an initial snapshot and compact versioned updates on existing channels with owner generation and monotonic sequence; reject stale/out-of-order frames. Coalesce ordinary updates once per event-loop turn without losing the most recent failure revision. Cover asynchronous operations, SAB, timer flushes, and swallowed pagehide failures at their source.

Unknown owner state, routing loss and page resume set persistence to null until a current-generation resync arrives. On resume, use existing owner negotiation, invalidate handles during recovery, and request read reconciliation once ready. Add no heartbeat, periodic polling, full-state serialization, dirty-page scanning, timestamps, or storage-scheduling change.

Acceptance checks include an idle status subscriber with no file reads; failure followed by clean state before delivery; late subscription during a state transition; malformed, duplicate, reversed, and old-generation frames; follower sleep/resume; SAB failure; and loss/replacement of the owner. Error reporting must observe the retained revision once while current state still describes the current owner. P2/P3 integration must show that persistence status changes and read-atime never invalidate files or create a read loop. Record isolated and combined performance results.

## P1d. Confirm subscription retirement

Primary locations: `packages/plugin-subscriptions/src/client.ts`, `owner.ts`, `types.ts`, `validation.ts`, existing terminal/cancel handling, and subscription tests. Preserve the existing bounded event protocol and synchronous idempotent `unsubscribe()`.

Add readonly `Subscription.closed`, resolving without rejection to released only when owner capacity is actually retired or that owner generation is definitively gone. Cancellation acknowledgement or local removal alone is insufficient. Lost/failed confirmation resolves to unknown with an error. Retain only completion bookkeeping needed for terminal acknowledgement.

Apply the same retirement discipline to registration failure before a handle is returned. The plugin client must serialize subsequent registration behind its cleanup or expose failed cleanup to subsequent calls. React must not be expected to retire a handle it never received.

Acceptance checks hold and lose terminal acknowledgements, delay cancellation, rapidly unsubscribe/reacquire, end the owner generation, and fail initial/replacement registration or deferred activation. Check actual owner reservation counts against the existing 32-per-client/128-per-mount limits, not only local listener counts. No ignored `closed` promise can cause an unhandled rejection. Run existing direct, worker, bounded-load, acceptance, two-tab and packed-consumer subscription checks. Record independent and combined overhead with no subscribers.

## P2. Package, providers and commands

Create `packages/react` following the repository's library build, declaration, license and export conventions. Start with `src/volume.tsx`, `resources.ts`, `errors.ts`, `persistence.ts` and a small public entry, without introducing empty abstraction layers. React, compatible core, and `@opfs-vfs/plugin-subscriptions` are explicit peer dependencies, with workspace/dev dependencies for local builds and tests. The application installs the subscriptions peer for both its worker implementation and the SDK's page-side request/client functions; the SDK does not own a private regular-dependency copy. Select and test supported ranges rather than assuming package deduplication or the `subscriptions-v1` profile key proves compatibility. Keep React out of core and premium out of community builds. Do not select future published version numbers yet.

The package is public from its first commit and will be published to npm with the first SDK release. Publishing is automatic: with `NPM_PUBLISH_ENABLED` set, `changeset publish` releases any public package version not yet on npm once no changesets are pending, so merely withholding a React changeset is insufficient. The publication guard is merge order instead. P2–P6 layers stay in the open stack and do not merge to `main` until P7 evidence is complete; they then merge together with the release change. Core prerequisite layers (P0–P1d) may merge earlier because they carry no changesets and publish nothing. Local packing and installed-consumer checks exercise the public package's intended contents.

Implement these pieces in order:

1. Public types and compile-time consumer checks for the provider union, managed-only close, generation-pinned handle, resource discriminated unions, and bytes/text overloads. Export exactly the v1 symbol, provider, six hooks, three read components and public types once their work packages are implemented; do not ship temporary stubs.
2. Immutable linked contexts, nearest exact lookup, and `DEFAULT_VOLUME` as one module-local symbol. Omitted selection always means that symbol, including under named providers. Reject empty names/arbitrary symbols and throw missing-binding/configuration errors during render. Alias changes affect lookup only.
3. Inert render-time bindings; acquire/reserve managed entries synchronously in committed effects before awaiting initialization. Compare normalized non-secret configuration and plugin profiles, append/validate one subscriptions request, and keep worker factories/plugin options construction-only. Inline factories remain valid. The first compatible committed acquisition wins.
4. One page-realm managed registry by basename, attachment tokens for stale effects, and one resource-store identity for the same actual client across managed and borrowed providers. Borrowed clients never acquire SDK ownership. Separate borrowed client objects remain separate stores even with the same basename.
5. Lifecycle state and actual allowlisted command objects, not type-only restrictions over a raw client. Wrap P1a generation handles without reimplementing dispatch. Preserve buffers on whole-file writes. No optimistic updates, implicit sync or write retry.
6. `VolumeError` normalization and reporting. Publish state before callbacks; catch reporter exceptions. Attribute commands to their producing binding and physical basename. Resource failures are once per attempt per consuming provider; lifecycle/persistence failures once per event/revision per attached provider. New providers see state without replaying old callbacks.

Lifetime acceptance must exercise two roots, compatible and conflicting aliases, default/string-default/shadowing, unsupported environments, invalid options, equivalent inline options, changed physical identity, and keyed remounts. Strict Mode and abandoned renders must create no duplicate client or unowned registry entry.

On last unmount retain managed clients but drop unused read/listener state. Explicit close invalidates every alias immediately, shares one promise, retains a flush error in closed state, and evicts only the matching entry when settled. A provider meeting a closing entry observes its closed outcome, never an automatic reopen. Closed bindings remain tombstones after another mount opens fresh.

On terminal initial/unsupported/takeover failure, dispose partial resources and remove the reservation before publishing failure. Immediately remount with fresh inputs in the test; it must not reuse rejected credentials or a cleanup reservation. Drop SDK-owned construction inputs after handing them to core and on every failure/close path. Replacing a successful retained client's construction inputs requires explicit close and fresh mount; a keyed remount alone does not replace them. Externally closed borrowed clients invalidate state and handles without the SDK calling their close method.

Test imports in Node without browser globals and matching server/first-hydration pending snapshots. Exercise React Actions that capture handle/path/bytes when queued and key Action state by generation, including a write succeeding before sync fails. UI must retain the save failure and never show saved from a browser grant or a later command's not-applied outcome.

Done when provider, command and reporting tests pass against real P1a/P1b clients. Persistence reporting becomes complete when P1c is integrated; package publication remains blocked until then.

## P3. Live reads and recovery

Keep the resource store React-independent. Hooks adapt it with `useSyncExternalStore`; `Folder`, `File`, and `FileContent` call their matching hooks. Implement and review the following slices in order.

### Shared ordinary reads

Key active resources by generation, kind, exact validated path, format and byte limit. Rendering and snapshot lookup neither insert shared resources nor perform I/O. Committed subscriptions observe binding lifecycle, attach/recheck, and acquire the current resource once ready. Changing attachment, generation, volume or key cannot reuse another key's data. Disabled reads validate inputs, return idle, release data/watch interest and make refresh a resolved no-op.

Use `readdirEntries`, `stat` and one `readFileBuffer` command for their respective results. Follow core link semantics. Missing file/content is successful null, missing folder is an error, and file metadata for a directory is EISDIR. Expose only the six specified `FileInfo` fields. Validate content limits before I/O: integer 0–16 MiB, default 16 MiB. Text decoding uses UTF-8 replacement semantics and applies the byte limit before decoding.

Await root registration before initial reads; do not treat registration as an atomic snapshot or deferred-activation barrier. One recursive `/` watch with `content: false` serves active resources on a client. Last release invalidates records and clears data; a late registration must retire immediately. Reacquisition waits for P1d confirmation, with at most one registered or retiring SDK root per client. Unknown retirement blocks further registration for that client/generation, including manual refresh, while explicit filesystem commands remain available when core is ready.

### Scheduling and invalidation

Use one FIFO drain and one in-flight resource attempt per client, with one queue membership per key. Clear dirty before dispatch so an event during a read schedules a following attempt at the tail. Refresh during an in-flight read also requests a following attempt. Waiters settle after their requested attempt or on interruption/release/generation end; they never wait across an unlimited retry chain. Read failures are represented in snapshots; refresh does not produce a second rejection for the same failure.

Publish only for matching resource, client generation and watch session. Initial errors have no data; same-generation refresh errors retain data explicitly stale. Preserve equal data references and stable snapshots; compare folder/metadata fields, text and bytes as specified. Document shared byte arrays as read-only and test that writes do not detach them. Do not retain inactive content or an event history.

Resolve file and folder dependencies with `realpath`. Ordinary file updates target resolved file/content paths and containing resolved folders. Every other event broadly invalidates resources and resolved dependencies; unresolved dependencies are conservative. Guard dependency publication with a namespace epoch as well as resource/generation/session identity. Reset dependencies after watch replacement and resume reconciliation. Display initial results even amid writes, marked stale if a following read is queued.

### Watch recovery

Classify terminal codes before registration phase. Overflow/resync-required, including setup rejection before a handle exists or deferred-activation failure, uses one paced recovery operation after confirmed retirement: 1, 2, 4, 8, 16, then 30 seconds. Settle interrupted attempts/waiters immediately, discard candidate data/dependencies, and await an already-sent read's settlement before another read starts. Subscribe before the recovery scan. Reset backoff after the full scan settles plus 60 healthy seconds, or on new owner generation. Keep one timer and cancel it on last release, generation end or disposal.

Other registration/callback failures and interruption with a still-ready owner are visible and manual-retry only after retirement. Manual refresh joins scheduled recovery without bypassing delay. Unknown retirement cannot be bypassed. When core is recovering with no owner generation, clear old data and handles, then wait for a ready successor and fresh watch/scan. Core cannot distinguish page resume from owner loss through this public state, so a same-generation ready return also rescans only after confirmed retirement. Do not infer owner loss solely from `SUBSCRIPTION_INTERRUPTED` or claim convergence while writers continuously overload delivery.

Acceptance checks cover the design's complete read/recovery timelines, in particular:

- 100 consumers of one folder share one initial listing; 100 active keys use one root watch. Alias/root teardown leaves still-used resources intact. Hooks and render callbacks give equivalent states.
- Events during resolution/read, retargeted symlinks, folder aliases, hard links, parent rename, chmod/utimes, deletion, partial mutation, missed namespace events and default atime behavior converge without loops. Mutations through another compatible client/tab, SAB and supported direct adapters are observed.
- Repeated same-generation overflow, setup-time overflow without a handle, delayed/lost retirement, manual refresh during backoff, and last release during registration/recovery remain bounded. Every refresh waiter settles. No obsolete candidate or late completion publishes.
- Core readiness remains usable with a failed watch. Initial pending hooks attach after readiness, recover after generation change, and clear bytes on external borrowed disposal. Changing path/format/limit/volume and toggling enabled never exposes the previous key's data.

Done when the integrated store, hooks and components meet these checks with real workers/subscriptions and deterministic failure injection. A fake source alone is insufficient.

## P4. Persistent-storage grant requests

Implement the independent page-local store and `usePersistentStorage()` without requiring a volume provider. Start `persisted()` checking after commit; server and initial hydration state is checking. API absence is unsupported, false is not-granted, and rejection is an error in this store. `request()` resolves after state settles, checks an existing grant and shares in-flight work. Manual retry after denial is allowed.

Provider `persistentStorage` defaults to manual. Opt-in request-on-mount shares one page-session automatic-attempt flag set before requesting. Joining an existing manual request consumes that opportunity; denial/error does not reset it. Verify concurrent providers, Strict Mode, unmount/remount, manual/automatic races, unsupported APIs, false, rejection and explicit retry. There must be no request during render, due to a failed read, or on every mount. Grant state neither blocks volume readiness nor reports write durability.

## P5. Verify the real premium plugin

Use a separate private installed-consumer fixture with the actual encryption plugin, subscriptions plugin, application worker and prepared encryption request. Pin both the exact packed core and subscriptions artifacts from this implementation, recording source commits, package versions and SHA-256 digests. Verify both digests before the composition test; the current private script checks the core digest but only validates the subscriptions manifest. Align `core-artifact.json`, the private workspace override, and encryption's exact core peer/dev versions, then run `prepare:core` with `OPFS_VFS_CORE_TARBALL`; changing only the JSON pin is insufficient. Supply the same selected `OPFS_VFS_CORE_TARBALL` and `OPFS_VFS_SUBSCRIPTIONS_TARBALL` to `pnpm --filter @opfs-vfs/plugin-encryption test:subscriptions-packed`. Regenerate the private lockfile through its preparation workflow and run the relevant premium package/packed checks. This procedure also applies to each affected independently released P1 artifact. Public builds/tests must remain usable without premium registry access; private access failure is a blocked integration gate, not a passing simulation.

Test wrong initial credentials followed by immediate keyed remount with corrected inputs; a wrong-secret follower becoming ready through an unlocked owner and failing takeover; close during reads/writes; external borrowed close; generation invalidation; explicit close/fresh-client reopen; persistence failures; and passkey enrollment's create-new requirement. Assert secrets never enter SDK keys, diagnostics, reporters or configuration comparisons. Verify the SDK drops all owned plaintext/candidate/listener references and rejects late results, while documenting that application copies and JavaScript heap zeroization are outside that guarantee.

Inspect installed community artifacts for premium/crypto imports and ensure public worker examples use only community packages. A private demo may ship only where private build access is available; its deployment is optional, but real premium integration evidence is required. A clearly labeled simulation cannot replace it. Local close must not be presented as revoking another tab's access.

## P6. Demos, documentation and consumer builds

Add the React section under `apps/website/src/content/docs/docs/react/`, register it in `apps/website/astro.config.mjs`, and write `packages/react/README.md`. Cover application-worker setup and required headers, symbol/named lookup, managed versus borrowed ownership, explicit close and retained-worker cost, ordinary reads, render callbacks, Actions/save conflicts, typed errors and recovery, persistence requests, premium setup and API reference. Document one resolved SDK copy, shared read-only bytes, unsupported/SSR behavior, supported mutation-observation paths and the limitations of persistence and local close.

Build `/demos/react/` with a two-volume explorer and conflict-aware editor. Reuse website styling and preview components; do not create a UI framework. Show loading/error/stale states, expected-content conflict, write-then-sync failure, second-tab updates, explicit persistence opt-in and deliberate cleanup. Use dedicated demo basenames, never discover/delete unrelated volumes, and inject unsafe failures deterministically. Verify keyboard controls and announced pending/error state. Public deployment of the premium demo is conditional as described in P5.

Create small installed-package consumer fixtures for Vite, webpack and a Next client component, including their actual application workers and cross-origin-isolation headers. Build from packed artifacts, not workspace source aliases. Check worker imports, package exports/declarations, duplicate React/SDK resolution, and that browser storage starts only on the client. Record the actual resolved core and subscriptions versions/artifact identities in both the SDK page bundle and application worker bundle. Test the intended pairing and deliberately mismatched/cached pairs against P1a's compatibility matrix; matching `subscriptions-v1` strings or declaring peers alone is not a pass. Test actual Node imports and SSR/hydration; browser-side server rendering alone is not sufficient. Choose and record the Next supported boundary/export setup from a working build rather than assuming a directive survives bundling.

Run supported real-worker paths in Chromium, Firefox and WebKit. Where required capabilities are absent, verify the explicit unsupported UI and record the limitation rather than skip silently or mock readiness. Exercise default and nondefault supported storage modes and production website headers. All examples must compile against the chosen artifacts and docs must describe implemented behavior only.

## P7. Release evidence and publication readiness

Maintain `docs/REACT-SDK-ACCEPTANCE.md`, created in P0, as the single evidence index with source commits, package/tarball identities and digests, commands, React/browser versions, fixtures, links to raw samples in `docs/benchmarks/react-sdk/<run-id>/`, outcomes and unresolved failures. Attach or link it from implementation PRs. Do not mark a gate complete because only a mock, workspace import, or Chromium run passed.

### Correctness and compatibility

- Every P1–P6 acceptance item and the design's required behavior table has a named runnable check and recorded result. Exercise race guards by removing/bypassing the guard under test and confirming the corresponding scenario fails, then restore it. Prefer public-interface outcomes and real workers to tests of private implementation structure.
- Test React 19.0.0 and the latest stable 19.x available at release, recording actual versions. The proposed peer range is `>=19.0.0 <20`; this plan does not claim it is already verified. Include development Strict Mode and production consumer builds.
- Check packed React/core/subscriptions artifacts together and select real released peer/dependency ranges that include all prerequisites. Reuse the subscriptions packed-test approach. Broaden ranges only with compatibility evidence; rerun the private fixture with both exact core and subscriptions artifacts. Repeat P1a's mixed-build owner/follower and page/worker matrix for the final candidates, in addition to matching-artifact tests.
- Check bundle exports for only the intended runtime allowlist, no Suspense stubs, no premium import, and no React/query/crypto dependency introduced into core. Verify ESM/types and the browser/server entry behavior from consumer builds.

### Performance and memory

Performance runs began after implementation completed. This timing instruction did not waive the release measurements, comparison budgets, or structural correctness gates below.

Repeat deterministic same-machine, same-browser warm/cold workloads with warmups and multiple samples. Compare each P1 prerequisite to the original no-observer baseline, then their combination. Investigate any reproducible throughput/median-latency regression above 5% or p95 above 10%, accounting for measured baseline variability. High noise is inconclusive, not a pass; rerun under controlled conditions. These are the design's proposed acceptance budgets, not promised measurements.

Compare the SDK against direct worker plus subscription usage for 1/100 active resources, 100 consumers of one folder, 10,000-entry folders, 1 KiB/1 MiB/16 MiB files, burst/continuous writes, two tabs and actual encryption. Record command counts, transferred bytes, startup, main-thread time, retained/peak memory and convergence after writers stop. Include byte-equality cost and old/new buffers in peak memory. Verify no SDK-caused main-thread task exceeds 50 ms in the recorded 100-resource workload on the test machine.

Structural gates are exact: one compatible managed client per basename; one registered or retiring root per active client; one initial listing for 100 shared consumers; one queue membership per key; no I/O on unrelated renders; no inactive content retention; no atime feedback loop. An unrelated file update must cause zero content reads for 100 resolved 1 MiB resources elsewhere, while namespace events still invalidate broadly. Measure event/ack overhead, paced overflow and fairness. Keep serial reads unless measurements identify their queue as the bottleneck and a separately reviewed change preserves ordering/cleanup guarantees.

### Checks and release preparation

Use existing commands from the repository; extend the same patterns for the new package:

```sh
node --test scripts/*.test.mjs
pnpm build
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm deadcode
pnpm --filter @opfs-vfs/opfs-vfs test
pnpm --filter @opfs-vfs/plugin-subscriptions test
pnpm --filter @opfs-vfs/plugin-subscriptions test:packed
pnpm --filter @opfs-vfs/react test
pnpm --filter @opfs-vfs/website test
```

The React command is a deliverable, not an existing script. Add its Vitest browser tests using the current repository tooling. Wire packed React consumers and the release browser/version matrix into CI or a reproducible recorded release job. Update `scripts/ci-packages.mjs` tests if necessary so source/dependency changes select the SDK and affected consumers; the current selector discovers workspace packages rather than using a fixed list. Ensure public CI never needs private credentials. Run the opt-in subscription acceptance/load/two-tab commands for P1d/P3 and retain their results separately from normal unit/browser suites.

Dry-run package packing for core, subscriptions and React, inspect file lists/declarations, add Changesets for publishable prerequisite changes and validate `pnpm changeset status`. This plan-only change needs no package changeset. Land/publish prerequisite core and subscriptions versions before the stable SDK consumes their released ranges, then repeat installed-consumer smoke checks with those published artifacts while the React layers remain unmerged. Do not guess future versions to make a release plan appear complete.

The React package's release history is recorded by `@opfs-vfs/react` 0.0.3 (changeset `5fc8f70`), published as a preview release through the existing automatic publishing workflow. Recheck the packed manifest and release plan for any later release.

Completion means reviewed implementation, passing relevant CI, recorded compatibility/performance/private-integration evidence, working demos and docs, and a valid release plan. Actual package publication remains a separate release action. If evidence fails, fix the cause or explicitly review a narrower contract; do not silently waive a gate to call v1 complete.

### Recorded outcome, 2026-09-27

The public SDK fixture, final-candidate public evidence, and private actual-encryption evidence are recorded in [the acceptance index](../REACT-SDK-ACCEPTANCE.md). The fixture uses the final built artifacts, records raw samples and artifact hashes, and passes its SDK structural checks. The final core A/B record has budget exceptions, so its performance gate is not passed and the authorized optimization follow-up remains open.

Core prerequisite PR 86 (`c627d9c`) is intentionally core-only. It may be considered for its own merge and publication after its normal approvals.

`@opfs-vfs/react` 0.0.3 (changeset `5fc8f70`) documents the existing preview capabilities in the package's release history, with no new runtime behavior. The release notes list:

- `VolumeProvider`, with a built-in subscriptions worker when none is supplied. Automatic transport picks a compatible SharedWorker or falls back to a dedicated worker with an observable reason.
- `useVolume` and `useVolumeClient`, a generation-safe, path-based command handle.
- `useFile`, `useFileContent` and `useFolder`, plus the matching `File`, `FileContent` and `Folder` components.
- `usePersistentStorage`, and `VolumeError` classified by kind and outcome.

The preview requires React 19, the core package and the subscriptions plugin. Global shutdown and deletion remain caller-owned.

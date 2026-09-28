# SharedWorker owner transport

Status: React preview, September 27, 2026. The disposable direct-`OpfsVfs` probe passed the iPhone sequence: the same named SharedWorker owner served B while A was hidden for at least 60 seconds, after A closed while B remained connected, and through close/reopen verification. This is an explicit, opt-in preview transport; the dedicated-worker route stays unchanged.

## Smallest integration

Run one existing `OpfsVfsWorkerClient` owner inside a named module SharedWorker. It reaches the existing worker runtime over an in-process `MessageChannel`; the runtime creates `OpfsVfs` directly in the SharedWorker. There is no nested worker and no second filesystem dispatcher.

Pages keep their existing asynchronous `OpfsVfsWorker` follower, BroadcastChannel command relay, generation checks, descriptor cleanup, status/persistence, subscriptions, remote errors, and React resource store. Add one `followerOnly` mode: after bootstrap confirms the shared owner generation and profile, a page takes its normal per-client lock and follows that generation, but it never promotes itself. It queues a request for the owner lock only to observe its release; that callback ends the follower with an attachment-lost error and never mounts a volume.

SharedWorker ports are real bootstrap/lifetime ports, never cast as `Worker`: the first cloned `ATTACH` contains `version`, `clientId`, `fileName`, expected profile, and the allowed core options plus plugin requests needed to initialize the host. The host validates and snapshots these with the existing option/plugin validation; later attaches compare the volume filename and profile. `READY { generation, profile }` or a serialized typed error returns on the port. Plugin options never appear in BroadcastChannel frames. Pass that `clientId` into the existing follower as its `attachmentId`, so the current owner maps FDs, requests, and file-change channels to the same page identity and cleans them up when its existing per-client lock ends. The port does not carry filesystem commands in this first slice.

The page follower must not start until its port has validated the host generation/profile. `followerOnly` pins that READY generation, rejects stale or different `LEADER_READY` announcements, and becomes terminal on host loss; v1 requires explicit recreation. This prevents an older dedicated owner from winning a BroadcastChannel ready race when the shared host was refused.

## Runtime and admission seam

Refactor `startVfsWorker()` only enough to bind its singleton runtime to a private endpoint. The dedicated entry binds `self`; `startVfsSharedWorker({ plugins })` creates a local `MessageChannel`, binds the runtime to one port, and supplies the other to the in-worker owner. The private endpoint has the message/error/termination behavior the client actually uses; a `MessagePort` is not represented as a public worker type.

Keep the current INIT and command validation, `handleSyncCommand`, `preparePluginRequests`, mount profile, remote-error serializer, persistence emitter, and logical-change routing. The page follower keeps the existing cross-origin-isolation/SAB requirement and `SyncMessenger`. The SharedWorker owner only relays asynchronous commands, so it omits a local `SyncMessenger` and INIT SAB: this supports WebKit SharedWorkers where the page has SAB but the host does not.

Before lock or mount, the host checks OPFS and direct `FileSystemFileHandle.prototype.createSyncAccessHandle` in the SharedWorker. The page's existing support gate still checks isolation/SAB. Missing capability is terminal unsupported. The internal owner then uses one private shared-host admission path: it claims `opfs-vfs-lock-<file>` with `ifAvailable` under the validated normal `open-or-create` input, and the host awaits ready before replying `READY`. It is not the public `claimIfAvailable` option, which intentionally requires explicit open-existing/create-new. `forceLeader` is forbidden because it bypasses that common lock. If the lock is held, bootstrap returns a typed occupied-topology error before mount, never waits for a volume timeout. When a responding owner's profile proves incompatibility, return `VFS_PROTOCOL_MISMATCH` or `VFS_PLUGIN_MISMATCH`; a hidden legacy holder is only known to be occupied, not definitely mismatched.

Use the normal `LEADER_READY` generation after initialization, but make its `profile` a strict shared-owner profile: the validated existing v2 fields plus required `transport: 'shared-worker'`. `ATTACH.profile` has the same shape. Existing exact v2 profile validation rejects the extra field; shared followers validate the full shared profile, then compare its existing v2 plugin/capability fields. The runtime INIT profile remains v2. A pre-gate legacy holder remains an explicit unsupported/occupied case, not a risky mount attempt.

The shared worker factory must use a stable module script URL and fixed per-volume name across tabs. Do not copy a per-tab inline/blob worker pattern: different script URLs may create competing hosts (or be rejected by the browser); the common owner lock safely refuses competition.

## Lifecycle

`closeVfs()` in a page has the current follower semantics: stop local admission, flush only against its captured generation, then release that page's attachment. It never sends `CLOSE_VFS`, so one page cannot close another page's volume.

`shutdownSharedVfs()` is the explicit global operation. A ready follower captures its validated generation, stops its own admission synchronously, and sends the existing generation-bound shutdown relay. The owner stops admission, interrupts follower subscriptions, closes the mounted runtime, releases the common owner lock, and then ends the host. The caller disposes after the acknowledged reply or its bounded error. A stale admin request cannot close a successor. Call `deleteVolume()` only after a successful shutdown; it remains the separate explicit destructive operation. The SharedWorker's lifetime with no ports is browser-controlled; this design adds no idle timer or heartbeat.

The local endpoint's `terminate()` closes only its private `MessagePort`. Once the owner publishes terminal status, the host schedules `self.close()` after the shutdown reply and local cleanup have run. A fatal transport, runtime, init, or close failure follows the same terminal path; ordinary command errors such as `ENOENT` are returned to that caller and do not kill the host. During browser teardown, a competing host can briefly acquire the coordinator lock before the old mount has released its existing volume fence. Its mount receives `EBUSY`, never steals or retries, and pages require explicit recreation after that typed refusal. A failed generation is never reused.

## Plugins, premium, and React

An application supplies a stable named module worker calling `startVfsSharedWorker({ plugins: [...] })`, parallel to its dedicated worker module. Every port accepts exactly one `ATTACH`; malformed or repeated attaches close that port. Page plugin requests still pass through `preparePluginRequests` and the same profile check; a bundled host never accepts plugin code from a page. Native SharedWorkers do not expose reliable port-close notifications, so the existing per-client Web Lock remains the liveness authority that releases FDs, requests, and subscriptions. Premium needs its own shared-host entry with the real registration. It remains unsupported until its packed gate passes.

React selects `transport: 'shared-worker'` and supplies `sharedWorker` before `VolumeProvider` opens anything. Its managed binding bootstraps the port and constructs the follower-only `OpfsVfsWorker`, retaining the current status, generation facade, error mapping, and resource store. There is no automatic fallback after that selection or an attach/mount failure. `useVolumeClient()` intentionally remains generation-bound path operations only. Applications that need global shutdown, deletion, or premium key cleanup retain a raw `createSharedWorkerFollower()` client, use `shutdownSharedVfs()`, then call `deleteVolume()` after it succeeds.

## Implementation and proof gates

1. Extract the endpoint binding; add stable named host bootstrap, guarded owner-lock claim, follower-only mode, and fail-closed endpoint termination. Test lock-held refusal before mount and generation/profile bootstrap races.
2. Run existing owner/follower generation, FD cleanup, status, persistence, subscription retirement, and close-admission tests with a host owner and two page followers. Add the physical iPhone SDK gate: B must relay write/read and subscriptions through the real BroadcastChannel path while A is hidden, after A closes, and through B close/reopen.
3. Add React managed selection, a custom subscriptions host, mixed-build/profile rejection, and explicit global shutdown/delete/reopen proof, then the packed premium host gate: encrypted reopen, follower relay, subscriptions, and global shutdown.

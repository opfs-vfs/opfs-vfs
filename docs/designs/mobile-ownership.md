# Mobile ownership probes

Status: the nested-worker SharedWorker candidate is rejected for the tested browser builds. The direct-`OpfsVfs` SharedWorker candidate passed local persistent-WebKit checks and the user's physical iPhone background, creator-close, and reopen checks on 2026-09-27. Cleanup has not yet been reported for that device run. The dedicated-worker liveness probe failed its bounded responsiveness check in a user-reported iPhone Safari run on 2026-09-27. These experiments do not change the normal worker-client transport, React provider, or React SDK demo.

## Observed failure

On iPhone Safari, an already-ready page owner kept its Web Lock while hidden and did not serve a second tab's readiness handshake. The follower pinged at 22:33:32.906 and timed out at 22:33:47.908; the owner first processed queued pings and sent ready replies at 22:39:10.503, about 3 ms before its recorded visible event at 22:39:10.506, around foreground return. The saved data and original generation remained usable. This proves the hidden owner did not serve the observed 15-second window. It does not distinguish page-JavaScript suspension from delayed BroadcastChannel delivery, and it does not establish per-message latency because pings have no request IDs.

A controlled Chromium replay held a real owner lock, paused only owner message dispatch, let a follower time out and dispose, then delivered the queued ping. It produced the same late-ready shape while preserving synchronized data. The replay models the sequence; it is not an iPhone freeze reproduction.

## Rejected SharedWorker host

The proposed host was a SharedWorker retaining the current owner client and Web Lock while pages remained ordinary followers. Its dedicated application worker would still be the only OPFS synchronous-access-handle user. This was intentionally capability-gated before any core client or page fallback could start.

The isolated gate loads a module SharedWorker, then requires a nested module dedicated worker, `SharedArrayBuffer`, and a disposable OPFS sync-access-handle write/flush/close/remove. The parent removes the uniquely prefixed disposable entry after a nested-worker error or timeout and reports `native-cleanup-failed` rather than readiness if cleanup cannot be confirmed. Its fixed report contains only terminal state, fixed reason, and user agent.

On 2026-09-27, the fixed route returned these terminal stages:

| Browser build                     | Result                            |
| --------------------------------- | --------------------------------- |
| Chrome 154.0.8037.57              | `nested-worker-unavailable`       |
| Repository Chromium 147.0.7727.15 | `nested-worker-unavailable`       |
| WebKit 26.4                       | `nested-worker-unavailable`       |
| Firefox 148.0.2                   | `shared-array-buffer-unavailable` |

The modern-browser-only target is not met: current Chrome also lacks the nested-worker primitive. The Firefox result matches the current core client’s unconditional `new SharedArrayBuffer(...)` construction before initialization. It does not establish whether an HTTPS or otherwise isolated deployment would change that result. Safari 27 and the user’s installed iPhone Safari remain untested for this SharedWorker probe. No nested application worker, core client, page follower, retry, lock steal, or page-owned fallback was started in these runs.

## Direct `OpfsVfs` SharedWorker probe

This is a separate candidate from the rejected nested-worker host. It mounts direct `OpfsVfs` in a named module SharedWorker, without `WorkerClient`, `SharedArrayBuffer`, or a nested worker. The [WebKit `FileSystemFileHandle` IDL](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/filesystem/FileSystemFileHandle.idl) exposes `createSyncAccessHandle` to workers, so this route first checks that method and `navigator.storage.getDirectory` before it constructs a VFS.

For one UUID session, the worker creates a uniquely named disposable volume with `openMode: 'create-new'`. `OpfsVfs` then owns its existing volume Web Lock and exclusive sync access handles. Both pages attach to the same named worker and receive fixed, serialized commands only: write a generated marker, `syncSync()`, and read it exactly; cleanly close, reopen with `open-existing`, and read the retained marker; then cleanly close and delete the disposable volume. A mount, close, or command failure is terminal and avoids deletion; a cleanup failure is terminal and reports the scratch volume. There is no user-volume mount, page-owned fallback, lock stealing, or mutation retry after a timeout.

If a page does not receive a command reply within its bounded deadline, it reports an `indeterminate` outcome, retains the scratch volume identity, disables further actions, and does not retry. The command may have completed after that page-side timeout, so this is deliberately not reported as a definitive operation failure.

Chrome and Firefox lack the sync-access-handle feature in this SharedWorker route, so it reports an explicit unsupported result without constructing `OpfsVfs`. The local WebKit check must use a persistent Playwright context: the project’s ordinary ephemeral context reports a storage `UnknownError`, which is a runner limitation rather than a device result. A persistent WebKit 26.4 run validated A writing marker 1, B writing marker 2, A closing, B writing marker 3 with the same owner, then clean close/reopen verification and deletion. This does not establish iPhone behavior or production transport compatibility.

### Physical iPhone result

On 2026-09-27, the user supplied three screenshots from the same session and explicitly confirmed the timing and tab sequence:

| Step                                              | Operation             | Result                                       |
| ------------------------------------------------- | --------------------- | -------------------------------------------- |
| B after A had been hidden for at least 60 seconds | `write-sync-read`     | `ready`, `outcome: known`, marker 2          |
| B after A closed                                  | `write-sync-read`     | `ready`, `outcome: known`, marker 3          |
| B closes and reopens the volume                   | `close-reopen-verify` | `ready`, `outcome: known`, retained marker 3 |

All three reports have `reason: null`, the same session, and the same owner ID. This establishes successful synchronized writes while the creator tab was backgrounded, continued service after that tab closed, and saved content after reopening on the tested iPhone. It does not establish cleanup, which the screenshots do not show, or arbitrary suspension durations.

The direct-core device test supports proceeding with a production integration design. The normal SDK transport is unchanged, and plugin, premium, subscription, mixed-build, and client-lifecycle compatibility still require implementation and validation. See [SharedWorker transport](./shared-worker-transport.md) for that next design. Before ending the disposable test, use its explicit cleanup action and retain the result.

## Dedicated-worker liveness hypothesis

The smaller candidate keeps a disposable Web Lock and BroadcastChannel nonce responder in a dedicated worker created by page A. Page B atomically checks that the lock is held, sends a nonce, and accepts only the matching owner response. The route is a liveness probe, not an OPFS transport, so it makes no claim that an OPFS owner can move to this worker yet.

The normal two-tab baseline has validated held-lock, matching nonce, and owner-close behavior in Chrome 147/154 and Firefox 148. A valid CDP `Debugger.pause` check also paused page A JavaScript (its timer did not run) while B completed a 250 ms check and matching nonce challenge in Chrome 147/154; after resume, A's timer fired. This demonstrates dedicated-worker independence from that page's JavaScript execution. It does not demonstrate browser or iOS operating-system suspension.

On 2026-09-27, the user supplied challenge-tab results from the iPhone procedure. Before closing A, B's bounded challenge returned the fixed report (with its opaque session omitted): `{"role":"challenge","state":"owner-no-response","lock":"held-by-owner","ownerId":null,"responseMs":null}`. The screenshots show the challenge-ready state followed by that result. The dedicated-worker candidate therefore failed bounded responsiveness on this iPhone while its lock was held. This does not identify whether the cause is iOS scheduling, browser scheduling, or BroadcastChannel delivery, and it does not rule out every dedicated-worker topology. It does show that moving this responder into an ordinary dedicated worker is insufficient as a product correction for the observed device.

The user's follow-up after closing A, in the same session, returned `{"role":"challenge","state":"owner-no-response","lock":"available","ownerId":null,"responseMs":null}`. That provides the expected after-close lock result; `owner-no-response` is expected because the owner has closed.

The device collection remains: open `/demos/dedicated-owner-probe/` as A and wait for `owner-ready`; open its same-session link as B; hide A; tap B’s challenge; copy the fixed JSON output from both tabs; close A and tap B’s challenge again. Share only that report (`role`, opaque `session`, state, lock outcome, opaque owner id, and response time). The probe must never steal the lock or keep polling.

## Requirements before a product topology

A production design must prove one exclusive writer; active B read, synchronized write, and subscriptions delivery while A is hidden; explicit safe close before deletion; profile/plugin compatibility; and retained mismatch refusal. Premium, SAB, mixed-build, and private-worker configurations need separate exact-worker tests. It must also define follower-only admission: ordinary followers retain queued owner-lock requests and can otherwise promote after a coordinator dies. `attachTo` is observer-only and cannot supply writable followers.

Until a candidate passes the real iPhone device gate and those compatibility checks, the existing safe handoff remains manual: await `sync()`, await `closeVfs()` in the owning tab, then open or reload the other tab. This is not equivalent to background ownership recovery.

## Reproduce the local checks

Build the website with `pnpm --filter @opfs-vfs/website... build`, then run:

```sh
CI=1 WEBSITE_TEST_PORT=4399 pnpm --filter @opfs-vfs/website exec playwright test tests/mobile-owner-probe.spec.ts tests/dedicated-owner-probe.spec.ts
```

Set `PLAYWRIGHT_BROWSER=firefox` or `PLAYWRIGHT_BROWSER=webkit` for the other engines. Both checks passed in repository Chromium 147, Firefox 148, and WebKit 26.4. This validates the diagnostic tools, including explicit unsupported results. It does not make the SharedWorker candidate supported. The existing React demo's three Chromium tests also passed.

The Chromium dedicated-worker test pauses the owner page's JavaScript, verifies its timer remains stopped, challenges the worker from another page, then resumes the page. It also rejects a fake nonce responder when no owner holds the lock. Removing that lock check made this assertion fail; restoring it passed. These local checks do not reproduce the physical-device failure reported above.

# iOS Safari storage owners independent of a tab

Device update, 2026-09-27: the user has since confirmed a successful physical iPhone run of the direct SharedWorker VFS probe. B wrote after A had been hidden for at least 60 seconds, continued writing with the same owner after A closed, and retained the last marker after close/reopen. Cleanup has not been reported. The investigation below records the evidence available before that run; [the ownership record](../designs/mobile-ownership.md#physical-iphone-result) has the confirmed device results. Production SDK integration remains separate.

Research snapshot: 2026-09-27. This compares browser APIs and existing SQLite/WASM storage implementations for a shared owner that stays available while a page is backgrounded. It does not infer the installed browser release from the reported user agent: the ownership notes record iOS 18.7 and “Version 26.6.1”, while WebKit 26.4 was tested separately ([mobile ownership probe](../designs/mobile-ownership.md)).

## Findings

The leading candidate is a SharedWorker that directly owns OPFS through the repository’s existing synchronous OPFS VFS. The File System Standard exposes createSyncAccessHandle() and FileSystemSyncAccessHandle to DedicatedWorker only ([WHATWG File System Standard](https://fs.spec.whatwg.org/#api-filesystemfilehandle)). Current WebKit source instead marks createSyncAccessHandle() Exposed=Worker ([WebKit FileSystemFileHandle.idl](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/filesystem/FileSystemFileHandle.idl#L31-L39)); Web IDL uses Worker for dedicated and shared worker globals ([Web IDL](https://webidl.spec.whatwg.org/#Exposed)). A wa-sqlite discussion commenter reports direct OPFS use from SharedWorker on macOS Safari and iOS 18.4+; this is user testimony, not a vendor guarantee ([discussion](https://github.com/rhashimoto/wa-sqlite/discussions/81)).

Root’s runtime experiment confirmed direct WebKit 26.4 SharedWorker sync-handle use end to end: create, write, flush, read, close, and remove all passed in a persistent Playwright context. In an ephemeral context, getDirectory() returned UnknownError. Playwright documents that OPFS is unsupported in ephemeral WebKit contexts ([BrowserContext docs](https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsercontext.md#L1621-L1629)). Chromium 147 and Firefox 148 reported the method as undefined. This confirms the direct approach in the tested persistent WebKit environment, not on the user’s iPhone or in the background-tab scenario. Safari is a promising platform-specific path; retain the physical iPhone background responsiveness test as the deciding gate.

The prior nested-worker wrapper remains rejected by its recorded gate: Chrome 154 and WebKit 26.4 returned nested-worker-unavailable; Firefox 148 failed the SAB gate ([observations](../designs/mobile-ownership.md#rejected-sharedworker-host)). Direct SharedWorker OPFS avoids both nested workers and SAB. The persistent-context distinction matters: an ephemeral automation context can report OPFS unavailable even where a persistent browser profile supports it.

## Options matrix

| Owner                                                   | Storage                   | Evidence and tradeoff                                                                                                                                                                                                                                                                                                                                                                                                        | Assessment                                                                                                                          |
| ------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| SharedWorker directly owns OPFS                         | Sync access handle        | Current WebKit IDL exposes the method to Worker and root’s persistent WebKit 26.4 run passed create/write/flush/read/close/remove. The standard still says DedicatedWorker-only ([WebKit IDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/filesystem/FileSystemFileHandle.idl#L31-L39), [standard](https://fs.spec.whatwg.org/#api-filesystemfilehandle)). Chromium 147 and Firefox 148 had no method. | Current prototype’s best candidate. iPhone background responsiveness remains unverified.                                            |
| SharedWorker directly owns OPFS                         | Async FileSystem APIs     | The standard exposes file and writable-stream APIs to Worker. Independent project wa-sqlite has an OPFSAnyContextVFS example using async calls; it warns writes become very slow as files grow ([VFS comparison](https://github.com/rhashimoto/wa-sqlite/blob/master/src/examples/README.md#vfs-comparison)).                                                                                                                | Alternate adapter if direct sync access is unavailable; not a drop-in for the current VFS.                                          |
| SharedWorker directly owns IndexedDB                    | Async transactions        | wa-sqlite documents IDBBatchAtomicVFS across Window, Worker, SharedWorker and service worker; IDBMirrorVFS is RAM-bounded ([project docs](https://github.com/rhashimoto/wa-sqlite/blob/master/src/examples/README.md#vfs-comparison)).                                                                                                                                                                                       | Alternative storage adapter, not a drop-in for OPFS.                                                                                |
| SharedWorker hands ports to a tab-owned DedicatedWorker | Sync OPFS                 | The wa-sqlite design uses a SharedWorker to pass MessagePorts while the service belongs to a tab and migrates when that tab closes ([project discussion](https://github.com/rhashimoto/wa-sqlite/discussions/81)).                                                                                                                                                                                                           | This retains a page-owned service lifetime risk; this task has not tested port transfer as a remedy for the BroadcastChannel delay. |
| ServiceWorker coordinates pages                         | MessagePorts / event work | The Service Worker spec allows user agents to start and terminate workers independently of documents ([lifecycle](https://w3c.github.io/ServiceWorker/#service-worker-lifetime)). A wa-sqlite example uses it to connect page ports ([project discussion](https://github.com/rhashimoto/wa-sqlite/discussions/81)).                                                                                                          | Possible connector; not evidence for a continuously live database owner.                                                            |

An additional async-storage implementation is opfs-worker 2.2.1. Its package documentation offers createOPFSShared(), but uses an async backend with no file descriptors and is therefore an alternate storage adapter, not the current VFS ([package README](https://www.npmjs.com/package/opfs-worker)). wa-sqlite is an independent project; its examples are not a production warranty.

## Implemented physical-device procedure

Use `/demos/shared-volume-probe/` in two iPhone tabs. It starts one named
SharedWorker and mounts a uniquely named disposable OpfsVfs volume directly in
that worker. It does not create a nested worker, acquire a separate native
probe lock, run nonce challenges, or fall back to `createWritable()` when the
sync-handle route is unavailable. Missing direct capability is a terminal
diagnostic result; never use a production volume.

1. In A, wait for `ready` and open the same-session link in B. Confirm both
   reports have the same owner and disposable volume identity.
2. Write, sync, and read from A and B. The marker in each fixed report comes
   from the direct OpfsVfs owner. Treat `indeterminate` as an unknown outcome;
   do not retry it.
3. Hide A for at least 60 seconds. From B, repeat write, sync, and read, then
   record the report.
4. Close A while B remains connected, then repeat B’s write, sync, and read.
   The SharedWorker remains the owner; closing A alone must not release it.
5. In B, explicitly close, reopen, and verify the marker, then clean up the
   disposable volume. Cleanup closes the shared VFS before delete and reports
   its terminal result.

This route tests the direct core probe and its cleanup lifecycle on that
device. Subscriptions, profile/plugin compatibility, and the product React
transport remain later integration gates; this diagnostic does not claim them.

## Source limits

- The iPhone report and local browser gate are repository/user observations, not vendor guarantees; preserve their scope as described in [mobile-ownership.md](../designs/mobile-ownership.md).
- The iOS 18.4+ result is a community report. The local WebKit 26.4 persistent-context test proves storage calls there, not on the target iPhone or in its background-tab state.
- Check the physical iPhone in a persistent profile; Playwright documents that OPFS is unsupported in ephemeral WebKit contexts ([BrowserContext docs](https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsercontext.md#L1621-L1629)).

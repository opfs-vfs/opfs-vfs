# iOS Safari OPFS coordination research

Device update, 2026-09-27: the user has since confirmed a successful physical iPhone run of the direct SharedWorker VFS probe. B wrote after A had been hidden for at least 60 seconds, continued writing with the same owner after A closed, and retained the last marker after close/reopen. Cleanup has not been reported. The investigation below records the evidence available before that run; [the ownership record](../designs/mobile-ownership.md#physical-iphone-result) has the confirmed device results. Production SDK integration remains separate.

## Scope and observed facts

OPFS VFS is a custom filesystem, not a SQLite VFS. SQLite, wa-sqlite, and
related reports below are comparative evidence about lock lifetime and failure
semantics. They do not support replacing OPFS VFS with SQLite `opfs-wl`,
OPFSCoopSyncVFS, or another SQLite VFS as a direct correction.

The user-run iPhone dedicated-worker probe established two bounded observations
for one opaque session. While tab A was hidden, tab B reported
`owner-no-response` with `lock: held-by-owner`; after A closed, B reported
`owner-no-response` with `lock: available`. The first result proves that the
probe did not receive its bounded nonce reply while the lock was held. The
second is the expected release observation after close. Neither identifies the
reason for the missing reply, its duration, or every possible worker topology.

Earlier core diagnostics showed a queued readiness reply around foregrounding.
That is a separate observation from the probe. Together, the observations do
not establish whether the device deferred page execution, worker execution, or
message delivery. They rule out treating a held lock as evidence of a
responsive owner.

## Capability boundary

The File System Standard exposes `createSyncAccessHandle()` to a
`DedicatedWorker` ([standard](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle)).
Current WebKit source instead declares `FileSystemFileHandle` with
`Exposed=(Window,Worker)` and declares `createSyncAccessHandle()` with
`Exposed=Worker` ([WebKit IDL](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/filesystem/FileSystemFileHandle.idl)).
That vendor extension makes a direct SharedWorker experiment worth running; it
does not establish support on the reported iPhone or on any other browser.

A local WebKit 26.4 direct-SharedWorker check in a persistent Playwright
context completed actual OPFS operations: create a disposable entry, open a
sync access handle, write, flush, read, close, and delete it. The earlier
`navigator.storage.getDirectory()` `UnknownError` came from an ephemeral
browser context, where OPFS is unavailable in this test environment; it is not
evidence that WebKit lacks direct SharedWorker storage. The current local
Chrome and Firefox checks reported `createSyncAccessHandle` as undefined in a
SharedWorker. These are implementation observations, not a release promise or
a result for the user’s iPhone.

A second persistent-context WebKit 26.4 run exercised the real OpfsVfs core
through one direct SharedWorker: A and B wrote, synchronized, and read through
the same owner; after A closed, B made a third write; close and reopen observed
value 3; then close and delete completed. This establishes that the desktop
WebKit candidate can preserve the core lifecycle in that run. It does not test
the physical iPhone or response while A is hidden.

Every candidate must gate on the actual operation, not a user-agent string or
method presence alone: start the SharedWorker, obtain the OPFS directory,
create a uniquely named disposable entry, open the required handle, perform a
write/read/flush/close sequence, remove the entry, and report cleanup. A failed
operation is terminal for that candidate. It must not silently create a
page-owned owner, memory fallback, retry loop, or lock steal.

## Ranked candidates

1. **Direct SharedWorker host for the existing OpfsVfs core, pending a physical
   device and core capability probe.** This is the highest-value candidate
   because WebKit 26.4 completed both direct disposable sync-handle operations
   and the desktop core lifecycle in a persistent context, and a SharedWorker
   may remain separate from the page that becomes hidden. The next probe must
   repeat those operations on the exact target device. It must contain no
   product volume, migration, or fallback. A successful device probe only
   establishes an available owner primitive; it does not establish background
   responsiveness.

   Before any product integration, validate the existing invariants with the
   real core: exactly one writer; B reads and receives a synchronized write
   while A is hidden; subscriptions still deliver; close completes before
   deletion; and profile/plugin mismatch refusal remains intact. If the
   physical-device operation fails, report that capability failure and keep the
   current product transport unchanged.

2. **Short-held ownership in the existing filesystem, only as a limited
   fallback investigation.** If direct SharedWorker OPFS is unavailable, an
   architecture may reduce an _idle_ owner’s lock lifetime by releasing a
   fully quiescent core at an operation boundary. It may do so only after a
   custom-OpfsVfs design proves flush, close, cache invalidation, and later
   reopen are safe for that boundary. A tab suspended during the bounded
   in-flight operation can still hold ownership; B must report busy or timeout,
   not infer death, retry ownership, delete state, or steal its lock. This
   reduces one failure shape but is not automatic recovery.

3. **Explicit handoff.** The safe current behavior remains user action that
   awaits `sync()` and `closeVfs()` in the owning tab before opening or
   reloading the other tab. It is correct because it waits for the code that
   owns the dirty state; it does not promise availability while an owner is
   hidden or suspended.

## Comparative research, not an implementation prescription

SQLite’s `opfs-unlock-asap` and `opfs-wl` document useful patterns: shorter
lock lifetime can cost I/O, contention needs an explicit busy outcome, and a
lock holder must not be forcibly replaced while its durability state is
unknown ([SQLite persistence](https://www.sqlite.org/wasm/doc/trunk/persistence.md)).
Those patterns are relevant to a future OpfsVfs design, but SQLite’s
transactions, WAL, VFS interfaces, and `Atomics.waitAsync()` gate do not map
directly to this filesystem.

wa-sqlite’s shared-worker discussion and cooperative VFS examples likewise
illustrate release-on-contention and idempotent-operation concerns
([discussion](https://github.com/rhashimoto/wa-sqlite/discussions/81),
[examples](https://github.com/rhashimoto/wa-sqlite/blob/master/src/examples/README.md)).
They cannot demonstrate that a hidden iPhone owner will serve a release
request. PowerSync’s reported iOS initialization timeout is a field warning
against assuming that it will
([issue 808](https://github.com/powersync-ja/powersync-js/issues/808)).

## Implemented physical-device procedure

Use `/demos/shared-volume-probe/` in two tabs on the target iPhone. The route
starts one named SharedWorker and mounts a uniquely named disposable OpfsVfs
volume inside it. It uses the current direct sync-handle core path only: a
missing capability or a failed mount is terminal, with no async-storage or
page-owned fallback. Do not use a production volume.

1. In A, wait for `ready` and open its same-session link in B. Both reports
   must identify the same SharedWorker owner and disposable volume.
2. Write, sync, and read in A and B. Each operation reports its marker from the
   direct OpfsVfs owner; a page timeout is `indeterminate`, not a claim that a
   dispatched operation failed.
3. Hide A for at least 60 seconds. From active B, write, sync, and read again.
   Record the fixed report; do not retry an indeterminate operation.
4. Close A while B remains connected, then repeat B’s write, sync, and read.
   The same SharedWorker owns the disposable VFS, so A closing is not an owner
   release condition.
5. In B, run the explicit close, reopen, and marker verification. Only then
   clean up the disposable volume. Cleanup closes the shared VFS before delete;
   report success or failure and do not touch any other volume.

A successful route run establishes this direct core probe on that device. It
does not yet cover subscriptions, profile or plugin compatibility, or the
product React transport. Those are later integration gates, not claims made by
this diagnostic.

## Source limits

- The iPhone report and local browser probes are observations, not vendor
  lifecycle guarantees.
- The WebKit IDL and persistent-context capability result justify a targeted
  WebKit experiment; they are not a claim about Chrome, Firefox, or the
  reported iPhone’s background behavior.
- Existing SQLite and wa-sqlite material is analogy and comparison only. Any
  OpfsVfs change needs its own correctness and physical-device evidence.

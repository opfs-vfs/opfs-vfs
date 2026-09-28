# Changelog

## 2.0.0

### Major Changes

- 06f3ba8: Store contiguous block runs as extents in metadata snapshots and logs, reducing metadata writes for large files. This changes the on-disk metadata format; existing development volumes must be reset.

  Reject metadata log records with blocks outside the volume during plaintext and sealed replay, preventing corrupt records from expanding the allocation bitmap.

  Require complete metadata log payloads with exact lengths so malformed block tables cannot consume inode attributes or replay partial records.

- Use PolyForm Noncommercial License 1.0.0. It permits noncommercial use, modification, and distribution; commercial use requires separate permission. This is a source-available license, not OSI-approved open source.

- 4b53d24: Prepare the core and subscriptions release for typed generation-bound worker clients, status and close admission, subscription retirement confirmation, mixed-build refusal, and explicit SharedWorker transport.
- 5c1fd40: Default direct mounts, worker clients, and omitted worker INIT storage options to disk buffering and balanced local durability. Previously the defaults were memory buffering and relaxed durability. Explicit options retain their existing behavior, and the PGlite adapter's separate relaxedDurability default is unchanged.

  Disk buffering avoids a full RAM copy of file contents. Balanced mode schedules background synchronization about 150 ms after the first dirty change; this is not a guaranteed crash-loss window. Continue using explicit synchronization at important save boundaries.

- 6477482: Store the durable physical data size and logical extent in metadata snapshots and transactions, removing the extra `.commit` file and flush. Bind every metadata transaction to its snapshot generation inside the sealed record body, retaining a generation transaction after snapshot compaction. Authenticate snapshot extents together with the metadata payload. Update volume inspection so Devtools recognizes closed plaintext volumes in the new format. This changes the on-disk metadata format; existing prerelease volumes must be recreated.
- 1d2c9db: Remove checkpoint records and generation stamps from the data WAL format. Memory-mode sync now checkpoints by truncating and flushing the WAL once. Disk-mode mounts continue to reject non-empty memory recovery logs until they are recovered in memory mode.

  Retry a failed checkpoint truncate or flush before accepting another WAL append, so subsequent strict-mode writes remain recoverable after a crash.

- 2135bbd: Store unwritten disk-mode file pages as holes. Reads return zeroes, writes allocate only touched pages, and `maxTotalBytes` counts allocated disk blocks. This changes the on-disk meaning of block 0 in metadata.

  Count quarantined blocks toward disk quota until sync releases them, and allow writes that need no new blocks when existing usage exceeds the quota. Such writes persist size and timestamp changes with compact attribute records.

- 346abc8: Speed up metadata and memory-mode persistence. Directory log records no longer carry every child name, so creating files in a large directory is no longer quadratic. Memory-mode `flushVfs` and `closeVfs` persist only dirty pages instead of rewriting every file, truncation dirties only the pages it changes, and renames and subtree deletes locate and move their paths with binary search instead of scanning and splicing per entry. The advisory `.bitmap` file is no longer written or read, which saves a write and a flush on every sync; allocation state is always rebuilt from metadata. The on-disk log format changes, and the `frameBitmap`/`parseBitmap` storage exports are removed.

### Minor Changes

- f073ed3: Add opt-in devtools with automatic volume discovery, generation-bound passive worker attachments, real file operations and a browser shell. Add shared lazy file previews and a virtualized text editor. Core provides bounded whole-file operations and conditional writes without exposing passive file descriptors.
- 937aaa4: Add scoped, no-atime completed-operation content capture for logical change contributions. Captures validate their finalized record and path permissions, use bounded copied bytes, and omit unavailable content without affecting the successful filesystem operation.
- 38268dc: Transfer isolated included change-content deliveries across the worker boundary. Logical-change contributors provide a fresh owned buffer for each recipient; core rejects invalid views and releases a failed delivery channel without affecting the filesystem mutation.
- 70ca21e: Add an experimental DuckDB filesystem adapter with persistent database and WAL files, instructions for building a compatible external DuckDB-Wasm engine, and optional browser persistence and failure-recovery tests.
- 16399d4: Replace the public storageFactory option with validated, single-mount storage plugins. Recognize incomplete imports in inspection, opening and deletion, and keep unavailable volumes visible in devtools. Bind follower replies to the current owner generation.

  Support application worker factories and statically registered plugins through the core worker client. Validate request constraints before election and negotiate non-secret plugin profiles on every owner generation.

- c22bc7b: Add an experimental synchronous Wasmer filesystem adapter for live EdgeJS access to OPFS VFS, with a browser demo, compatible host downloads, and fork build instructions.
- 4a93673: Add the closed logical-change contribution and direct file-change channel seams for subscription plugins.
- be4116a: Record completed logical mutations for change contributions, with bounded staging and conservative invalidation after partial failures. Add `writeFileBufferSync` and share its whole-file validation, quota preflight, and operation grouping with worker writes.
- c22bc7b: Add an optional Wasmer SDK 0.14 adapter to copy the `/workspace` tree between OPFS and upstream EdgeJS sandboxes, including explicit synchronization of file changes and deletions.
- 9beeb96: Add bounded file-change channels for owner-local workers and compatible followers, with isolated asynchronous delivery, strict protocol validation, and registration lifecycle accounting.

### Patch Changes

- f8741bc: Reject incomplete contributed storage I/O instead of accepting partial data.
- 2e99341: Fix crash-recovery integrity bugs. Memory mode now makes its recovery logs durable before rewriting pages in place, persists the zero gap of writes past end of file, never reissues inode numbers that surviving recovery records name, and no longer replays data-log deletes over later links. Rename over an existing file is logged as one transaction. Mounts ignore the advisory allocation bitmap, which could hand out blocks that files still own. The quarantine drain and the mount-time repair flush follow the normal data-before-metadata order, and memory mounts keep the commit marker current for storage extensions. Blocks of an unlinked open file are released at last close whichever path removed the last link.
- 148d7db: Harden metadata recovery. Snapshots of files larger than about 500 MB no longer fail to load, deep directory trees load without recursion, and snapshots with invalid geometry, out-of-range blocks, repeated directories or invalid names are rejected. Metadata-log replay applies only complete, checksummed transactions and stops at the first damaged byte instead of skipping ahead or throwing; a log without a valid generation stamp is discarded, and `recoveryMode: 'fail-stop'` refuses a log newer than the readable snapshot. A torn trailing data-log frame is truncated at mount, reads past end of file zero the rest of the caller's buffer, and `deleteVolume` removes metadata files first.
- 95d90c8: Tighten POSIX semantics: `ftruncate` requires a writable descriptor, operations after `closeVfs()` fail with `EBADF`, `O_CREAT|O_EXCL` reports `EEXIST` for a dangling symlink, `O_TRUNC` is validated before creating a file, renaming one hard link over another of the same inode does nothing, type bits always follow the inode kind, directory renames respect `maxPathDepth`, and `existsSync` returns false below a regular file. Writes and reads require `Uint8Array` views, `utimes` rejects non-finite times, symlink targets are capped at 4095 bytes, and descriptor numbers start from a random per-instance base so a failover leader never honours another instance's descriptor.
- 34fd4ee: Remove the three-second delay when joining a volume already open in another tab. Followers now request leader readiness immediately while still waiting for initialization to finish.
- 5a09a9d: Track follower file descriptors in the leader and close them when the follower disconnects or times out during an open. Relayed commands use the worker command deadlines (passive attachments keep failing fast after 5 s for short commands), and stale followers receive a typed leader-change error after failover.

  Probe client locks before accepting previously unseen IDs and forget departed clients after cleanup. Reject queued commands from departed followers so late opens cannot escape cleanup. Preserve cancellations for in-flight opens until they settle, even when unmatched cancellation history fills.

  Automatic descriptor cleanup uses the long worker deadline so it can wait behind a sync or flush without terminating the shared worker.

  Reject old descriptors with a typed attachment-loss error when a follower becomes the new leader, including synchronous calls. A fresh local open that reuses an old descriptor number makes that number usable again.

- 540815b: Fix worker transport and adapter errors. The PGlite adapter maps errors to Emscripten errno numbers by code and DOMException name instead of passing through Linux or legacy DOMException numbers, so a write past `maxFileSize` no longer makes Postgres retry forever as EINTR. Worker initialization honours `initTimeout`, and flushes, syncs, close and full listings get a five-minute deadline. Leaders refuse INIT, CLOSE_VFS and PING relayed by followers, overlapping INITs are rejected, empty writes validate their descriptor, the synchronous listener falls back to polling without `Atomics.waitAsync`, and just-bash `cp -r` rejects copying a directory into itself through a symlink.

## 1.0.1

### Patch Changes

- 87b0d29: Preserve pending file data and metadata when hard-link aliases are removed, replaced, or accessed through an unlinked descriptor. Protect replacement-file buffers during WAL replay and release block mappings after truncation to zero. Expand storage lifecycle, recovery, fault-injection regression coverage.
- 520ecab: Preserve small files and partial final blocks when reopening a cleanly closed memory-mode volume in disk mode. Memory persistence now completes the allocated physical block without weakening recovery of genuinely truncated data.

## 1.0.0

Initial standalone core distribution. Extracted from the combined 0.9.0 library while preserving on-disk formats. Imports and package boundaries are breaking API changes; see README and docs/API.md.

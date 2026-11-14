# @opfs-vfs/effect

## 0.4.0

### Minor Changes

- caf42fe: Require Effect 4.1 or newer. Effect 4.1 changed the `FileSystem` service, so one build cannot serve both 4.0 and 4.1:

  - `stat` now reports `dev`, `ino`, `nlink`, and `blocks` as `bigint`.
  - `lstat` and `readDirectoryEntries` are implemented.
  - `glob` works when given an absolute `root` or pattern. It previously failed with `ENOTSUP`.
  - `open` with `noFollow` fails with `BadArgument`, because the volume cannot refuse a final symlink atomically.
  - `watch` calls `onReady` once the subscription is installed.

  Since Effect 4.0.7, a typed failure that is followed by a failing finalizer reaches the caller as a defect. This applies to volume and descriptor cleanup failures too.

- 0c6dfc4: Breaking: like Node, a non-recursive `FileSystem.remove` fails on any directory, empty or not, with an `Unknown` error whose cause has code `ERR_FS_EISDIR`. Pass `recursive: true` to delete directories.

  `FileSystem.copy` resolves `.` and `..` in the destination the same way as every other operation. A `..` after a missing directory fails with `NotFound` instead of creating that directory, and a copy into itself through such a path is rejected instead of recursing.

### Patch Changes

- caf42fe: `readFile` reports a normalised `PlatformError` even when closing the file descriptor also fails, instead of the raw backend error.
- 3b9beab: `FileSystem.watch` resolves its target through the volume before subscribing. Paths such as `/link/../x` or a file under a symlinked directory subscribe to, and report events under, the canonical path.
- 6010a8b: `@opfs-vfs/react` and `@opfs-vfs/effect` require the exact `@opfs-vfs/opfs-vfs` and `@opfs-vfs/plugin-subscriptions` versions they were built with, because their default workers include the storage engine. Upgrade the three together.

  `@opfs-vfs/opfs-vfs` declares `"sideEffects": false`, and options marked internal no longer appear in its type declarations.

- Updated dependencies [cc26a55]
- Updated dependencies [6010a8b]
- Updated dependencies [c775de1]
- Updated dependencies [cf048fd]
- Updated dependencies [452f840]
- Updated dependencies [998ca7c]
- Updated dependencies [cc37142]
- Updated dependencies [a3eba3e]
- Updated dependencies [19e80f5]
- Updated dependencies [99ed87a]
- Updated dependencies [3d32b9e]
  - @opfs-vfs/opfs-vfs@2.2.0
  - @opfs-vfs/plugin-subscriptions@1.3.0

## 0.3.1

### Patch Changes

- 9b62953: Allow stable Effect v4 releases through the `^4.0.0` peer dependency range. Applications can upgrade Effect within v4 without an exact-version peer dependency conflict. Effect v3, v5, and prereleases remain unsupported.

## 0.3.0

### Minor Changes

- 4678e0c: Upgrade the Effect adapter to stable Effect 4.0.0. Consumers must upgrade their Effect runtime from the exact `4.0.0-rc.118` peer dependency to `4.0.0`.

## 0.2.0

### Minor Changes

- 61011b1: Add generation-pinned recursive copy, chunked file copy, and scoped volume-local temporary resources to the Effect FileSystem adapter.
- 86dc826: Add the Effect v4 package with scoped direct volume acquisition, inspection, persistence, and adapter errors.
- f4adcfb: Add generation-pinned namespace, directory, link and metadata operations to the Effect FileSystem adapter.
- 635ab44: Add subscription-backed `FileSystem.watch` and a reconciliation example for views recovering after notification gaps.
- 8e6e420: Add worker-backed Effect volume sessions with optional subscription plugin registration.
- 002d7dc: Add scoped file handles, descriptor-backed large-file access, and bounded FileSystem streams and sinks.
- a299d7b: Add the first `OpfsFileSystem` adapter slice for absolute-path access and bounded whole-file reads and writes.
- de5c621: Add bounded Effect subscription streams and a lifecycle bridge for safe subscription retirement.

### Patch Changes

- Updated dependencies [b4bccdf]
- Updated dependencies [8e6e420]
- Updated dependencies [c860528]
- Updated dependencies [de5c621]
  - @opfs-vfs/opfs-vfs@2.1.0
  - @opfs-vfs/plugin-subscriptions@1.2.0

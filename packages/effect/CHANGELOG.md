# @opfs-vfs/effect

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

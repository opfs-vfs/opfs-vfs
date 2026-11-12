---
'@opfs-vfs/opfs-vfs': patch
---

Fix worker and shared-transport edge cases:

- Shared-transport pages watch a per-generation liveness lock, so a hidden tab can no longer block the volume from being reopened after its owner stops.
- Writes from a follower tab send only the bytes being written instead of cloning the caller's whole backing buffer to every tab, and views over shared memory work.
- A single page on the shared transport receives the owner's persistence status without waiting for a second tab or a page resume.
- A follower that takes over while the previous owner's worker is still releasing the volume retries briefly instead of failing with `EBUSY`.
- Worker startup honours `initTimeout` instead of a fixed five seconds. A worker that never answers now fails with `VFS_INITIALIZATION_TIMEOUT` when that timeout expires.
- A relayed shutdown gets the same five-minute deadline as a direct one.
- A synchronous result too large for the bridge fails with `EOVERFLOW` instead of an uncoded error that PGlite saw as a missing directory.
- `utimes()` through a worker accepts fractional millisecond timestamps, matching a direct mount.
- Constructing a worker client on a page without cross-origin isolation fails with `VFS_UNSUPPORTED` instead of a raw error.

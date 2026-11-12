---
'@opfs-vfs/opfs-vfs': patch
---

Fix memory-mode recovery and corruption reporting:

- Closing a tab between a write past the end of a file and the next sync no longer recovers stale bytes into the file's hole.
- A sync that fails while writing file data no longer leaves the volume unmountable, and reports `ENOSPC` when the cause is the storage quota.
- A truncate that cannot allocate its buffer fails without changing the file or logging the truncate.
- A volume where two files claim the same data block reports a typed corruption error that stays visible in the persistence status.
- A data log that ends in zero bytes after a power loss is treated as a torn append instead of corruption.

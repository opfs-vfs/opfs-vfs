---
'@opfs-vfs/opfs-vfs': major
'@opfs-vfs/react': patch
---

Protected-volume initialization now reports `VFS_STORAGE_PLUGIN_REQUIRED` instead of `EINVAL`; React classifies that code as unsupported and recognizes `EVAULTFORMAT` and `EPLAINTEXTVOLUME` as encryption errors.

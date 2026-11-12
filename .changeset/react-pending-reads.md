---
'@opfs-vfs/react': patch
---

Read hooks no longer report `idle` for one render when a read is enabled, re-enabled, or newly started. They report `pending` until data arrives.

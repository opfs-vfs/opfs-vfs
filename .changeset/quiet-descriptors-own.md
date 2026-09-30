---
'@opfs-vfs/opfs-vfs': patch
'@opfs-vfs/react': patch
---

Add generation-bound asynchronous descriptor operations and prevent a late `OPEN` result from escaping after its owner changes. React command handles continue to expose only path-based operations.

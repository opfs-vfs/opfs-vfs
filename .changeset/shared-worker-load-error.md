---
'@opfs-vfs/opfs-vfs': patch
---

When the SharedWorker script cannot be loaded, the error says so and names the usual causes and fixes, such as dependency pre-bundling or a Content-Security-Policy, instead of "SharedWorker probe failed". The code stays `VFS_WORKER_FAILED`.

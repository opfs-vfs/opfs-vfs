---
'@opfs-vfs/effect': patch
---

`FileSystem.watch` resolves its target through the volume before subscribing. Paths such as `/link/../x` or a file under a symlinked directory subscribe to, and report events under, the canonical path.

---
'@opfs-vfs/react': patch
'@opfs-vfs/effect': patch
'@opfs-vfs/opfs-vfs': patch
---

`@opfs-vfs/react` and `@opfs-vfs/effect` require the exact `@opfs-vfs/opfs-vfs` and `@opfs-vfs/plugin-subscriptions` versions they were built with, because their default workers include the storage engine. Upgrade the three together.

`@opfs-vfs/opfs-vfs` declares `"sideEffects": false`, and options marked internal no longer appear in its type declarations.

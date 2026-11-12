---
'@opfs-vfs/opfs-vfs': minor
'@opfs-vfs/devtools': patch
---

The just-bash adapter's non-recursive `rm` removes an empty directory, so `rmdir` works in a shell. A non-empty directory fails with `ENOTEMPTY`, and a symlink to a directory is still only unlinked. The adapter also gains `createExclusive`, so `mktemp` works once its directory exists. The developer tools refuse both on read-only connections.

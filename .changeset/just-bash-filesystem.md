---
'@opfs-vfs/opfs-vfs': minor
'@opfs-vfs/devtools': patch
---

The just-bash adapter gains `forJustBash()`, a filesystem you can pass straight to `new Bash({ fs })`. It has the synchronous path list just-bash requires, re-read after every path-changing call made through it. The developer tools shell uses it, so its path list follows changes made within a command line.

The adapter's file methods no longer create parent directories for a path that contains `.` or `..`. The volume resolves such paths, so `/missing/../file` fails with `ENOENT` and creates nothing.

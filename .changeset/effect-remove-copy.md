---
'@opfs-vfs/effect': minor
---

Breaking: like Node, a non-recursive `FileSystem.remove` fails on any directory, empty or not, with an `Unknown` error whose cause has code `ERR_FS_EISDIR`. Pass `recursive: true` to delete directories.

`FileSystem.copy` resolves `.` and `..` in the destination the same way as every other operation. A `..` after a missing directory fails with `NotFound` instead of creating that directory, and a copy into itself through such a path is rejected instead of recursing.

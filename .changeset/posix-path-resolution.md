---
'@opfs-vfs/opfs-vfs': minor
---

Breaking: paths are resolved as POSIX does. `.` and `..` are resolved during lookup, after symbolic links, instead of being collapsed textually first.

- With a symlink `/link` to `/a/b`, `/link/../x` reaches `/a/x`, the parent of the link's target.
- `/missing/../file` fails with `ENOENT`.
- `/file/..` and `/file/.` fail with `ENOTDIR`.
- Removing or renaming a path whose last component is `.` or `..` fails with `EINVAL`.

Subscription targets are still matched textually against event paths.

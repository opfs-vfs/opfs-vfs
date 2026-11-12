---
'@opfs-vfs/effect': minor
---

Require Effect 4.1 or newer. Effect 4.1 changed the `FileSystem` service, so one build cannot serve both 4.0 and 4.1:

- `stat` now reports `dev`, `ino`, `nlink`, and `blocks` as `bigint`.
- `lstat` and `readDirectoryEntries` are implemented.
- `glob` works when given an absolute `root` or pattern. It previously failed with `ENOTSUP`.
- `open` with `noFollow` fails with `BadArgument`, because the volume cannot refuse a final symlink atomically.
- `watch` calls `onReady` once the subscription is installed.

Since Effect 4.0.7, a typed failure that is followed by a failing finalizer reaches the caller as a defect. This applies to volume and descriptor cleanup failures too.

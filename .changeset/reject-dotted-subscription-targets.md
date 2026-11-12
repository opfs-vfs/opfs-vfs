---
'@opfs-vfs/plugin-subscriptions': minor
'@opfs-vfs/opfs-vfs': patch
---

Breaking: a subscription target that contains a `.` or `..` path component is rejected with `EINVAL` at registration instead of being collapsed textually. Pass the canonical path, for example `realpath` of the directory plus the name. Names that merely contain dots are unaffected.

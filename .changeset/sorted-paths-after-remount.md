---
'@opfs-vfs/opfs-vfs': patch
---

Fix lost directory children after a remount. When a directory had a sibling whose name extended its own with a character that sorts before `/`, such as `/a` next to `/a-1`, renaming or removing the directory after reopening the volume left its children unreachable and made the volume fail to close.

Volumes on which an earlier release renamed or removed such a directory and left its files without a parent now mount with those files back at their old path and close normally. The repair is reported in the persistence status.

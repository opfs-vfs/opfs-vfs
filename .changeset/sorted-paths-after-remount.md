---
'@opfs-vfs/opfs-vfs': patch
---

Fix lost directory children after a remount. When a directory had a sibling whose name extended its own with a character that sorts before `/`, such as `/a` next to `/a-1`, renaming or removing the directory after reopening the volume left its children unreachable and made the volume fail to close.

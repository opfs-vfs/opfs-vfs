---
'@opfs-vfs/effect': patch
---

`readFile` reports a normalised `PlatformError` even when closing the file descriptor also fails, instead of the raw backend error.

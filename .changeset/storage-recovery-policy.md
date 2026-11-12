---
'@opfs-vfs/opfs-vfs': patch
---

Recovery and durability policy changes:

- When a volume has to fall back to an older metadata snapshot at mount, the persistence status reports it as a corruption error instead of mounting silently. `fail-stop` still refuses to mount.
- With memory buffering and `balanced` or `relaxed` durability, create, rename, unlink, and similar operations no longer throw when their recovery-log write fails with a quota or I/O error. The operation is applied, the persistence status records the error, and the next sync writes the record before any file data. `strict` still throws.
- A data log whose last record fails its checksum, with no valid record after it, is treated as an interrupted append: it is dropped without a `corrupt-frame` salvage event and no longer stops a `fail-stop` mount. A failing record followed by a valid one is still reported as corruption, even when its length field is the damaged part.
- Files an earlier release left under a name that is now a file are moved to `/lost+found/<old path>` at mount, or `/lost+found-2` and so on if that name is in use. The repair is reported in the persistence status, and the volume closes normally.
- `utimes()` on a direct mount rejects times before 1970 or from 7 February 2106 onward with `EINVAL`, as worker clients already do. Fractional milliseconds are still accepted.

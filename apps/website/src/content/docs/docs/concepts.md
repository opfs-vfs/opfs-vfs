---
title: Volumes and lifecycle
description: Understand named volumes, file storage, and the difference between closing a file and closing a volume.
---

A volume is a filesystem identified by one name, such as `app-data.bin`. OPFS VFS stores its contents, metadata, and recovery logs in a group of OPFS files under that basename. Let the library manage those component files; do not edit them directly.

```ts
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';

const vfs = new OpfsVfs('app-data.bin', {
  openMode: 'open-or-create',
  bufferMode: 'memory',
  localDurabilityMode: 'balanced',
});
```

`memory` keeps file contents in RAM; `disk` accesses data blocks in OPFS without a full extra RAM copy. Both modes use persistent OPFS storage. The example selects memory buffering explicitly; disk buffering is the default.

Wait for `ready` before using a volume. Synchronize important changes, then await `closeVfs()` when finished. Closing a file descriptor releases that file handle; closing the volume releases the filesystem. Close a volume before removing its component files with `deleteVolume()`. See [persistence and recovery](/docs/guides/persistence/) for save points and recovery behavior.

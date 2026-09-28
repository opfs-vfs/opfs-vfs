---
title: Public API
description: Find public imports, volume options, and APIs for inspecting and deleting volumes.
---

```ts
import { OpfsVfs, OpenFlags, deleteVolume, peekVolume, isVfsError, isVfsCorruptionError } from '@opfs-vfs/opfs-vfs';
```

The root package exports options, stats, directory entries, persistence state and status, and salvage-event types. Subpaths provide `/worker`, `/worker-client`, `/worker-runtime`, `/pglite`, `/just-bash`, and `/storage`.

`OpfsVfsOptions` includes `openMode`, `bufferMode`, `localDurabilityMode`, optional quotas, `noatime`, and `recoveryMode`.

`peekVolume(name)` inspects reserved files without opening a volume. Its `VolumePeek` result includes `exists`, `encrypted`, `importing`, and `compatible`. A `.importing` marker makes `importing` true and `compatible` unknown, even when the marker is empty or encryption files are also present. Treat that volume as unavailable before prompting for credentials or constructing a client. Marker detection does not prove that encrypted data can be unlocked. Invalid names and OPFS access failures still reject. `deleteVolume(name)` explicitly removes all reserved files, including an incomplete import marker, under the volume lock.

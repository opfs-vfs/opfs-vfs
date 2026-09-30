# OPFS VFS

A browser filesystem backed by the Origin Private File System. It provides POSIX-style file operations, write-ahead logging, crash recovery, and shared worker transport.

This is the standalone core distribution. It contains the library, its tests, and optional PGlite, just-bash, and experimental DuckDB adapters. It has no runtime dependencies for ordinary filesystem use.

This source uses the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

## Use

After the first public release:

```sh
npm install @opfs-vfs/opfs-vfs
```

Use the worker client from a browser page:

```ts
import { OpenFlags } from '@opfs-vfs/opfs-vfs';
import { openOpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';

const fs = await openOpfsVfsWorker('documents.bin');
await fs.ready;
const fd = await fs.open('/hello.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
await fs.write(fd, new TextEncoder().encode('hello'));
await fs.fsync(fd);
await fs.close(fd);
await fs.closeVfs();
```

`openOpfsVfsWorker()` selects a compatible bundled `SharedWorker` when the complete browser capability gate passes, then falls back to the bundled dedicated worker. Its status exposes the selected `transport` and any `fallbackReason`. Pass `transport: 'dedicated'` or `'shared-worker'` to override that choice; forced shared transport reports an unsupported/error state instead of falling back. `new OpfsVfsWorker()` remains dedicated by default.

An application worker or plugin request needs an application-owned factory. Auto selection then uses dedicated transport unless that application also provides a stable `sharedWorker` factory. Keep a shared factory at module scope, use one fixed worker URL and name per volume, and return a fresh `SharedWorker` on every call.

Serve over HTTPS or localhost. Synchronous worker calls use SharedArrayBuffer and require cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Direct `OpfsVfs` mounts use synchronous OPFS handles and belong in a dedicated worker. See [API](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/API.md) and [development](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/DEVELOPMENT.md).

Shared transport is asynchronous only. One shared owner serves a volume, so owner contention or owner loss affects every attached page; attachment loss is terminal and requires a fresh client plus a reread. A local `closeVfs()` only closes this client. Coordinate all pages before global shutdown or deletion. A shared encrypted volume is unlocked by its owner and does not add per-tab authentication.

## Storage defaults

`OpfsVfs` and `OpfsVfsWorker` default to disk buffering and balanced local durability. Disk buffering avoids a full RAM copy of file contents. Balanced mode schedules background synchronization about 150 ms after the first change, but a busy or suspended worker can delay it. Keep explicit save boundaries such as the `fsync()` call above for important writes.

For memory caching with explicitly managed synchronization, pass `{ bufferMode: 'memory', localDurabilityMode: 'relaxed' }`. Both buffer modes use persistent OPFS storage.

When switching buffer modes, a volume with a pending memory-mode recovery log must first be reopened with `bufferMode: 'memory'` and closed successfully before switching to disk. A disk mount reports `EBUSY` in this case; do not delete the log. See [storage defaults](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/API.md#storage-defaults).

## Optional adapters

```ts
import { OpfsVfsPGliteAdapter } from '@opfs-vfs/opfs-vfs/pglite';
import { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';
import { createDuckDBRuntime } from '@opfs-vfs/opfs-vfs/duckdb';
import { OpfsVfsWasmerAdapter } from '@opfs-vfs/opfs-vfs/wasmer';
import { createWasmerFileSystem } from '@opfs-vfs/opfs-vfs/wasmer-sync';
```

Install `@electric-sql/pglite` when using the PGlite adapter. Pass a synchronous VFS instance to `new OpfsVfsPGliteAdapter(vfs)`; shared clients must be the leader for synchronous operations. The just-bash adapter exposes a structural filesystem interface and adds no just-bash runtime dependency. Pass the adapter to your installed just-bash version's filesystem option.

The experimental DuckDB adapter requires a dedicated worker, `useDirectIO: true`, and a matched JavaScript/Wasm pair built separately from compatible DuckDB-Wasm sources. This package does not build or include engine assets. Install `@duckdb/duckdb-wasm@1.33.1-dev64.0` for its types. See the [DuckDB build guide and worker example](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/DUCKDB.md). The stock DuckDB-Wasm binary is not compatible.
The Wasmer adapter uses `@wasmer/sdk@0.14.0` to copy an existing `/workspace` directory into and out of an EdgeJS sandbox. `syncToSandbox(sandbox.fs)` and `syncFromSandbox(sandbox.fs)` mirror files, directories and deletions explicitly. Stop other writers first, then flush or close OPFS after sync-back. This is not a live mount; links and file metadata are unsupported. See the [EdgeJS example](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/API.md#edgejs-through-wasmer).

For experimental live EdgeJS mounts, use `createWasmerFileSystem(vfs)` with a ready direct `OpfsVfs` in a dedicated worker and the compatible custom Wasmer SDK. The [live EdgeJS guide](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/EDGEJS.md) links the prepared host assets, immutable fork revisions, and build instructions. The stock SDK does not support live mounts.

## Protected volumes

Core refuses volumes with reserved protection markers unless a configured storage plugin declares them. The error code is `VFS_STORAGE_PLUGIN_REQUIRED` (errno 22); applications that used `EINVAL` to detect protected volumes should check this code instead. Legacy JavaScript `{ encryption: ... }` options also fail explicitly. Encryption, keys, protected archives and migration belong to the premium `@opfs-vfs/plugin-encryption` storage plugin: register `encryption` in an application worker and pass `encryptionRequest({ secret })` from `@opfs-vfs/plugin-encryption/config` in `plugins`. See [storage plugins](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/API.md#storage-plugins). Moving imports does not require erasing existing volumes.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md), copyright Bastian Kistner. The license permits noncommercial use, modification, and distribution; it does not generally permit commercial use, including internal business use. It also permits use by specified nonprofit, educational, research, public safety, health, environmental, and government organizations. Commercial use requires separate permission. This is source-available software, not OSI-approved open source.

# API and package boundaries

| Import                              | Contents                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@opfs-vfs/opfs-vfs`                | Direct `OpfsVfs`, `OpenFlags`, errors, `peekVolume`, `deleteVolume`, persistence types                                                     |
| `@opfs-vfs/opfs-vfs/worker`         | `openOpfsVfsWorker`, `OpfsVfsWorker`, `getSupport`, `createSharedWorkerFollower`, `probeSharedWorker`, `startVfsSharedWorker`, and options |
| `@opfs-vfs/opfs-vfs/pglite`         | `OpfsVfsPGliteAdapter` and its synchronous VFS interface                                                                                   |
| `@opfs-vfs/opfs-vfs/just-bash`      | `OpfsVfsJustBashAdapter`, its `forJustBash()` filesystem, and structural filesystem types                                                  |
| `@opfs-vfs/opfs-vfs/wasmer`         | `OpfsVfsWasmerAdapter` and `WasmerWorkspace` for explicit workspace copies                                                                 |
| `@opfs-vfs/opfs-vfs/wasmer-sync`    | Experimental `createWasmerFileSystem` live synchronous filesystem provider                                                                 |
| `@opfs-vfs/opfs-vfs/duckdb`         | Experimental `createDuckDBRuntime` synchronous DuckDB-Wasm filesystem adapter                                                              |
| `@opfs-vfs/opfs-vfs/plugins`        | Plugin author types: configured plugins, worker registrations and requests                                                                 |
| `@opfs-vfs/opfs-vfs/changes`        | Logical-change contribution and file-change channel types                                                                                  |
| `@opfs-vfs/opfs-vfs/storage`        | Internal volume-storage contract and persistence helpers; version-coupled extension API                                                    |
| `@opfs-vfs/opfs-vfs/worker-client`  | Shared client for extension worker construction                                                                                            |
| `@opfs-vfs/opfs-vfs/worker-runtime` | Shared command dispatcher for extension workers                                                                                            |

`openOpfsVfsWorker()` chooses the transport: a compatible SharedWorker when the capability probe passes, otherwise the dedicated worker, with the reason in `getStatus().fallbackReason`. It selects the dedicated worker only when the page has no `SharedWorker` API, the shared scope cannot open sync access handles, no compatible `sharedWorker` factory exists for an application worker or plugin request, or a compatible dedicated owner already holds the volume. A SharedWorker that cannot be created or reached, a probe timeout, and every attach or mount failure reject. Every worker client needs a cross-origin isolated page because it allocates the SharedArrayBuffer bridge, even for asynchronous-only use; `getSupport()` lists what is missing, and construction fails with `VFS_UNSUPPORTED`.

Await `ready` before filesystem operations. A direct mount uses `openSync`, `writeSync`, `readSync`, `fsyncSync` and `closeSync` for file descriptors; await `closeVfs()` to release the volume and its locks. Worker clients provide corresponding asynchronous methods, `flushVfs()` and `closeVfs()`. File close and volume close are different operations.

Worker clients also expose `forGeneration(ownerGeneration)` for calls that must stay with one ready owner. Its path and descriptor methods share the same generation checks; a descriptor handle becomes stale on takeover. A follower-relayed `OPEN` that settles during a takeover is rejected and its matching relay request is canceled; a leader-side late `OPEN` is rejected and its resources follow the ordinary owner lifecycle. Failures carry `VfsCommandError.dispatch` as `refused`, `sent` or `replied`; stale handles must be reopened explicitly.

An application can explicitly host compatible pages through a stable named SharedWorker module using `startVfsSharedWorker({ plugins })`. Each factory call must create a fresh `SharedWorker`/port using the same-origin module URL and a stable name per basename. The module's plugin registrations are fixed. The first attach supplies mount options and plugin payloads; later pages compare only the filename, protocol/capabilities, and plugin IDs, contract versions, and compatibility keys. Applications must therefore coordinate all options and credentials themselves.

`createSharedWorkerFollower()` connects a caller-owned `OpfsVfsWorkerClient` through that worker. Its calls are asynchronous: it bootstraps through the shared port, then relays through BroadcastChannel with structured cloning; it has no synchronous SAB API. `closeVfs()` releases only that caller. A host owns one volume, so do not mix dedicated and shared transport or use `forceLeader`/`claimIfAvailable`. SharedWorker support alone is insufficient: the shared scope must also create OPFS sync access handles. The standard exposes them to [DedicatedWorkers](https://fs.spec.whatwg.org/#api-filesystemfilehandle); test the complete capability path.

For deliberate global shutdown before optional deletion or private-key cleanup, await the raw shared follower's `ready`, then await `shutdownSharedVfs()`. Delete only after success and only when erasing the volume is intended. Coordinate all pages because a new open can race shutdown and deletion. A timeout is not proof that the owner died; never steal the lock. Shared-owner loss reports terminal `VFS_ATTACHMENT_LOST`: create a fresh client, reread state, and verify possibly applied writes. Other useful raw-client `error.code` values include `VFS_UNSUPPORTED`, `EBUSY`, `VFS_PROTOCOL_MISMATCH`, `VFS_PLUGIN_MISMATCH`, and `VFS_SHUTTING_DOWN`. React's managed client hook intentionally does not expose this global lifecycle operation; see the [React guide](../apps/website/src/content/docs/docs/react/index.mdx#share-one-explicit-worker).

Keep the same volume name and origin when reopening. `openMode: 'create-new'` rejects any existing volume artifact. The default remains open-or-create. Do not assume a successful write alone is a completed volume checkpoint.

`peekVolume` is read-only and returns plaintext metadata information plus protection-marker presence. It does not decode a vault or report cipher parameters. `deleteVolume` explicitly removes the complete named volume, including reserved extension sidecars, under the volume lock; use it only when deletion is intended.

## Path resolution

Every path is resolved from the volume root, one component at a time, as POSIX does. Empty components are ignored; a relative path starts at the root.

- **`.` and `..`** are resolved against the directories actually reached, after symbolic links. With a link `/link` to `/a/b`, `/link/../x` names `/a/x`. They need an existing directory to stand on: after a name that does not exist the call fails with `ENOENT`, after a file with `ENOTDIR`. `..` at the root stays at the root.
- **Symbolic links** in the middle of a path are always followed; the last component is followed by `stat`, `open`, `readdir`, `chmod`, `utimes`, `truncate`, `realpath` and `exists`, and not by `lstat`, `readlink`, `unlink`, `rmdir`, `rename`, `link`, `symlink` and `mkdir`. A relative target is resolved from the link's own directory. A link whose target does not exist resolves to that missing path, so `..` after it fails with `ENOENT`. More than 40 links in one resolution fail with `ELOOP`.
- **Search permission** is needed on every directory the walk passes through, including one that a link or `..` leads through and that is not part of the final path; otherwise the call fails with `EACCES`.
- **A trailing slash** requires the resolved entry to be a directory (`ENOTDIR` otherwise). A final `.` or `..` does too.
- **Removing or renaming `.` or `..`** (`removeSync`, `rmdirSync`, `renameSync`, source and destination) fails with `EINVAL`, also behind a trailing slash or a symbolic link, and changes nothing.
- **`realpath`** returns the resolved path without links or dot components and fails with `ENOENT` if it does not exist. Paths in change events, `listPaths()` and stored metadata are always these resolved paths.

Breaking change from earlier versions, which collapsed `..` textually before looking anything up: `/missing/../file` now fails with `ENOENT` instead of reaching `/file`, `/file/..` and `/file/.` fail with `ENOTDIR`, and `..` after a symbolic link leads to the parent of the link's target instead of the parent of the link.

The `just-bash` adapter's `resolvePath()` remains the shell's textual path arithmetic (`cd ..` from `/a/b` is `/a`); its file methods pass paths through unchanged and do not create parent directories for a path with a `.` or `..` component: the volume resolves it, so `/newdir/../w.txt` fails with `ENOENT` when `/newdir` does not exist. Pass `adapter.forJustBash()` to the shell: `new Bash({ fs: adapter.forJustBash() })`. just-bash requires a synchronous `getAllPaths()`, which `forJustBash()` serves from a cached list. The list is read when the wrapper is created and again after every call through the wrapper that can add, remove or rename paths; such a call settles only after the list is current. Changes made any other way (another tab or client, or the adapter used directly) are not seen until the next listing: await `refreshPaths()` on the wrapper when you need them, for example before a command. The adapter's own `getAllPaths()` stays asynchronous and always reads the volume. The live Wasmer provider (`createWasmerFileSystem`) still rejects paths containing `.` or `..` with `EINVAL`. Subscription targets are textual patterns, not lookups: they are compared with event paths after textual normalization.

## Storage defaults

Direct `OpfsVfs` mounts and `OpfsVfsWorker` clients default to `bufferMode: 'disk'` and `localDurabilityMode: 'balanced'`. Disk mode accesses mapped OPFS blocks without retaining a full copy of file contents in RAM. Metadata and I/O buffers still consume memory.

Balanced mode schedules synchronization about 150 ms after the first dirty change. Worker suspension or scheduling can delay it, so this is not a maximum data-loss window. Await `fsync()` or `flushVfs()` on a worker client, or call `fsyncSync()` or `syncSync()` on a direct mount at meaningful save boundaries. File descriptor close alone does not flush the volume.

Both memory and disk buffering use OPFS. Select `bufferMode: 'memory'` to cache file contents and `localDurabilityMode: 'relaxed'` to manage synchronization explicitly. Relaxed mode defers flushes to explicit synchronization or orderly volume close. Strict mode adds immediate memory-mode recovery-log flushes; it does not flush every disk-mode write. The PGlite adapter's separate `relaxedDurability` option is unchanged.

When switching a volume from memory to disk buffering, a nonempty memory recovery log causes a disk mount to fail with `EBUSY`. Reopen that volume explicitly with `bufferMode: 'memory'`, await readiness and successfully close it with `closeVfs()`. It can then be reopened with the disk default. Do not delete recovery logs or reset the volume to work around this error. A cleanly closed volume can switch buffer modes directly.

File times are stored in whole seconds. `stat()` and `utimes()` work in milliseconds while a volume is mounted, but after it is reopened `atimeMs`, `mtimeMs` and `ctimeMs` read back rounded down to the second. Do not compare a time read before a reopen with one read after it at millisecond precision. Times before 1970 or from 7 February 2106 onward cannot be stored; `utimes()` rejects them with `EINVAL` on direct mounts and worker clients alike. The stored value 0 means "unset", so a time within the first second of 1970 (0 to 999 ms) is accepted but reads back as the fallback time after the volume is reopened.

In memory buffering with `balanced` or `relaxed` durability, a create, rename, unlink or similar namespace operation does not fail when its recovery-log write fails (for example on a full quota). The operation is applied, the persistence status records the error, and the next synchronization retries and reports a failure that persists. `strict` durability still throws from the operation.

A recovery log that ends in an incomplete or checksum-failing record with no valid record after it is treated as an interrupted append: the record is dropped without a salvage event, also under `recoveryMode: 'fail-stop'`. A failing record that is followed by a valid one is still reported as corruption.

Some damage is repaired at mount and reported through `lastError` of the persistence status for the life of that mount, even after the state returns to `clean`: a mount that fell back to an older metadata snapshot (`salvage` only; `fail-stop` refuses it), blocks claimed by two files, and entries an earlier release left without a parent directory. Those entries return at their old path, or under `/lost+found` (`/lost+found-2`, … if that name is taken) when a file has since taken their directory's name.

## Live EdgeJS files

`createWasmerFileSystem(vfs)` from `/wasmer-sync` exposes a ready, direct `OpfsVfs` through the custom Wasmer SDK's `syncMounts` API. Create both in a dedicated worker. The adapter forwards live file and directory operations and preserves filesystem error codes; it does not depend on or bundle the SDK. Stock `@wasmer/sdk@0.14.0` does not expose this API.

Use the [EdgeJS guide](../apps/website/src/content/docs/docs/integrations/edgejs.md) for the exact compatible host downloads, pinned fork build recipe, and complete worker example. The [integration checks](EDGEJS.md) exercise the prepared assets. Links, special files, and arbitrary external namespace changes are unsupported. Finish guest execution and close its handles before synchronizing or closing the volume; interrupted execution requires reopening the owner.

## EdgeJS through Wasmer

Install `@wasmer/sdk@0.14.0`. The optional `/wasmer` entry point copies ordinary files and directories between an existing OPFS `/workspace` directory and `sandbox.fs`. Each synchronization mirrors its source, including deletions. This is a snapshot adapter, not a live filesystem mount.

```ts
import { Wasmer } from '@wasmer/sdk/browser';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { OpfsVfsWasmerAdapter } from '@opfs-vfs/opfs-vfs/wasmer';

const vfs = new OpfsVfsWorker('edgejs.bin', { bufferMode: 'disk' });
const wasmer = new Wasmer();
try {
  await vfs.ready;
  await vfs.mkdir('/workspace', { recursive: true });
  const pkg = await wasmer.packages.load('wasmer/edgejs@0.2.0');
  const sandbox = await wasmer.sandboxes.create({ packages: [pkg], network: { mode: 'disabled' } });
  try {
    const adapter = new OpfsVfsWasmerAdapter(vfs);
    await adapter.syncToSandbox(sandbox.fs);
    await sandbox.command(pkg, ['-e', "require('node:fs').writeFileSync('/workspace/hello.txt', 'hello')"]).run();
    await adapter.syncFromSandbox(sandbox.fs);
    await vfs.flushVfs();
  } finally {
    await sandbox.close();
  }
} finally {
  try {
    await vfs.closeVfs();
  } finally {
    await wasmer.close();
  }
}
```

Use Chromium with cross-origin isolation. Serve the SDK's JavaScript, worker and WASM assets with their relative paths intact, as in the [integration test configuration](../packages/opfs-vfs/vitest.edgejs.config.ts). Other bundlers need equivalent asset handling.

Stop guest execution and all other writers before synchronization. The adapter loads the entire source into memory and checks destination entries before writing. Source read failures leave the destination unchanged; destination write failures can leave a partial copy. Guest writes are durable only after sync-back and an OPFS durability barrier. File modes, timestamps and link identity are not preserved. OPFS symlinks are rejected; the SDK cannot identify guest symlinks, so sandbox links and special files are unsupported. Trees deeper than 64 directory levels are rejected. See the [research and probe results](research/2026-09-21-edgejs.md) for upstream limitations.

## Storage plugins

Pass configured instances through `new OpfsVfs(name, { plugins: [...] })`. An empty list uses raw storage. Each configured instance and its contributed storage factory can mount once, including failed attempts; construct a fresh instance for another mount. Core validates and claims instances synchronously before taking ownership. The former public `storageFactory` option is removed.

The supported author types live in `@opfs-vfs/opfs-vfs/plugins`. A `ConfiguredVfsPlugin` declares its `id`, `contractVersion: 1`, non-secret `compatibilityKey`, optional `requiredOpenMode: 'create-new'`, and `storage: { factory, sidecars }`. Only one storage contribution is supported. Sidecars may be `.vault`, `.crypt`, or `.crypt.log`; all existing protected markers must be declared by the selected provider. `.importing` belongs to core lifecycle checks and cannot be declared. The declaration describes trusted plugin ownership, not a security sandbox.

Mounting a volume with an undeclared protection marker fails with `VFS_STORAGE_PLUGIN_REQUIRED` (errno 22). If your code previously checked `EINVAL` to detect a protected volume, switch that check to the new code; other invalid arguments still use `EINVAL`.

The factory receives tracked raw storage and a declared-sidecar opener. A returned record codec must supply both WAL cycle hooks. The pre-data-commit hook runs synchronously before the data barrier and must finish its own required journal/sidecar flushes before returning. Throwing aborts that barrier. Core owns handle cleanup and invokes the returned idempotent `destroy()` on close or later initialization failure. Factories must destroy any key state themselves if they fail before returning. Promise-returning synchronous hooks are unsupported.

The `/storage` API is internal and may change with package versions. Premium pins exactly the tested core version; do not replace that pin with an untested range.

### Application workers

Register reusable plugin implementations in an application-owned worker. Each initialization calls `configure` to produce a fresh configured instance. A registered implementation that is not requested contributes no storage or profile entry.

```ts
// filesystem.worker.ts
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { storagePlugin } from './storage-plugin';

startVfsWorker({ plugins: [storagePlugin] });
```

```ts
// page.ts
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { storageRequest } from './storage-config';

const fs = new OpfsVfsWorker('app.bin', {
  worker: () => new Worker(new URL('./filesystem.worker.ts', import.meta.url), { type: 'module' }),
  plugins: [storageRequest(options)],
});
await fs.ready;
```

`storagePlugin` and `storageRequest` above are application implementations of `VfsPluginRegistration` and a helper returning `VfsPluginRequest`. The request carries `id`, `contractVersion: 1`, a non-secret `compatibilityKey`, structured-cloneable `options`, and an optional `requiredOpenMode: 'create-new'`. Core copies requests before taking ownership. The worker validates their identities, keys, and required mode against the configured implementations before mounting. Unknown plugins, duplicate IDs, unsupported contributions, and reserved INIT fields reject. This replaces the previous worker-host callback and extra INIT data.

Omitting `worker` selects the bundled worker with an empty registry. Nonempty requests require an application worker, even when another owner is available. Empty-profile mounts can share an owner across bundled and application workers. Only the bundled worker advertises passive observer support.

Normal followers negotiate a versioned profile of active plugin IDs, contract versions, and compatibility keys with each owner generation. A missing or conflicting profile rejects with `VFS_PLUGIN_MISMATCH`. Ownership changes invalidate pending requests and descriptors from the old owner; uncertain mutations are never replayed automatically. Reopen files after takeover.

Matching profiles do not authenticate follower credentials. Followers use the owner's already-open storage; their own options are validated when they become owner. The client retains its private request copy for takeover and clears it on disposal. Prepare credentials in the foreground before construction. A failed mount is terminal, so retry with a new client; no background credential prompt is attempted. Secrets and options are never included in profile announcements.

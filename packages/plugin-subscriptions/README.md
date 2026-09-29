# OPFS VFS subscriptions plugin

`@opfs-vfs/plugin-subscriptions` provides bounded logical file and directory change notifications for OPFS VFS. It is a local, live notification API: it has no initial enumeration, replay, persistent history, server sync, or atomic scan-plus-subscribe snapshot.

Register the plugin on a direct mount or in a custom worker. The worker registration is executable code; `subscriptionsRequest()` is the serializable profile a raw page client sends to that worker when opening a volume. The React `VolumeProvider` sends this request automatically for managed volumes. After opening, use `subscribe()` from `/client` to watch changes.

## Direct mount

Use direct `OpfsVfs` only in a dedicated worker, where synchronous OPFS access handles are available; page code should use `OpfsVfsWorker` as shown below.

```ts
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

const fs = new OpfsVfs('documents.bin', { plugins: [subscriptions()] });
await fs.ready;
fs.mkdirSync('/documents', { recursive: true });

const subscription = await subscribe(
  fs,
  {
    path: '/documents',
    scope: 'directory',
    recursive: true,
    events: ['create', 'update', 'delete'],
    content: { maxBytes: 1024 * 1024 },
    onError(error) {
      console.error('Subscription stopped:', error.code);
    },
  },
  async (change) => {
    // Reconcile current filesystem state; content is a historical operation version.
    console.log(change.type, change.path, change.content.status);
  },
);

// Stops future local callbacks. It is safe to call more than once.
// Await subscription.closed for released after owner cleanup, or unknown with the lost-confirmation error.
subscription.unsubscribe();
```

## Worker clients

```ts
// filesystem.worker.ts
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [subscriptions] });
```

```ts
// page.ts
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

const fs = new OpfsVfsWorker('documents.bin', {
  worker: () => new Worker(new URL('./filesystem.worker.ts', import.meta.url), { type: 'module' }),
  plugins: [subscriptionsRequest()],
});
await fs.ready;

const subscription = await subscribe(
  fs,
  { path: '/', scope: 'directory', recursive: true, onError: console.error },
  (change) => console.log(change.path),
);
```

`subscriptions()` and `subscriptionsRequest()` accept no configuration. A compatible follower must request the same active profile; a follower cannot add the plugin to an owner that did not register it.

## Renames

A rename emits `delete` at every old path, then `create` at every new path, each subtree entry with its own `kind`. Renaming a directory therefore reports every descendant, not just the directory: deletes run deepest first (`/a/sub/y.txt`, `/a/sub`, `/a/x.txt`, `/a`), creates run parent first (`/b`, `/b/sub`, `/b/x.txt`, `/b/sub/y.txt`). Each subscriber receives only the events its `path`, `scope`, `recursive`, `events`, and `match` select:

- A recursive subscription on the old directory sees only the deletes; one on the new parent sees only the creates; a recursive subscription on `/` sees both.
- A non-recursive directory subscription on the parent sees only the directory's own `delete` and `create`.
- A `scope: 'file'` subscription on `/a/x.txt` receives `delete /a/x.txt`. A file subscription on `/b/x.txt` receives `create /b/x.txt`.
- `match` filters descendant paths like any other event.
- Renaming over an existing empty directory first emits `delete` for the replaced directory, then the rename events above.

A current-view reconciler does not need to infer subtree removal from a single directory delete, but it must treat each `delete` as removal of that path and each `create` as a path to reread.

## Content and recovery

`content: false` is the default and performs no content read. With `content: { maxBytes }`, an included payload is a copied final regular-file version from the completed mutation. It can be older than a later normal filesystem read, so do not use it as an upsert for a current view. Omissions distinguish disabled content, deletion, non-file entries, oversize files, and unavailable capture.

Subscribe before scanning. Record paths while the scan runs, then use one serialized updater that rereads current state. Remove a path from the pending set before awaiting its read so a later event can re-add it. Treat `ENOENT` as deletion. On overflow, interruption, callback failure, or an unrecoverable reread failure, discard the candidate and explicitly start a fresh subscription and scan. Before starting the fresh subscription, await the old subscription's `closed` and stop on `unknown`. An empty pending set does not prove a transport barrier. The packaged [current-view example](./examples/current-view.ts) implements this recovery pattern against the public API.

Each listener is serial. Different subscriptions progress independently. Listener exceptions terminate that subscription. `onError` receives `SUBSCRIPTION_OVERFLOW`, `SUBSCRIPTION_INTERRUPTED`, `SUBSCRIPTION_CALLBACK_FAILED`, or `SUBSCRIPTION_RESYNC_REQUIRED`; there is no automatic retry. A later subscribe after an unconfirmed failed setup rejects with `SUBSCRIPTION_RETIREMENT_UNKNOWN` until the owner generation changes.

## Limits and acceptance status

V1 bounds include 4,096 pending records per subscription, 32 MiB attached content per subscription, 16,384 pending recipient records per mounted owner, 192 MiB reserved content copies per mounted owner, 32 registrations per normal client, 128 per mount, and one unacknowledged event per subscription. The 16 MiB subscription owner metadata budget is separate from additive 16 MiB owner relay-control and per-client control guards.

Desktop browser checks do not establish physical-mobile behavior. Until a real WebKit or Android Chrome run is recorded, the physical-mobile acceptance gate is **unverified**.

The package README covers the public contract, accounting limits, and verified desktop scope. Repository design and acceptance notes are maintained with the source rather than copied into the package.

## Development and license

Build the core and plugin together with `pnpm --filter @opfs-vfs/plugin-subscriptions... build`. Run `pnpm --filter @opfs-vfs/plugin-subscriptions test` and `pnpm --filter @opfs-vfs/plugin-subscriptions test:packed` from the workspace. The packed check builds both packages from this checkout. Release through the workspace Changesets flow so the core peer range follows the released version.

This package uses the repository's [PolyForm Noncommercial License 1.0.0](LICENSE.md). Encryption remains a separately licensed premium plugin.

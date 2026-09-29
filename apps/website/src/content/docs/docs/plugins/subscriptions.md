---
title: File subscriptions
description: Watch OPFS VFS file changes with the subscriptions plugin, optional completed-file content, and explicit recovery when delivery stops.
---

`@opfs-vfs/plugin-subscriptions` reports live file and directory changes on an OPFS VFS volume. Use it to refresh a file browser, react to an AI tool's edits, or invalidate application caches. It is available in the [public repository](https://github.com/opfs-vfs/opfs-vfs/tree/main/packages/plugin-subscriptions) under the [PolyForm Noncommercial License](/licensing/).

Subscriptions begin with new changes after registration. They do not list existing files, replay past events, or synchronize data with a backend.

## Install

Install the core filesystem and subscription plugin from npm:

```sh
npm install @opfs-vfs/opfs-vfs @opfs-vfs/plugin-subscriptions
```

Serve the application over HTTPS or localhost with the [browser setup headers](/docs/guides/browser-setup/).

## Register a custom worker

The bundled core worker has an empty plugin registry. Create a worker that registers subscriptions:

```ts title="vfs.worker.ts"
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [subscriptions] });
```

Then enable the plugin from the page and subscribe before making changes:

```ts title="Watch from a page"
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

const fs = new OpfsVfsWorker('documents.bin', {
  worker: () => new Worker(new URL('./vfs.worker.ts', import.meta.url), { type: 'module' }),
  plugins: [subscriptionsRequest()],
});
await fs.ready;

const controller = new AbortController();
const subscription = await subscribe(
  fs,
  {
    path: '/',
    scope: 'directory',
    recursive: true,
    events: ['create', 'update', 'delete'],
    signal: controller.signal,
    onError: (error) => console.error('Subscription stopped:', error.code),
  },
  (change) => console.log(change.type, change.path, change.kind),
);

await fs.writeFileBuffer('/notes.txt', new TextEncoder().encode('First draft'));

// When the view is disposed, stop its subscription.
subscription.unsubscribe();
// controller.abort() is an alternative way to stop it.
await fs.closeVfs();
```

The returned promise resolves when registration succeeds. Invalid options or a failed setup reject that promise. `onError` is required and handles terminal failures after registration. The logging example above reports the error; an application maintaining a current view must also [rebuild that view](#keep-a-current-view).

The worker registration bundles executable plugin code; `subscriptionsRequest()` sends a serializable profile from a raw page client to enable it for this mount. React's managed `VolumeProvider` sends that request automatically. Every normal follower of the volume must request the same profile, including followers that do not subscribe. Plugins cannot be enabled on an already-open mount.

### Direct use inside a worker

Use `subscriptions()` to create a fresh instance for each direct mount. Synchronous OPFS access belongs in a dedicated worker, not the page:

```ts
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

const fs = new OpfsVfs('direct-documents.bin', { plugins: [subscriptions()] });
await fs.ready;
const handle = await subscribe(
  fs,
  { path: '/', scope: 'directory', onError: (error) => console.error(error.code) },
  (change) => console.log(change.type, change.path),
);
fs.writeFileBufferSync('/hello.txt', new TextEncoder().encode('Hello'));
handle.unsubscribe();
await fs.closeVfs();
```

## React across tabs

Tabs on the same origin can open the same OPFS VFS volume and subscribe to its changes. Each tab registers its own subscription and updates its own components when a matching event arrives, including changes made through another tab. Opening a tab alone does not subscribe its UI.

Use the same volume name and compatible plugin profile in each tab. This shares a local volume within the same browser storage context; it does not synchronize different browsers, profiles, or devices. Listeners progress independently, so delivery is not simultaneous across tabs. Handle terminal errors in each tab as described below.

## Choose what to watch

| Option      | Meaning                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | A literal file or directory path. Missing targets and ancestors can be watched for later creation. Existing ancestors must pass normal path-search checks; paths cannot traverse a symlink ancestor. |
| `scope`     | Required: `file` or `directory`.                                                                                                                                                                     |
| `recursive` | Include descendants of a directory. Defaults to `false`; not valid as `true` for a file watch.                                                                                                       |
| `events`    | A nonempty selection of `create`, `update`, and `delete`. Defaults to all three.                                                                                                                     |
| `match`     | Optional `RegExp` filter on the normalized, full event path.                                                                                                                                         |
| `content`   | Defaults to `false`. Set `{ maxBytes }` for a complete regular-file payload up to that size, at most 16 MiB.                                                                                         |
| `signal`    | Optional `AbortSignal` for cancellation.                                                                                                                                                             |
| `onError`   | Required terminal-error callback.                                                                                                                                                                    |

Events describe completed logical filesystem operations, not storage block writes. Reads, sync, checkpointing, and encryption housekeeping do not emit file-change events. A rename reports deletion at each old path and creation at each new path; renaming a directory reports every descendant too (deletes deepest first, then creates parent first), filtered by each subscription's path, scope, recursion, and `match`. A file subscription on a descendant sees the delete at its old path, not a rename event. Cursors order events within one mount generation; they are not replay tokens or proof that a write is durable.

Callbacks run serially for each subscription and may return a promise. Keep them short: a slow listener can fill its bounded queue. Throwing or rejecting from a listener terminates that subscription.

## Request completed-file content

```ts
import type { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

async function watchSettings(fs: OpfsVfsWorker) {
  return subscribe(
    fs,
    {
      path: '/settings.json',
      scope: 'file',
      content: { maxBytes: 64 * 1024 },
      onError: (error) => console.error(error.code),
    },
    (change) => {
      if (change.content.status === 'included') {
        console.log(new TextDecoder().decode(change.content.bytes));
      } else {
        console.log(change.type, change.content.reason);
      }
    },
  );
}
```

An included payload is the complete file at the end of that event's operation. If two writes finish before delivery, their events retain their respective versions. Reading `change.path` from the filesystem inside a callback instead reads its current state, which may be newer or already deleted.

Content can be omitted with `disabled`, `deleted`, `not-file`, `too-large`, or `unavailable`. An omission is not an empty file. Metadata-only subscriptions do not read file contents.

## Keep a current view

For a file list, search index, or editor sidebar, treat events as paths to reread rather than applying historical content as the latest state:

1. Register and await a subscription before scanning existing files.
2. During the scan, collect changed paths in a bounded pending set.
3. Use one serialized updater to reread pending paths. Remove each path from the set before awaiting its read, so a later event can enqueue it again. Treat `ENOENT` as deletion.
4. If the subscription stops or a reread fails, discard the candidate view and explicitly subscribe and scan again.

There is no atomic scan-plus-subscribe snapshot or catch-up barrier. The [current-view example](https://github.com/opfs-vfs/opfs-vfs/blob/main/packages/plugin-subscriptions/examples/current-view.ts) implements this recovery pattern, including abandoned scans and overlapping subtree invalidations.

### Terminal errors and bounds

| Error code                     | Response                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `SUBSCRIPTION_OVERFLOW`        | A queue or reservation limit was reached. Rebuild the view with a new subscription and scan.                 |
| `SUBSCRIPTION_INTERRUPTED`     | The owner or transport was interrupted. Reconnect as needed, then register and scan again.                   |
| `SUBSCRIPTION_CALLBACK_FAILED` | The listener threw or rejected. Fix the callback failure before restarting.                                  |
| `SUBSCRIPTION_RESYNC_REQUIRED` | A mutation could not be represented safely, including an uncertain partial failure. Register and scan again. |

The current limits include 4,096 pending records and 32 MiB attached content per subscription, 32 registrations per normal client, and 128 registrations per mount. Mount-wide budgets also apply. Writes do not wait for slow listeners; overflow ends the affected subscription instead of silently dropping individual records.

Calling `unsubscribe()` or aborting intentionally stops future callbacks without `onError`. A callback already running is not cancelled. Terminal errors do not reconnect automatically.

See the [full specification](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/specs/file-subscriptions.md) for matching, event ordering, permission checks, and all accounting limits.

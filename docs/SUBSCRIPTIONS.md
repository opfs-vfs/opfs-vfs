# Subscriptions plugin API

`@opfs-vfs/plugin-subscriptions` exposes a direct/worker registration factory from its main entry, an empty-profile request from `/config`, and `subscribe()` plus its public types from `/client`. It reports live logical changes after registration; it does not enumerate, replay, or create an atomic scan-plus-live snapshot. See the [full subscription specification](specs/file-subscriptions.md) and [implementation design](designs/file-subscriptions.md) for the normative bounds and recovery contract.

```ts
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { subscribe } from '@opfs-vfs/plugin-subscriptions/client';

async function watch(name: string) {
  const fs = new OpfsVfs(name, { plugins: [subscriptions()] });
  await fs.ready;
  const subscription = await subscribe(
    fs,
    {
      path: '/',
      scope: 'directory',
      recursive: true,
      events: ['create', 'update', 'delete'],
      content: { maxBytes: 1024 * 1024 },
      onError: (error) => console.error(error.code),
    },
    async (change) => {
      // Reconcile from fs: historical content is not an upsert for current state.
      console.log(change.path, change.content.status);
    },
  );
  return { fs, subscription };
}
```

`content` defaults to `false`. With `content: { maxBytes }`, a completed regular-file record either has copied historical bytes or an omission reason. Deletion, non-files, content disabled, oversize files, and capture failures are omissions. Listeners are serial per subscription; subscriptions progress independently. Overflow, interruption, callback failure, or unrecoverable reconciliation failure requires an explicit fresh subscription and scan. `unsubscribe()` and abort stop future local callbacks without replay or automatic retry, and `await subscription.closed` reports `released` after owner cleanup or `unknown` with an error when confirmation was lost.

The fixed v1 bounds include one unacknowledged event per subscription, 4,096 pending records per subscription, 32 MiB retained content per subscription, 16,384 pending recipient records per owner, and 192 MiB reserved content copies per owner. Subscription owner metadata has its own 16 MiB budget; S3 owner-relay and per-client transport controls have additive 16 MiB guards. These are distinct accounting limits.

Desktop Chromium evidence does not close physical-mobile acceptance. Until a physical WebKit or Android Chrome run is recorded, that gate remains **unverified**.

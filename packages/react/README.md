# OPFS VFS React SDK (preview)

`@opfs-vfs/react` supplies React providers, lifecycle hooks, live file reads, and a browser persistence-permission hook for OPFS VFS worker clients.

This preview package is not published yet. Use a matching packed artifact or workspace checkout together with matching `@opfs-vfs/opfs-vfs` and `@opfs-vfs/plugin-subscriptions` artifacts.

```tsx
import { useState } from 'react';
import { VolumeProvider, useFileContent, useVolumeClient } from '@opfs-vfs/react';

function Note() {
  const fs = useVolumeClient();
  const note = useFileContent('/note.txt', { format: 'text' });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!fs) return;
    await fs.writeFileBuffer('/note.txt', new TextEncoder().encode('Hello'));
    await fs.sync();
  };
  return (
    <>
      <button onClick={() => void save().catch((cause) => setError(String(cause)))}>{note.data}</button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

export function App() {
  return (
    <VolumeProvider fileName="notes.bin">
      <Note />
    </VolumeProvider>
  );
}
```

Without a `worker` prop, the React SDK uses its built-in subscriptions worker. It defaults to `transport="auto"`: it selects a compatible built-in SharedWorker when possible, or a dedicated worker with an observable fallback reason. Inspect `useVolume().transport` and `fallbackReason` to show what opened. Set `transport="dedicated"` or `"shared-worker"` for an explicit choice; forced shared reports its lifecycle error instead of falling back.

An application worker needs the matching worker-side plugin:

```ts
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [subscriptions] });
```

## SharedWorker override

Choose SharedWorker explicitly when compatible pages should share one named application worker. It never falls back to a dedicated worker. Keep the module-level factory and worker module fixed for every page that opens the volume; return a new `SharedWorker` per call, with a stable name derived from the basename:

```tsx
const worker = () => new Worker(new URL('./vfs.worker.ts', import.meta.url), { type: 'module' });
const sharedWorker = (fileName: string) =>
  new SharedWorker(new URL('./vfs.sharedworker.ts', import.meta.url), {
    type: 'module',
    name: `my-vfs-${fileName}`,
  });

<VolumeProvider
  fileName="notes.bin"
  worker={worker}
  transport="shared-worker"
  sharedWorker={sharedWorker}
  plugins={[subscriptionsRequest()]}
>
  <Note />
</VolumeProvider>;
```

```ts title="vfs.sharedworker.ts"
import { startVfsSharedWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsSharedWorker({ plugins: [subscriptions] });
```

This transport requires the normal COOP/COEP and page `SharedArrayBuffer` gate, plus OPFS sync access in the SharedWorker; unsupported browsers report an error without fallback. An application `worker` with no `sharedWorker` factory uses dedicated transport under `auto` and reports that factory-unavailable fallback. One host owns one volume: do not deliberately mix transports or expect shared React caches, synchronous calls, or guaranteed background lifetime.

`close()` closes compatible aliases in this page but not other pages; unmounting retains the managed client. Global shutdown, optional deletion, and private-plugin key cleanup stay caller-owned: create a temporary raw follower with `createSharedWorkerFollower`, await `ready`, await `shutdownSharedVfs()`, then delete only when the application intends to erase the volume. Coordinate all pages—there is no atomic shutdown-and-delete. See the [React SharedWorker guide](https://opfs.dev/docs/react/#sharedworker-ownership-and-limits) for compatibility, profile, owner-loss, and error-handling limits.

See the website's React SDK preview guide for lifecycle states, generation-safe commands, live reads, persistence permission, and cleanup.

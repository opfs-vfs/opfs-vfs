# OPFS VFS React SDK (preview)

`@opfs-vfs/react` supplies React providers, lifecycle hooks, live file reads, and a browser persistence-permission hook for OPFS VFS worker clients.

Install the preview package with its core and subscriptions peers:

```sh
npm install @opfs-vfs/opfs-vfs @opfs-vfs/plugin-subscriptions @opfs-vfs/react
```

Use the exact core and subscriptions versions listed in the SDK's peer dependencies, and upgrade the three packages together. The bundled default workers contain a copy of the storage engine, so a different core version would run a different engine than the one you installed.

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

If the built-in SharedWorker script cannot be loaded, the volume reports a lifecycle error with code `VFS_WORKER_FAILED` and a message that names the usual causes; it does not fall back. Under Vite 7's dev server this affects the default `<VolumeProvider fileName>`: dependency pre-bundling moves the packages, so the built-in SharedWorker script URL returns 404. Exclude them from pre-bundling:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['@opfs-vfs/opfs-vfs', '@opfs-vfs/react', '@opfs-vfs/plugin-subscriptions'] },
});
```

Vite 8 needs no setting. Other bundlers and dev servers have not been tested. A Content-Security-Policy that blocks the worker script produces the same error. You can also pass a `sharedWorker` factory or set `transport="dedicated"`.

A custom application worker must register the subscriptions plugin. `VolumeProvider` requests it automatically for managed volumes, so the page does not need `subscriptionsRequest()` or a `plugins` prop for subscriptions:

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

<VolumeProvider fileName="notes.bin" worker={worker} transport="shared-worker" sharedWorker={sharedWorker}>
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

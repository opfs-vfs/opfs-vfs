---
title: Getting started
description: Install OPFS VFS and create, write, synchronize, and reopen your first browser volume.
---

Install the package in your browser application:

```sh
npm install @opfs-vfs/opfs-vfs
```

Serve the app over HTTPS or localhost with the [isolation headers](/docs/guides/browser-setup/). The worker client moves filesystem work off the page thread:

```ts
import { OpenFlags } from '@opfs-vfs/opfs-vfs';
import { openOpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';

const volume = await openOpfsVfsWorker('documents.bin');
await volume.ready;

const fd = await volume.open('/hello.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
try {
  await volume.write(fd, new TextEncoder().encode('Hello, persistent files!'));
  await volume.fsync(fd);
} finally {
  await volume.close(fd);
}

await volume.flushVfs();
await volume.closeVfs();
```

Reopen `documents.bin` from the same origin to read the saved data. The name identifies the entire volume, including its supporting files; it must be a basename ending in `.bin`. Closing a file descriptor and closing a volume are different operations.

## Choose a worker transport

`openOpfsVfsWorker()` uses a compatible bundled `SharedWorker` when available and otherwise opens a bundled dedicated worker. Inspect `volume.getStatus().transport` and `fallbackReason` to show the actual selection. Pass `{ transport: 'dedicated' }` or `{ transport: 'shared-worker' }` when your application needs an explicit choice; forced shared transport reports its error instead of silently changing transport. `new OpfsVfsWorker()` remains the dedicated-worker constructor.

## Custom workers and shared volumes

For an application worker or plugins, pass its `worker` factory. Auto transport chooses dedicated unless you also provide a stable module-level `sharedWorker` factory. Shared clients have asynchronous APIs only. A local close does not stop other pages; coordinate an intentional global shutdown and deletion. Owner loss is terminal, so create a fresh client and reread state before retrying a possibly applied write.

Try the [filesystem demo](/demos/filesystem/) or connect a [just-bash shell](/docs/integrations/just-bash/). For a database, use the [PGlite adapter](/docs/integrations/pglite/).

---
title: just-bash
description: Connect a just-bash shell to an OPFS VFS volume and manage its workspace and limits.
---

```sh
npm install @opfs-vfs/opfs-vfs just-bash
```

The just-bash adapter lets shell commands read and write files in an OPFS VFS volume. Create a worker client, connect the adapter, and pass it to the shell:

```js
import { Bash } from 'just-bash/browser';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';

const volume = new OpfsVfsWorker('shell.bin');
await volume.ready;
const fs = new OpfsVfsJustBashAdapter(volume);
await fs.mkdir('/workspace', { recursive: true });
const shell = new Bash({ fs, cwd: '/workspace' });
const result = await shell.exec('printf "Hello from just-bash" > greeting.txt');
if (result.exitCode !== 0) throw new Error(result.stderr);
await volume.flushVfs();
console.log(await fs.readFile('/workspace/greeting.txt'));
await volume.closeVfs();
```

The adapter adds no just-bash runtime dependency to ordinary OPFS VFS use. Keep the volume open for the lifetime of a shell session and close it on teardown.

Mount only the intended workspace when offering a browser shell. Generated or untrusted commands need command, path, output, byte, and time limits. Prompt wording alone is not a security boundary. The [local AI demo](/demos/ai/) offers the just-bash browser interpreter and literal text writes within the selected virtual volume. Models can rename, move and permanently delete files as well as create, edit and copy them. Host filesystem and network access are unavailable; command size, output, execution and conversation limits still apply.

---
title: Files and directories
description: Create, read, write, and remove files and directories through the worker client.
---

The worker client offers asynchronous POSIX-style operations. After `await volume.ready`, create a directory and file:

```ts
import { OpenFlags } from '@opfs-vfs/opfs-vfs';

await volume.mkdir('/notes', { recursive: true });
const fd = await volume.open('/notes/today.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
try {
  await volume.write(fd, new TextEncoder().encode('A garden on the moon.'), 0);
  const { buffer, read } = await volume.read(fd, 1024, 0);
  console.log(new TextDecoder().decode(buffer.subarray(0, read)));
} finally {
  await volume.close(fd);
}

await volume.rename('/notes/today.txt', '/notes/garden.txt');
console.log(await volume.readdir('/notes'));
await volume.flushVfs();
```

`OpenFlags.O_TRUNC` explicitly truncates an existing file. Without it, writing shorter content can leave the old trailing bytes in place. Use `unlink` to remove a file and `rmdir` to remove an empty directory. Await `closeVfs()` when the application is finished with the volume.

The just-bash adapter adds convenient `readFile`, `writeFile`, `mkdir`, `mv`, and `rm` methods. Its `writeFile` replaces the full file and creates missing parent directories.

When accepting uploaded files or generated paths, validate paths and set quotas. Render arbitrary HTML in a sandboxed iframe, never in the application DOM; the website demo shows this pattern.

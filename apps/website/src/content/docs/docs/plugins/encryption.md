---
title: Encryption
description: Create and reopen encrypted OPFS VFS volumes with the premium encryption plugin, custom workers, and optional passkeys.
---

`@opfs-vfs/plugin-encryption` encrypts a volume's stored data and supports password, recovery-secret, and passkey access. It is a **private, paid plugin**, available separately from the core filesystem and community plugins.

Arrange package access and written permission with the copyright holder before installation or use. Use the contact button on the [licensing page](/licensing/) to discuss access. That page describes the core license; premium access and usage rights require separate terms. Follow the installation instructions supplied with your access.

## Register an application worker

Serve your application over HTTPS or localhost with the [browser setup headers](/docs/guides/browser-setup/). The page client needs cross-origin isolation for shared buffers, and synchronous OPFS access runs in a dedicated worker.

The bundled core worker has no plugins. Create a worker that registers encryption:

```ts title="filesystem.worker.ts"
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { encryption } from '@opfs-vfs/plugin-encryption';

startVfsWorker({ plugins: [encryption] });
```

Registration makes encryption available. The page enables it for a mount with `encryptionRequest({ secret })`. The lightweight `/config` entry belongs on the page; the encryption implementation belongs in your worker.

## Create an encrypted volume

Collect the secret through your application's credential flow before constructing the client. This example creates a new volume and confirms a save only after persistence and cleanup succeed:

```ts title="create-document.ts"
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { encryptionRequest } from '@opfs-vfs/plugin-encryption/config';

export async function createDocument(secret: string | Uint8Array, text: string) {
  const fs = new OpfsVfsWorker('documents.bin', {
    worker: () => new Worker(new URL('./filesystem.worker.ts', import.meta.url), { type: 'module' }),
    openMode: 'create-new',
    plugins: [encryptionRequest({ secret })],
  });
  try {
    await fs.ready;
    await fs.writeFileBuffer('/notes.txt', new TextEncoder().encode(text));
    await fs.flushVfs();
  } finally {
    await fs.closeVfs();
  }
  return 'saved';
}
```

`create-new` refuses an occupied destination. Keep a client open for a live application session, then close it when the session ends. Do not log secrets, and clear application references when finished; JavaScript strings and browser copies cannot be reliably zeroed.

## Reopen an existing volume

Opening uses `open-existing`, so a missing volume is not silently recreated. Await readiness before reading or writing:

```ts title="read-document.ts"
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { encryptionRequest } from '@opfs-vfs/plugin-encryption/config';

export async function readDocument(secret: string | Uint8Array) {
  const fs = new OpfsVfsWorker('documents.bin', {
    worker: () => new Worker(new URL('./filesystem.worker.ts', import.meta.url), { type: 'module' }),
    openMode: 'open-existing',
    plugins: [encryptionRequest({ secret })],
  });
  try {
    await fs.ready;
    return new TextDecoder().decode(await fs.readFileBuffer('/notes.txt'));
  } finally {
    await fs.closeVfs();
  }
}
```

A rejected readiness attempt is terminal. Close that client and construct a fresh one to retry. Rejected credentials, damaged encrypted storage, or incompatible formats must never trigger a plaintext fallback. Applications supporting both plaintext and encrypted volumes can inspect with core `peekVolume` before prompting; inspection does not establish that a volume can be decrypted.

## Passkeys

Passkeys require a browser and authenticator with WebAuthn PRF support. Prepare credentials in the foreground page from a user action, before creating the filesystem client. A new passkey volume also needs a password or recovery secret. Persist its non-secret descriptor outside the volume before creation, and use `initialPasskey` only with `create-new`. Reopening uses a fresh assertion and no `initialPasskey`.

Support varies by browser and authenticator. Handle cancellation and unsupported results explicitly, and keep recovery available. Licensed users can follow the [passkey guide and application example](https://github.com/opfs-vfs/opfs-vfs-premium/blob/main/docs/PASSKEYS.md), which require repository access.

## Protection and recovery

Encryption protects stored data at rest. It does not protect against same-origin code while the volume is unlocked, or detect replacement of the entire volume with an older, internally consistent copy without an external anchor. Crash recovery also has a limited prior-block rollback window; an unchanged sync does not retire the old seal. See the access-restricted [compatibility and recovery guide](https://github.com/opfs-vfs/opfs-vfs-premium/blob/main/docs/COMPATIBILITY.md).

A matching same-origin follower can use an already-unlocked owner's volume. Its secret is checked only if it takes ownership. Successful follower attachment is not fresh authentication. All clients sharing a volume must request compatible plugin profiles.

Encryption and [file subscriptions](/docs/plugins/subscriptions/) can be enabled together. Included subscription content contains decrypted application bytes, just like a normal file read.

Adding encryption to an existing plaintext mount does not convert it. Migration copies into a separate, fresh destination and keeps the source. It does not preserve permissions, timestamps, or hard-link identity. Verify the destination before deciding whether to delete the source. Licensed users can find configuration, migration, archive, and error details in the access-restricted [API guide](https://github.com/opfs-vfs/opfs-vfs-premium/blob/main/docs/API.md).

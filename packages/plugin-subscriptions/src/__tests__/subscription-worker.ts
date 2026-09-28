import { deleteVolume, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscribe } from '../client';
import { subscriptions } from '../index';

self.onmessage = async () => {
  const name = `subscriptions-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfs(name, { plugins: [subscriptions()] });
  try {
    await fs.ready;
    const seen: string[] = [];
    const ready = await subscribe(
      fs,
      {
        path: '/',
        scope: 'directory',
        recursive: true,
        events: ['create'],
        onError: (cause) => {
          throw cause;
        },
      },
      (change) => {
        seen.push(`${change.type}:${change.path}:${change.content.status}`);
      },
    );
    fs.writeFileBufferSync('/created.txt', new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ready.unsubscribe();
    self.postMessage({ seen });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause) });
  } finally {
    await fs.closeVfs();
    await deleteVolume(name);
  }
};

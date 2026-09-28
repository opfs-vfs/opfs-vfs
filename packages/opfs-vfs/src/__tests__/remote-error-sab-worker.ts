import { OpfsVfsWorker } from '../index_internal';

self.onmessage = async () => {
  const client = new OpfsVfsWorker(`remote-error-sab-${crypto.randomUUID()}.bin`, { forceLeader: true });
  try {
    await client.ready;
    try {
      client.statSync('/missing');
      throw new Error('Expected missing-path error');
    } catch (error) {
      self.postMessage({
        code: typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined,
        errno: typeof error === 'object' && error !== null ? (error as { errno?: unknown }).errno : undefined,
        name: error instanceof Error ? error.name : undefined,
      });
    }
  } finally {
    await client.closeVfs().catch(() => client.dispose());
  }
};

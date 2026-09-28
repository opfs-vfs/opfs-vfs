/// <reference lib="webworker" />

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = async (event: MessageEvent<{ readonly type: 'probe'; readonly fileName: string }>) => {
  if (event.data.type !== 'probe') return;
  try {
    const root = await navigator.storage.getDirectory();
    const entry = await root.getFileHandle(event.data.fileName, { create: true });
    const handle = await entry.createSyncAccessHandle();
    try {
      handle.write(new Uint8Array([112, 114, 111, 98, 101]));
      handle.flush();
    } finally {
      handle.close();
    }
    await root.removeEntry(event.data.fileName);
    worker.postMessage({ type: 'native-ready' });
  } catch {
    worker.postMessage({ type: 'native-failed' });
  }
};

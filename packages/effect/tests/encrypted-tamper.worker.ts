interface TamperRequest {
  readonly fileName: string;
  readonly offset: number;
}

self.onmessage = async (event: MessageEvent<TamperRequest>) => {
  let access: FileSystemSyncAccessHandle | undefined;
  try {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle(event.data.fileName);
    access = await file.createSyncAccessHandle();
    const byte = new Uint8Array(1);
    if (access.read(byte, { at: event.data.offset }) !== 1) throw new Error('tamper byte was unavailable');
    byte[0] ^= 0x80;
    if (access.write(byte, { at: event.data.offset }) !== 1) throw new Error('tamper write was incomplete');
    access.flush();
    self.postMessage({ ok: true });
  } catch {
    self.postMessage({ ok: false });
  } finally {
    access?.close();
  }
};

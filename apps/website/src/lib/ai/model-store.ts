import { sha256 } from '@noble/hashes/sha2.js';
import { model } from './ai-model-catalog';

const directoryName = 'opfs-vfs-website-models';
const fileName = `${model.id}-${model.revision}.task`;
const receiptName = `${fileName}.verified`;
const lockName = 'opfs-vfs-website-model-install';

async function directory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName, { create: true });
}

export async function installedModel(): Promise<File | null> {
  try {
    const dir = await directory();
    const receipt = await (await dir.getFileHandle(receiptName)).getFile();
    if ((await receipt.text()) !== model.sha256) return null;
    const file = await (await dir.getFileHandle(fileName)).getFile();
    return file.size === model.bytes ? file : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

export async function downloadModel(signal: AbortSignal, progress: (bytes: number) => void) {
  await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Model storage is in use by another tab. Retry when it finishes.');
    if (await installedModel()) return;
    const quota = await navigator.storage.estimate();
    if (quota.quota && quota.quota - (quota.usage ?? 0) < model.bytes * 1.2) {
      throw new Error('Not enough available browser storage for this model. Free at least 2.5 GB and retry.');
    }
    signal.throwIfAborted();
    const response = await fetch(model.url, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Model download failed (${response.status}). Check the model source and retry.`);
    const length = response.headers.get('content-length');
    if (length && Number(length) !== model.bytes) throw new Error('The model size does not match the pinned artifact.');
    const dir = await directory();
    const output = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
    const reader = response.body.getReader();
    const hash = sha256.create();
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > model.bytes) throw new Error('The download exceeds the pinned model size.');
        hash.update(chunk.value);
        await output.write(chunk.value);
        progress(bytes);
      }
      signal.throwIfAborted();
      const digest = Array.from(hash.digest(), (value) => value.toString(16).padStart(2, '0')).join('');
      if (bytes !== model.bytes || digest !== model.sha256)
        throw new Error('Model integrity check failed. The incomplete download has been removed.');
      await output.close();
      const receipt = await (await dir.getFileHandle(receiptName, { create: true })).createWritable();
      await receipt.write(model.sha256);
      await receipt.close();
    } catch (error) {
      await output.abort().catch(() => {});
      await dir.removeEntry(fileName).catch(() => {});
      await dir.removeEntry(receiptName).catch(() => {});
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      hash.destroy();
    }
  });
}

export async function removeModel() {
  await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is downloading the model. Wait before removing it.');
    const dir = await directory();
    for (const name of [receiptName, fileName]) {
      try {
        await dir.removeEntry(name);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    }
  });
}

export async function modelCapability(): Promise<string | null> {
  if (!window.isSecureContext || !window.crossOriginIsolated)
    return 'Open the site on HTTPS or localhost with cross-origin isolation enabled.';
  if (!navigator.gpu) return 'This browser does not expose WebGPU. The files and database demos remain available.';
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || !adapter.features.has('shader-f16'))
    return 'This GPU does not support the shader-f16 feature required by Gemma.';
  if (adapter.limits.maxBufferSize < 524_550_144 || adapter.limits.maxStorageBufferBindingSize < 524_550_144)
    return 'This GPU’s buffer limits are too small for this Gemma runtime.';
  return null;
}

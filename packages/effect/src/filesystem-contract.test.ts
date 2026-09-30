import { expect, it } from 'vitest';

const runContract = (mode: 'direct' | 'worker') => {
  const worker = new Worker(new URL('./filesystem-contract.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${mode} filesystem contract timed out`)), 60_000);
    worker.onerror = (event) => {
      clearTimeout(timeout);
      reject(event.error ?? new Error(event.message));
    };
    worker.onmessage = ({ data }: MessageEvent<{ ok: boolean; result?: Record<string, unknown>; error?: string }>) => {
      clearTimeout(timeout);
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error ?? `${mode} filesystem contract failed`));
    };
    worker.postMessage({ mode });
  }).finally(() => worker.terminate());
};

const assertContract = (result: Record<string, unknown>) => {
  expect(result.directoryListing).toContain('nested/payload.bin');
  expect(result.directLinkTarget).toBe('nested/payload.bin');
  expect(result.realPathMatches).toBe(true);
  expect(result.copiedFileMatches).toBe(true);
  expect(result.copiedTreeMatches).toBe(true);
  expect(result.writeInputRetained).toBe(true);
  expect(result.fileWriteInputRetained).toBe(true);
  expect(result.copiedLinkTarget).toBe('nested/payload.bin');
  expect(result.overwriteReplacedLink).toBe(true);
  expect(result.overwritePreservedTarget).toBe(true);
  expect(result.overwriteCopiedContents).toBe(true);
  expect(result.times).toEqual({ atimeMs: 1234, mtimeMs: 5000 });
  expect(result.stat).toEqual({ type: 'File', size: 7n });
  expect(result.temps).toEqual({
    directoryExistsInScope: true,
    directoryRemoved: true,
    directoryPrefix: true,
    fileExistsInScope: true,
    fileRemoved: true,
    filePrefix: true,
    fileSuffix: true,
  });
  expect(result.file).toEqual({
    bytesRead: 2,
    initial: [10, 20],
    positionAfterRead: 2n,
    bytesWritten: 1,
    contents: [10, 20, 99, 40],
    size: 4n,
  });
  expect(['baseAB', 'baseBA']).toContain(result.concurrentAppend);
  expect(result.largeAppend).toEqual({
    size: 16n * 1024n * 1024n + 3n,
    prefixMatches: true,
    finalBytesRead: 3,
    finalBytes: [0x70, 0x71, 0x72],
    originalLength: 16 * 1024 * 1024,
    inputRetained: true,
  });
  expect(result.stream).toEqual({ size: 256 * 1024, matches: true });
};

it('runs the shared filesystem contract against direct OPFS in a module worker', async () => {
  assertContract(await runContract('direct'));
}, 65_000);

it('runs the shared filesystem contract against worker-backed OPFS', async () => {
  assertContract(await runContract('worker'));
}, 65_000);

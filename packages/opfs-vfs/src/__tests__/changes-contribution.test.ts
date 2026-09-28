import { expect, it } from 'vitest';
import { validateConfiguredPlugins } from '../plugin-config';
import type { ConfiguredVfsPlugin } from '../plugins';

it('provides the S1 direct logical-change contribution seam', async () => {
  const worker = new Worker(new URL('./changes-contribution-worker.ts', import.meta.url), { type: 'module' });
  try {
    const checks = await new Promise<{ pass: boolean; detail: string }[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('changes contribution worker timed out')), 15_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = (event) => {
        clearTimeout(timer);
        if (event.data?.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.postMessage(null);
    });
    for (const result of checks) expect(result.pass, result.detail).toBe(true);
  } finally {
    worker.terminate();
  }
});

it('keeps the storage and logical-change slots independent and single-use', () => {
  const create = (() => ({
    control() {
      return { type: 'ok' as const };
    },
    completed() {},
    invalidated() {},
    clientClosed() {},
    close() {},
  })) as never;
  const storage = {
    id: 'storage',
    contractVersion: 1 as const,
    compatibilityKey: 'storage',
    storage: { factory: (async () => ({ data: {} })) as never, sidecars: [] },
  } satisfies ConfiguredVfsPlugin;
  const changes = {
    id: 'changes',
    contractVersion: 1 as const,
    compatibilityKey: 'changes',
    logicalChanges: { version: 1 as const, create },
  } satisfies ConfiguredVfsPlugin;
  expect(validateConfiguredPlugins([storage, changes], 'open-or-create', 'slots.bin')).toHaveLength(2);
  expect(validateConfiguredPlugins([changes, storage], 'open-or-create', 'slots.bin')).toHaveLength(2);
  expect(() =>
    validateConfiguredPlugins([changes, { ...changes, id: 'changes-2' }], 'open-or-create', 'slots.bin'),
  ).toThrow('Multiple logical-change');
  expect(() =>
    validateConfiguredPlugins(
      [{ ...storage, storage: { ...storage.storage, factory: create } }, changes],
      'open-or-create',
      'slots.bin',
    ),
  ).toThrow('factory already used');
});

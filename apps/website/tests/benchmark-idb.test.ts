import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteBenchmarkIdb } from '../src/lib/benchmark-idb.ts';

void test('IndexedDB cleanup waits through blocked, requires success, and bounds failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  let request: IDBOpenDBRequest;
  const deleted: string[] = [];
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      databases: async () => [{ name: '/pglite/unique-benchmark' }, { name: 'unrelated' }],
      deleteDatabase(name: string) {
        deleted.push(name);
        request = { error: new Error('delete failed') } as unknown as IDBOpenDBRequest;
        return request;
      },
    },
  });
  try {
    let settled = false;
    const success = deleteBenchmarkIdb('unique-benchmark').finally(() => {
      settled = true;
    });
    await Promise.resolve();
    request!.onblocked?.call(request!, new Event('blocked') as IDBVersionChangeEvent);
    await Promise.resolve();
    assert.equal(settled, false);
    request!.onsuccess?.call(request!, new Event('success'));
    await success;
    assert.deepEqual(deleted, ['/pglite/unique-benchmark']);

    const failure = deleteBenchmarkIdb('unique-benchmark');
    await Promise.resolve();
    request!.onerror?.call(request!, new Event('error'));
    await assert.rejects(failure, /delete failed/);

    const timeout = deleteBenchmarkIdb('unique-benchmark');
    await Promise.resolve();
    t.mock.timers.tick(5000);
    await assert.rejects(timeout, /within 5 seconds/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});

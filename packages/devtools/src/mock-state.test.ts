import { fixtures } from './mock-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDelete, clampRect, connect, filterFiles } from './mock-state.ts';

await test('mock ownership, discovery and viewport constraints', () => {
  const [application, idle, , busy, protectedVolume] = fixtures();
  assert.equal(connect({ ...application, connection: 'none' }).connection, 'passive');
  assert.equal(connect(idle).connection, 'owned');
  assert.equal(canDelete(idle), true);
  assert.equal(canDelete(connect(idle)), false);
  assert.equal(canDelete(application), false);
  assert.equal(connect(busy).connection, 'none');
  assert.equal(connect(protectedVolume).connection, 'none');
  assert.equal(connect({ ...application, state: 'disconnected', connection: 'none' }).connection, 'none');
  assert.equal(filterFiles(application.files, 'DATA/', 'name').length, 2);
  const rect = clampRect({ x: 2000, y: -500, width: 1100, height: 800 }, 390, 700);
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 700);
});

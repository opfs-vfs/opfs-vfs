import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtures } from './mock-fixtures.ts';
import { connect } from './mock-state.ts';
import { applyFileOperation, captureClipboard } from './mock-files.ts';
await test('file operations preserve trees, snapshots and access checks', () => {
  let volumes = fixtures().map(connect);
  const writes = { 'workspace.bin': true };
  const apply = (op: Parameters<typeof applyFileOperation>[2]) => {
    volumes = applyFileOperation(volumes, 'workspace.bin', op, writes);
  };
  assert.throws(
    () => applyFileOperation(volumes, 'workspace.bin', { kind: 'delete', path: '/notes' }, {}),
    /Enable writes/,
  );
  apply({ kind: 'folder', parent: '/', name: 'copies' });
  apply({ kind: 'file', parent: '/copies', name: 'empty.txt' });
  for (const name of ['..', '../escape', 'a/b', '', 'a\0b'])
    assert.throws(() => apply({ kind: 'file', parent: '/', name }));
  assert.throws(() => apply({ kind: 'file', parent: '/missing', name: 'x.txt' }));
  let clipboard = captureClipboard(volumes[0], '/notes', false);
  apply({ kind: 'paste', parent: '/copies', clipboard });
  assert.ok(volumes[0].files.some((f) => f.path === '/copies/notes/todo.txt'));
  assert.throws(() => apply({ kind: 'paste', parent: '/copies', clipboard }), /already in use/);
  assert.throws(() => apply({ kind: 'paste', parent: '/notes', clipboard }), /outside/);
  apply({ kind: 'rename', path: '/copies/notes', name: 'renamed' });
  assert.ok(volumes[0].files.some((f) => f.path === '/copies/renamed/todo.txt'));
  apply({ kind: 'folder', parent: '/', name: 'notes-other' });
  apply({ kind: 'delete', path: '/copies/renamed' });
  assert.ok(volumes[0].files.some((f) => f.path === '/notes-other'));
  clipboard = captureClipboard(volumes[0], '/notes', true);
  apply({ kind: 'file', parent: '/notes', name: 'changed.txt' });
  assert.throws(() => apply({ kind: 'paste', parent: '/copies', clipboard }), /source changed/);
  clipboard = captureClipboard(volumes[0], '/notes', true);
  volumes = applyFileOperation(volumes, 'scratch.bin', { kind: 'paste', parent: '/', clipboard }, writes);
  assert.ok(!volumes[0].files.some((f) => f.path === '/notes'));
  assert.ok(volumes[1].files.some((f) => f.path === '/notes/changed.txt'));
  const image = captureClipboard(volumes[0], '/public/checker.png', false);
  assert.notEqual(image.entries[0].bytes, volumes[0].files.find((f) => f.path === image.path)?.bytes);
});

import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
const bridgeUrl = new URL('file://' + process.env.WASMER_SDK_DIR + '/js/dist/sync-fs.js').href;
const { registerSyncFileSystem, unregisterSyncFileSystems } = await import(bridgeUrl);
let closed = [];
const id = registerSyncFileSystem({
  metadata(path) {
    if (path === '/missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { kind: 'file', size: 4 };
  },
  readDir() {
    return [{ name: 'bin', kind: 'file', size: 4 }];
  },
  open() {
    return 7;
  },
  read() {
    return new Uint8Array([0, 128, 255, 10]);
  },
  write(fd, bytes) {
    assert.deepEqual([...bytes], [0, 255]);
    return bytes.length;
  },
  close(fd) {
    closed.push(fd);
  },
});
const worker = new Worker(
  `
  const { parentPort, workerData } = require('node:worker_threads');
  const assert = require('node:assert/strict');
  globalThis.postMessage = data => parentPort.postMessage(data);
  import(${JSON.stringify(bridgeUrl)}).then(({installSyncFsWorker}) => {
    installSyncFsWorker();
    const call = (method,...args) => globalThis.__wasmerSyncFsCall(workerData,method,args);
    assert.deepEqual(call('metadata','/bin'),{kind:'file',size:4});
    assert.throws(() => call('metadata','/missing'), {code:'ENOENT'});
    assert.equal(call('open','/bin',{read:true,write:true,append:false,truncate:false,create:false,createNew:false}),7);
    assert.deepEqual([...call('read',7,4)],[0,128,255,10]);
    assert.equal(call('write',7,new Uint8Array([0,255])),2);
    assert.throws(() => call('read',7,65537),{code:'EINVAL'});
    assert.throws(() => call('metadata','/../escape'),{code:'EINVAL'});
    parentPort.postMessage({done:true});
  }).catch(error => { throw error; });
`,
  { eval: true, workerData: id },
);
await new Promise((resolve, reject) => {
  worker.on('error', reject);
  worker.on('message', (message) => {
    if (message.done) resolve();
    else assert.equal(globalThis.__wasmerHandleFileSystemRpc(message), true);
  });
});
await worker.terminate();
unregisterSyncFileSystems([id]);
assert.deepEqual(closed, [7]);
assert.throws(() => globalThis.__wasmerSyncFsCall(id, 'metadata', ['/bin']), { code: 'EBADF' });
let calls = 0;
const cancelledId = registerSyncFileSystem({
  metadata() {
    calls++;
    return { kind: 'file', size: 0 };
  },
});
const response = new SharedArrayBuffer(4 * 1024 * 1024 + 16);
new Int32Array(response)[0] = 3;
assert.equal(
  globalThis.__wasmerHandleFileSystemRpc({
    type: 'wasmer-fs-rpc',
    bridgeId: cancelledId,
    method: 'metadata',
    args: ['/'],
    response,
  }),
  true,
);
assert.equal(calls, 0);
unregisterSyncFileSystems([cancelledId]);
const asyncId = registerSyncFileSystem({
  metadata() {
    return Promise.resolve({ kind: 'file', size: 0 });
  },
});
assert.throws(() => globalThis.__wasmerSyncFsCall(asyncId, 'metadata', ['/']), /must be synchronous/);
assert.throws(() => globalThis.__wasmerSyncFsCall(asyncId, 'metadata', ['/']), /bridge failed/);
unregisterSyncFileSystems([asyncId]);
console.log(
  'PASS: worker RPC, binary bytes, errno, IO bounds, path validation, leaked close, cancellation and thenable failure',
);

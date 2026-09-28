const bridgeUrl = new URL('file://' + process.env.WASMER_SDK_DIR + '/js/dist/sync-fs.js').href;
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
await Promise.all(
  ['pending', 'running'].map(async (mode) => {
    let response;
    let failed = false;
    const worker = new Worker(
      `
    const {parentPort,workerData}=require('node:worker_threads');
    const assert=require('node:assert/strict');
    globalThis.postMessage=data=>parentPort.postMessage(data);
    import(${JSON.stringify(bridgeUrl)}).then(({installSyncFsWorker})=>{
      installSyncFsWorker();
      const start=performance.now();
      assert.throws(()=>globalThis.__wasmerSyncFsCall(123,'metadata',['/']),{code:'ETIMEDOUT'});
      assert.ok(performance.now()-start >= 29000);
      if(workerData==='running') assert.throws(()=>globalThis.__wasmerSyncFsCall(123,'metadata',['/']),{code:'EIO'});
      parentPort.postMessage({done:true});
    });
  `,
      { eval: true, workerData: mode },
    );
    await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message) => {
        if (message.type === 'wasmer-fs-rpc') {
          response = message.response;
          if (mode === 'running') Atomics.compareExchange(new Int32Array(response), 0, 0, 1);
        } else if (message.type === 'wasmer-fs-failed') failed = true;
        else if (message.done) resolve();
      });
    });
    await worker.terminate();
    assert.equal(new Int32Array(response)[0], 3);
    assert.equal(failed, mode === 'running');
    console.log('PASS 30-second timeout:', mode);
  }),
);

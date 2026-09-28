import { SyncMessenger } from '../sync-messenger';

self.onmessage = ({ data }) => {
  const messenger = new SyncMessenger(data.sab);
  let calls = 0;
  // A buggy parser can otherwise flood the test runner while its watchdog fires.
  console.error = () => {};
  self.postMessage('ready');
  messenger.listen(async (type, payload) => ({ result: { calls: ++calls, type, payload } }), {
    blocking: data.blocking,
  });
};

import { startVfsSharedWorker } from '../shared-worker';
import { changesTransportPlugin } from './changes-transport-plugin';

const control = new BroadcastChannel('opfs-vfs-shared-worker-test-control');
const NativeMessageChannel = MessageChannel;
let holdClose = false;
const held: (() => void)[] = [];

class DelayedCloseMessageChannel extends NativeMessageChannel {
  constructor() {
    super();
    const send = this.port2.postMessage.bind(this.port2);
    const reply = this.port1.postMessage.bind(this.port1);
    let closing = false;
    this.port2.postMessage = ((message: unknown, options?: StructuredSerializeOptions) => {
      if (holdClose && (message as { type?: unknown })?.type === 'CLOSE_VFS') {
        closing = true;
        control.postMessage('close-requested');
      }
      return send(message, options);
    }) as typeof this.port2.postMessage;
    this.port1.postMessage = ((message: unknown, options?: StructuredSerializeOptions) => {
      if (closing && (message as { type?: unknown })?.type === 'CLOSE_VFS') {
        closing = false;
        control.postMessage('close-held');
        held.push(() => reply(message, options));
        return;
      }
      return reply(message, options);
    }) as typeof this.port1.postMessage;
  }
}

control.onmessage = ({ data }) => {
  if (data === 'hold-close') {
    holdClose = true;
    control.postMessage('close-hold-enabled');
  } else if (data === 'release-close') {
    holdClose = false;
    while (held.length) held.shift()!();
  }
};

globalThis.MessageChannel = DelayedCloseMessageChannel;
startVfsSharedWorker({ plugins: [changesTransportPlugin] });

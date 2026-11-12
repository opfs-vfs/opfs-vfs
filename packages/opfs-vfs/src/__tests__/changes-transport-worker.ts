import { startVfsWorker } from '../worker-runtime.js';
import { changesTransportPlugin } from './changes-transport-plugin.js';

startVfsWorker({ plugins: [changesTransportPlugin] });

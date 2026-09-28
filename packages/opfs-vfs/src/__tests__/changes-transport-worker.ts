import { startVfsWorker } from '../worker-runtime';
import { changesTransportPlugin } from './changes-transport-plugin';

startVfsWorker({ plugins: [changesTransportPlugin] });

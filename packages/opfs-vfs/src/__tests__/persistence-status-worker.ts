import { persistenceFaultPlugin } from './persistence-fault-plugin';
import { startVfsWorker } from '../worker-runtime';

startVfsWorker({ plugins: [persistenceFaultPlugin] });

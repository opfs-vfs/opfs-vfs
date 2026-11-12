import { persistenceFaultPlugin } from './persistence-fault-plugin.js';
import { startVfsWorker } from '../worker-runtime.js';

startVfsWorker({ plugins: [persistenceFaultPlugin] });

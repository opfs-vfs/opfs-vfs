import { startVfsWorker } from '../worker-runtime.js';
import { registryTestPlugin } from './registry-test-plugin.js';

startVfsWorker({ plugins: [registryTestPlugin] });

import { startVfsWorker } from '../worker-runtime';
import { registryTestPlugin } from './registry-test-plugin';

startVfsWorker({ plugins: [registryTestPlugin] });

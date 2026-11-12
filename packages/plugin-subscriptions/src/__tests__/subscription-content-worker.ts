import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '../index.js';

startVfsWorker({ plugins: [subscriptions] });

import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '../index';

startVfsWorker({ plugins: [subscriptions] });

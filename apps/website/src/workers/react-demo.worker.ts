import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsWorker({ plugins: [subscriptions] });

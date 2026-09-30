import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';

startVfsWorker({ plugins: [subscriptions] });

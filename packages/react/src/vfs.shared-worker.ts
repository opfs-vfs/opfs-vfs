import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { startVfsSharedWorker } from '@opfs-vfs/opfs-vfs/worker';

startVfsSharedWorker({ plugins: [subscriptions] });

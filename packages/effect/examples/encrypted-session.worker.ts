import { encryption } from '@opfs-vfs/plugin-encryption';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';

startVfsWorker({ plugins: [encryption, subscriptions] });

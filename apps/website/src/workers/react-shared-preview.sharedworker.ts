/// <reference lib="webworker" />

import { startVfsSharedWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

startVfsSharedWorker({ plugins: [subscriptions] });

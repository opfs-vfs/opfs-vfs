import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { persistenceFaultPlugin } from '../../../opfs-vfs/src/__tests__/persistence-fault-plugin.js';
import { testLock } from './test-lock-plugin.js';

startVfsWorker({ plugins: [subscriptions, testLock, persistenceFaultPlugin] });

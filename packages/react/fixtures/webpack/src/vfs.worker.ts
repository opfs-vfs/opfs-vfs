import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
setTimeout(
  () =>
    self.postMessage({
      artifact: {
        core: __OPFS_VFS_CORE_ARTIFACT__,
        subscriptions: __OPFS_VFS_SUBSCRIPTIONS_ARTIFACT__,
        react: __OPFS_VFS_REACT_ARTIFACT__,
      },
    }),
  0,
);
startVfsWorker({ plugins: [subscriptions] });

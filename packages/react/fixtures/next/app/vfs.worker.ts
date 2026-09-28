import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
setTimeout(
  () =>
    self.postMessage({
      artifact: {
        core: process.env.NEXT_PUBLIC_OPFS_VFS_CORE_ARTIFACT,
        subscriptions: process.env.NEXT_PUBLIC_OPFS_VFS_SUBSCRIPTIONS_ARTIFACT,
        react: process.env.NEXT_PUBLIC_OPFS_VFS_REACT_ARTIFACT,
      },
    }),
  0,
);
startVfsWorker({ plugins: [subscriptions] });

import { startVfsWorker } from '@opfs-vfs/opfs-vfs/worker-runtime';
import type { LogicalChangeSession } from '@opfs-vfs/opfs-vfs/changes';
import type { ConfiguredVfsPlugin } from '@opfs-vfs/opfs-vfs/plugins';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';

let session: LogicalChangeSession | undefined;

function configure(input: unknown): ConfiguredVfsPlugin {
  const configured = subscriptions.configure(input);
  const logicalChanges = configured.logicalChanges!;
  return {
    id: configured.id,
    contractVersion: configured.contractVersion,
    compatibilityKey: configured.compatibilityKey,
    ...(configured.requiredOpenMode === undefined ? {} : { requiredOpenMode: configured.requiredOpenMode }),
    logicalChanges: {
      version: 1,
      create(host) {
        return (session = logicalChanges.create(host));
      },
    },
  };
}

const testSubscriptions = Object.assign((input: Record<string, never> = {}) => configure(input), {
  id: 'subscriptions' as const,
  configure,
});

self.addEventListener('message', ({ data }: MessageEvent<{ type?: string }>) => {
  if (data.type === 'INVALIDATE') session?.invalidated({ kind: 'all' }, 'partial-mutation');
});

startVfsWorker({ plugins: [testSubscriptions] });

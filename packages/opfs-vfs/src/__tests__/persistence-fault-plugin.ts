import type { ConfiguredVfsPlugin, VfsPluginFactory, VfsPluginRequest } from '../plugins';

const id = 'persistence-fault';
const compatibilityKey = 'persistence-fault-v1';

function validate(options: unknown): Record<string, never> {
  if (typeof options !== 'object' || options === null || Array.isArray(options) || Object.keys(options).length !== 0)
    throw new Error('Invalid persistence fault plugin options');
  return {};
}

export function persistenceFaultRequest(): VfsPluginRequest<Record<string, never>> {
  return { id, contractVersion: 1, compatibilityKey, options: {} };
}

function configure(options: unknown): ConfiguredVfsPlugin {
  validate(options);
  return {
    id,
    contractVersion: 1,
    compatibilityKey,
    storage: {
      sidecars: [],
      factory: async ({ data, fileName }) => {
        const channel = new BroadcastChannel(`persistence-fault-${fileName}`);
        let failures = 0;
        channel.onmessage = (event) => {
          if (event.data?.type === 'fail' && Number.isSafeInteger(event.data.count) && event.data.count >= 0) {
            failures = event.data.count;
            channel.postMessage({ type: 'armed' });
          }
          if (event.data?.type === 'pagehide-twice') {
            failures = 1;
            self.dispatchEvent(new Event('pagehide'));
            self.dispatchEvent(new Event('pagehide'));
            channel.postMessage({ type: 'dispatched' });
          }
        };
        return {
          data,
          beforeDataCommit() {
            if (failures-- > 0) throw Object.assign(new Error('Injected commit failure'), { code: 'EIO' });
          },
          destroy() {
            channel.close();
          },
        };
      },
    },
  };
}

export const persistenceFaultPlugin = Object.assign((options: Record<string, never>) => configure(options), {
  id,
  configure,
}) satisfies VfsPluginFactory<Record<string, never>>;

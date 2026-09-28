import { startVfsWorker } from '../worker-runtime';
import type { ConfiguredVfsPlugin, VfsPluginRegistration } from '../plugins';

const contribution = {
  version: 1 as const,
  create() {
    return {
      control() {
        return { type: 'ok' as const };
      },
      completed() {},
      invalidated() {},
      clientClosed() {},
      close() {},
    };
  },
};
let configured = 0;
let freshSessions = 0;
const registration: VfsPluginRegistration = {
  id: 'logical-reuse',
  configure(options): ConfiguredVfsPlugin {
    if ((options as { readonly fresh?: unknown })?.fresh === true) {
      const session = ++freshSessions;
      return {
        id: 'logical-reuse',
        contractVersion: 1,
        compatibilityKey: 'logical-reuse',
        logicalChanges: {
          version: 1,
          create() {
            return {
              control() {
                return { type: 'ok' as const };
              },
              completed() {},
              invalidated() {},
              clientClosed() {},
              close(reason) {
                self.postMessage({ type: 'SESSION_CLOSE', session, reason });
              },
            };
          },
        },
      };
    }
    if (++configured > 1)
      contribution.create = () => ({
        control() {
          return { type: 'ok' as const };
        },
        completed() {},
        invalidated() {},
        clientClosed() {},
        close() {},
      });
    return { id: 'logical-reuse', contractVersion: 1, compatibilityKey: 'logical-reuse', logicalChanges: contribution };
  },
};

startVfsWorker({ plugins: [registration] });

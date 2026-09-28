import type { ChangeCommand, ChangeClient, ChangeFrame, LogicalChangeHost, LogicalChangeSession } from '../changes';
import type { ConfiguredVfsPlugin } from '../plugins';

export interface ChangePluginState {
  creates: number;
  closes: string[];
  controls: ChangeCommand[];
  receiverVersion?: number;
  host?: LogicalChangeHost;
  client?: ChangeClient;
  throwControl?: boolean;
  throwControlCode?: string;
  throwClose?: boolean;
  badReply?: boolean;
  asyncReply?: boolean;
}

export function changeTestPlugin(state: ChangePluginState): ConfiguredVfsPlugin {
  return {
    id: 'test-changes',
    contractVersion: 1,
    compatibilityKey: 'test-changes-v1',
    logicalChanges: {
      version: 1,
      create(host) {
        state.creates++;
        state.receiverVersion = this.version;
        state.host = host;
        const session: LogicalChangeSession = {
          control(client: ChangeClient, command: ChangeCommand) {
            state.client = client;
            state.controls.push(command);
            if (state.throwControl) {
              const error = new Error('unexpected contribution failure') as Error & { code?: string };
              error.code = state.throwControlCode;
              throw error;
            }
            if (state.asyncReply) return Promise.reject(new Error('async reply')) as never;
            if (state.badReply) return { type: 'ok', extra: true } as never;
            if (command.type === 'register') {
              host.validateTarget(command.options);
              return { type: 'registered', subscriptionId: command.subscriptionId };
            }
            return { type: 'ok' };
          },
          completed() {},
          invalidated() {},
          clientClosed() {},
          close(reason) {
            state.closes.push(reason);
            if (state.throwClose) throw new Error('change close failed');
          },
        };
        return session;
      },
    },
  };
}

export const eventFrame = (subscriptionId: string): ChangeFrame => ({
  type: 'closed',
  subscriptionId,
});

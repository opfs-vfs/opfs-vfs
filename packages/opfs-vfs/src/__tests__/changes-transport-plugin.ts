import type {
  ChangeClient,
  LogicalChangeHost,
  LogicalChangeSession,
  LogicalRecord,
  WireSubscribeOptions,
} from '../changes';
import type { ConfiguredVfsPlugin, VfsPluginFactory, VfsPluginRequest } from '../plugins';

type Subscription = {
  readonly client: ChangeClient;
  readonly id: string;
  readonly path: string;
  readonly recursive: boolean;
  readonly content: WireSubscribeOptions['content'];
  active: boolean;
  deliveryId: number;
  retiring: boolean;
};

const key = (client: ChangeClient, id: string) => `${client.clientId}:${client.channelId}:${id}`;

function matches(subscription: Subscription, record: LogicalRecord) {
  return (
    record.path === subscription.path ||
    (subscription.recursive && (subscription.path === '/' || record.path.startsWith(`${subscription.path}/`)))
  );
}

type TestOptions = { recordingProbe?: string };

function record(recordingProbe: string | undefined, type: string) {
  if (!recordingProbe) return;
  const channel = new BroadcastChannel(recordingProbe);
  channel.postMessage(type);
  channel.close();
}

function configured({ recordingProbe }: TestOptions = {}): ConfiguredVfsPlugin {
  return {
    id: 'changes-transport-test',
    contractVersion: 1,
    compatibilityKey: 'changes-transport-test-v1',
    logicalChanges: {
      version: 1,
      create(host: LogicalChangeHost): LogicalChangeSession {
        const subscriptions = new Map<string, Subscription>();
        let recordingCount = 0;
        let closedClients = 0;
        return {
          control(client, command) {
            const subscriptionKey = key(client, command.subscriptionId);
            if (command.type === 'register') {
              const expectedRoute = command.subscriptionId.startsWith('local-') ? 'local' : 'follower-relay';
              if (client.route !== expectedRoute) throw new Error('Unexpected transport route');
              if (
                command.subscriptionId === 'local-error-detail' ||
                command.subscriptionId === 'follower-error-detail'
              ) {
                throw Object.assign(new Error('Rejected /private/path by /secret.*/'), { code: 'EINVAL' });
              }
              const recordingProbe = /^local-recording-probe-(\d+)$/.exec(command.subscriptionId);
              if (recordingProbe && recordingCount !== Number(recordingProbe[1]))
                throw Object.assign(new Error(`Expected ${recordingProbe[1]} recordings, got ${recordingCount}`), {
                  code: 'EINVAL',
                });
              host.validateTarget(command.options);
              subscriptions.set(subscriptionKey, {
                client,
                id: command.subscriptionId,
                path: command.options.path,
                recursive: command.options.recursive,
                content: command.options.content,
                active: false,
                deliveryId: 0,
                retiring: false,
              });
              return { type: 'registered', subscriptionId: command.subscriptionId };
            }
            const subscription = subscriptions.get(subscriptionKey);
            if (!subscription) return { type: 'ok' };
            if (command.type === 'activate') subscription.active = true;
            if (command.type === 'cancel') {
              subscriptions.delete(subscriptionKey);
              host.send(client, { type: 'closed', subscriptionId: command.subscriptionId });
            }
            if (command.type === 'terminal-ack' && subscription.retiring) {
              subscriptions.delete(subscriptionKey);
              host.send(client, { type: 'closed', subscriptionId: command.subscriptionId });
            }
            return { type: 'ok' };
          },
          completed(operation) {
            recordingCount++;
            record(recordingProbe, 'completed');
            for (const record of operation.records) {
              for (const subscription of subscriptions.values()) {
                if (!subscription.active || subscription.retiring || !matches(subscription, record)) continue;
                if (record.path === '/terminal') {
                  subscription.retiring = true;
                  host.send(subscription.client, {
                    type: 'terminal',
                    subscriptionId: subscription.id,
                    code: 'SUBSCRIPTION_OVERFLOW',
                  });
                  continue;
                }
                const captured =
                  subscription.content === false
                    ? { status: 'omitted' as const, reason: 'disabled' as const }
                    : operation.capture(record, subscription.content.maxBytes);
                const borrowed = captured.status === 'included' ? captured.bytes : undefined;
                let content =
                  captured.status === 'included'
                    ? { status: 'included' as const, bytes: captured.bytes.slice() }
                    : captured;
                if (captured.status === 'included' && subscription.id.endsWith('borrowed-buffer'))
                  content = { status: 'included', bytes: captured.bytes as Uint8Array<ArrayBuffer> };
                if (content.status === 'included' && subscription.id.endsWith('invalid-buffer-subarray'))
                  content = { status: 'included', bytes: content.bytes.subarray(1) };
                if (content.status === 'included' && subscription.id.endsWith('invalid-buffer-sab')) {
                  const bytes = new Uint8Array(new SharedArrayBuffer(content.bytes.byteLength));
                  bytes.set(content.bytes);
                  content = { status: 'included', bytes: bytes as unknown as Uint8Array<ArrayBuffer> };
                }
                if (content.status === 'included' && subscription.id.endsWith('invalid-buffer-detached'))
                  structuredClone(content.bytes, { transfer: [content.bytes.buffer] });
                if (subscription.id.includes('post-failure')) {
                  const post = self.postMessage;
                  let failures = subscription.id.endsWith('post-failure-both') ? 2 : 1;
                  self.postMessage = ((message: { type?: unknown }, options?: StructuredSerializeOptions) => {
                    if (
                      failures > 0 &&
                      (message.type === 'FILE_CHANGES_FRAME' || message.type === 'FILE_CHANGES_INTERRUPTED')
                    ) {
                      failures--;
                      if (failures === 0) self.postMessage = post;
                      throw new Error('injected post failure');
                    }
                    post.call(self, message, options);
                  }) as typeof self.postMessage;
                }
                const frame = {
                  type: 'event',
                  subscriptionId: subscription.id,
                  deliveryId: ++subscription.deliveryId,
                  change: {
                    type: record.type,
                    path: record.path,
                    kind: record.kind,
                    cursor: record.cursor,
                    content,
                  },
                } as const;
                host.send(subscription.client, frame);
                if (subscription.id.endsWith('reused-buffer')) host.send(subscription.client, frame);
                if (borrowed && content.status === 'included' && subscription.id.includes('ownership-probe')) {
                  const delivery = content.bytes;
                  const expected = borrowed.slice();
                  queueMicrotask(() => {
                    const intact =
                      borrowed.byteLength === expected.byteLength && borrowed.every((byte, i) => byte === expected[i]);
                    const detached = delivery.byteLength === 0 && delivery.buffer.byteLength === 0;
                    const direct = subscription.id.includes('direct-ownership-probe');
                    host.send(subscription.client, {
                      type: 'event',
                      subscriptionId: subscription.id,
                      deliveryId: ++subscription.deliveryId,
                      change: {
                        type: record.type,
                        path: `/.${direct ? 'direct-' : ''}ownership-probe-${(direct ? intact : detached && intact) ? 'ok' : 'broken'}-${subscription.id}`,
                        kind: record.kind,
                        cursor: record.cursor,
                        content: { status: 'omitted', reason: 'disabled' },
                      },
                    });
                  });
                }
                if (subscription.id === 'local-cleanup-probe') {
                  queueMicrotask(() => {
                    host.send(subscription.client, {
                      type: 'event',
                      subscriptionId: subscription.id,
                      deliveryId: ++subscription.deliveryId,
                      change: {
                        type: record.type,
                        path: `/.post-cleanup-client-closed-${closedClients}`,
                        kind: record.kind,
                        cursor: record.cursor,
                        content: { status: 'omitted', reason: 'disabled' },
                      },
                    });
                  });
                }
              }
            }
          },
          invalidated() {
            recordingCount++;
            record(recordingProbe, 'invalidated');
          },
          clientClosed(client) {
            closedClients++;
            for (const [subscriptionKey, subscription] of subscriptions) {
              if (
                subscription.client.clientId === client.clientId &&
                subscription.client.channelId === client.channelId
              )
                subscriptions.delete(subscriptionKey);
            }
          },
          close() {},
        };
      },
    },
  };
}

export function changesTransportRequest(options: TestOptions = {}): VfsPluginRequest<TestOptions> {
  return {
    id: 'changes-transport-test',
    contractVersion: 1,
    compatibilityKey: 'changes-transport-test-v1',
    options,
  };
}

export const changesTransportPlugin = Object.assign((options: TestOptions) => configured(options), {
  id: 'changes-transport-test' as const,
  configure: (options: unknown) => configured(options as TestOptions),
}) satisfies VfsPluginFactory<Record<string, never>>;

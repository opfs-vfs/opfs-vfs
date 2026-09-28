import type {
  ChangeClient,
  ChangeCommand,
  ChangeFrame,
  ChangeImpact,
  CompletedLogicalOperation,
  LogicalChangeHost,
  LogicalChangeSession,
  WireSubscribeOptions,
} from '@opfs-vfs/opfs-vfs/changes';
import type { ConfiguredVfsPlugin } from '@opfs-vfs/opfs-vfs/plugins';
import { SUBSCRIPTIONS_COMPATIBILITY_KEY } from './config';
import { error, normalizePath } from './validation';

const MAX_PENDING = 4096;
const MAX_MOUNT_PENDING = 16384;
const MAX_METADATA = 16 * 1024 * 1024;
const MAX_CLIENTS = 32;
const MAX_MOUNT_CLIENTS = 128;
const MAX_SUBSCRIPTION_CONTENT = 32 * 1024 * 1024;
const MAX_MOUNT_CONTENT = 192 * 1024 * 1024;

type EventFrame = Extract<ChangeFrame, { type: 'event' }>;
type ContentUse = { size: number; charge: number };
type Delivery = { frame: EventFrame; content?: ContentUse };

type Subscription = {
  readonly key: string;
  readonly client: ChangeClient;
  readonly id: string;
  readonly options: WireSubscribeOptions;
  readonly path: string;
  readonly prefix: string;
  readonly eventMask: number;
  readonly regex?: RegExp;
  readonly charge: number;
  state: 'held' | 'active' | 'retiring';
  nextDeliveryId: number;
  pending: Delivery[];
  inflight?: Delivery;
  contentBytes: number;
};

const clientKey = (client: ChangeClient) => `${client.clientId}\u0000${client.channelId}`;
const subscriptionKey = (client: ChangeClient, id: string) => `${clientKey(client)}\u0000${id}`;
/** TextEncoder byte length without allocating a second copy of an untrusted string. */
function charge(path: string, base: number): number {
  let bytes = base;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < path.length && (path.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
const eventCharge = (id: string, path: string) => charge(path, 256) + charge(id, 0);
const eventBit = (type: string) => (type === 'create' ? 1 : type === 'update' ? 2 : type === 'delete' ? 4 : 0);
const childOf = (entry: Subscription, path: string) =>
  path.startsWith(entry.prefix) && path.indexOf('/', entry.prefix.length) < 0;
const inside = (entry: Subscription, path: string) => path.startsWith(entry.prefix);

function validateWire(input: unknown): WireSubscribeOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw error('EINVAL', 'Invalid subscription options');
  const value = input as Record<string, unknown>;
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !['path', 'scope', 'recursive', 'events', 'match', 'content'].includes(key),
    )
  )
    throw error('EINVAL', 'Invalid subscription options');
  if (typeof value.path !== 'string' || value.path.includes('\0')) throw error('EINVAL', 'Invalid path');
  if ((value.scope !== 'file' && value.scope !== 'directory') || typeof value.recursive !== 'boolean')
    throw error('EINVAL', 'Invalid scope');
  if (value.scope === 'file' && value.recursive) throw error('EINVAL', 'File subscriptions cannot be recursive');
  const supplied = Array.isArray(value.events) ? Array.from(value.events) : undefined;
  if (
    !supplied ||
    !supplied.length ||
    supplied.some((event) => event !== 'create' && event !== 'update' && event !== 'delete')
  )
    throw error('EINVAL', 'Invalid events');
  let match: WireSubscribeOptions['match'];
  if (value.match !== undefined) {
    const candidate = value.match as Record<string, unknown>;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Reflect.ownKeys(candidate).length !== 2 ||
      !Reflect.ownKeys(candidate).includes('source') ||
      !Reflect.ownKeys(candidate).includes('flags') ||
      typeof candidate.source !== 'string' ||
      typeof candidate.flags !== 'string'
    )
      throw error('EINVAL', 'Invalid match expression');
    match = { source: candidate.source, flags: candidate.flags };
  }
  if (value.content !== false) {
    const maxBytes = (value.content as { maxBytes?: unknown })?.maxBytes;
    if (
      !value.content ||
      typeof value.content !== 'object' ||
      Array.isArray(value.content) ||
      Reflect.ownKeys(value.content as object).length !== 1 ||
      !Reflect.ownKeys(value.content as object).includes('maxBytes') ||
      typeof maxBytes !== 'number' ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > 16 * 1024 * 1024
    )
      throw error('EINVAL', 'Invalid content options');
    return {
      path: value.path,
      scope: value.scope,
      recursive: value.recursive,
      events: [...new Set(supplied)] as WireSubscribeOptions['events'],
      match,
      content: { maxBytes },
    };
  }
  return {
    path: value.path,
    scope: value.scope,
    recursive: value.recursive,
    events: [...new Set(supplied)] as WireSubscribeOptions['events'],
    match,
    content: false,
  };
}

/** Premium owner ledger. Core owns transport admission; this owns retained events and content. */
export function subscriptions(): ConfiguredVfsPlugin {
  return {
    id: 'subscriptions',
    contractVersion: 1,
    compatibilityKey: SUBSCRIPTIONS_COMPATIBILITY_KEY,
    logicalChanges: {
      version: 1,
      create(host: LogicalChangeHost): LogicalChangeSession {
        const entries = new Map<string, Subscription>();
        let pending = 0;
        let metadata = 0;
        let mountContentBytes = 0;
        const countFor = (client: ChangeClient) =>
          [...entries.values()].filter((entry) => entry.client.clientId === client.clientId).length;
        const releaseContent = (entry: Subscription, content: ContentUse | undefined) => {
          if (!content) return;
          entry.contentBytes -= content.size;
          mountContentBytes -= content.charge;
        };
        const releaseDelivery = (entry: Subscription, delivery: Delivery) => {
          pending--;
          metadata -= eventCharge(entry.id, delivery.frame.change.path);
          releaseContent(entry, delivery.content);
        };
        const discardPending = (entry: Subscription) => {
          for (const delivery of entry.pending) releaseDelivery(entry, delivery);
          entry.pending.length = 0;
        };
        const remove = (entry: Subscription) => {
          entries.delete(entry.key);
          discardPending(entry);
          if (entry.inflight) {
            releaseDelivery(entry, entry.inflight);
            entry.inflight = undefined;
          }
          metadata -= entry.charge;
        };
        const retire = (entry: Subscription, frame: ChangeFrame) => {
          if (entry.state === 'retiring') return;
          discardPending(entry);
          entry.state = 'retiring';
          host.send(entry.client, frame);
        };
        const send = (entry: Subscription) => {
          if (entry.state !== 'active' || entry.inflight !== undefined || !entry.pending.length) return;
          const delivery = entry.pending.shift()!;
          entry.inflight = delivery;
          host.send(entry.client, delivery.frame);
        };
        const matches = (entry: Subscription, path: string, type: string) => {
          if (!(entry.eventMask & eventBit(type))) return false;
          const pathMatches =
            entry.options.scope === 'file'
              ? path === entry.path
              : path === entry.path || (entry.options.recursive ? inside(entry, path) : childOf(entry, path));
          if (!pathMatches) return false;
          if (entry.regex) {
            entry.regex.lastIndex = 0;
            if (!entry.regex.test(path)) return false;
          }
          return true;
        };
        return {
          control(client, command: ChangeCommand) {
            const key = subscriptionKey(client, command.subscriptionId);
            if (command.type === 'register') {
              if (entries.has(key)) throw error('EINVAL', 'Subscription already registered');
              const options = validateWire(command.options);
              const registrationCharge =
                charge(options.path, 512) +
                charge(command.subscriptionId, 0) +
                charge(client.clientId, 0) +
                charge(client.channelId, 0) +
                (options.match ? charge(options.match.source, 0) + charge(options.match.flags, 0) : 0);
              if (
                entries.size >= MAX_MOUNT_CLIENTS ||
                countFor(client) >= MAX_CLIENTS ||
                metadata + registrationCharge > MAX_METADATA
              )
                throw error('ENOSPC', 'Subscription capacity exhausted');
              host.validateTarget(options);
              const path = normalizePath(options.path);
              let regex: RegExp | undefined;
              try {
                regex = options.match ? new RegExp(options.match.source, options.match.flags) : undefined;
              } catch {
                throw error('EINVAL', 'Invalid match expression');
              }
              const entry: Subscription = {
                key,
                client,
                id: command.subscriptionId,
                options,
                path,
                prefix: path === '/' ? '/' : `${path}/`,
                eventMask: options.events.reduce((mask, event) => mask | eventBit(event), 0),
                regex,
                charge: registrationCharge,
                state: 'held',
                nextDeliveryId: 1,
                pending: [],
                contentBytes: 0,
              };
              entries.set(key, entry);
              metadata += registrationCharge;
              return { type: 'registered', subscriptionId: entry.id };
            }
            const entry = entries.get(key);
            if (!entry) return { type: 'ok' };
            if (command.type === 'activate') {
              if (entry.state === 'held') entry.state = 'active';
              send(entry);
            } else if (command.type === 'ack') {
              if (entry.state === 'active' && entry.inflight?.frame.deliveryId === command.deliveryId) {
                const delivered = entry.inflight;
                entry.inflight = undefined;
                releaseDelivery(entry, delivered);
                send(entry);
              }
            } else if (command.type === 'cancel') {
              retire(entry, { type: 'closed', subscriptionId: entry.id });
            } else if (command.type === 'terminal-ack' && entry.state === 'retiring') {
              remove(entry);
            }
            return { type: 'ok' };
          },
          completed(operation: CompletedLogicalOperation) {
            if (!entries.size) return;
            const subscriptions = [...entries.values()];
            let captures: Map<number, Uint8Array> | undefined;
            try {
              for (const record of operation.records) {
                for (const entry of subscriptions) {
                  if (entry.state === 'retiring' || !matches(entry, record.path, record.type)) continue;
                  const recordCharge = eventCharge(entry.id, record.path);
                  if (
                    entry.pending.length + (entry.inflight === undefined ? 0 : 1) >= MAX_PENDING ||
                    pending >= MAX_MOUNT_PENDING ||
                    metadata + recordCharge > MAX_METADATA
                  ) {
                    retire(entry, { type: 'terminal', subscriptionId: entry.id, code: 'SUBSCRIPTION_OVERFLOW' });
                    continue;
                  }
                  let content: ContentUse | undefined;
                  let eventContent: EventFrame['change']['content'] = { status: 'omitted', reason: 'disabled' };
                  const requested = entry.options.content;
                  if (requested) {
                    if (record.type === 'delete') eventContent = { status: 'omitted', reason: 'deleted' };
                    else if (record.kind !== 'file') eventContent = { status: 'omitted', reason: 'not-file' };
                    else if (record.size > requested.maxBytes)
                      eventContent = { status: 'omitted', reason: 'too-large' };
                    else {
                      const size = record.size;
                      const existing = captures?.get(record.inodeId);
                      const relay = entry.client.route === 'follower-relay';
                      const contentCharge = size * (relay ? 2 : 1);
                      if (
                        entry.contentBytes + size > MAX_SUBSCRIPTION_CONTENT ||
                        mountContentBytes + (existing ? 0 : size) + contentCharge > MAX_MOUNT_CONTENT
                      ) {
                        retire(entry, { type: 'terminal', subscriptionId: entry.id, code: 'SUBSCRIPTION_OVERFLOW' });
                        continue;
                      }
                      const reservedSource = !existing;
                      entry.contentBytes += size;
                      mountContentBytes += contentCharge + (reservedSource ? size : 0);
                      const refundDelivery = () => {
                        entry.contentBytes -= size;
                        mountContentBytes -= contentCharge;
                      };
                      let captured: ReturnType<CompletedLogicalOperation['capture']>;
                      try {
                        captured = operation.capture(record, requested.maxBytes);
                      } catch {
                        captured = { status: 'omitted', reason: 'unavailable' };
                      }
                      if (captured.status !== 'included' || captured.bytes.byteLength !== size) {
                        refundDelivery();
                        if (reservedSource) mountContentBytes -= size;
                        eventContent = { status: 'omitted', reason: 'unavailable' };
                      } else {
                        let capture = existing;
                        if (!capture) {
                          capture = captured.bytes;
                          (captures ??= new Map()).set(record.inodeId, capture);
                        }
                        try {
                          const bytes = capture.slice();
                          content = { size, charge: contentCharge };
                          eventContent = { status: 'included', bytes };
                        } catch {
                          refundDelivery();
                          eventContent = { status: 'omitted', reason: 'unavailable' };
                        }
                      }
                    }
                  }
                  const frame: EventFrame = {
                    type: 'event',
                    subscriptionId: entry.id,
                    deliveryId: entry.nextDeliveryId++,
                    change: {
                      type: record.type,
                      path: record.path,
                      kind: record.kind,
                      cursor: record.cursor,
                      content: eventContent,
                    },
                  };
                  entry.pending.push({ frame, content });
                  pending++;
                  metadata += recordCharge;
                  send(entry);
                }
              }
            } finally {
              for (const capture of captures?.values() ?? []) mountContentBytes -= capture.byteLength;
              captures = undefined;
            }
          },
          invalidated(impact: ChangeImpact, reason) {
            const paths =
              impact.kind === 'paths'
                ? impact.paths.map(({ path, subtree }) => {
                    const region = normalizePath(path);
                    return { region, prefix: region === '/' ? '/' : `${region}/`, subtree };
                  })
                : [];
            for (const entry of [...entries.values()]) {
              const hit =
                impact.kind === 'all' ||
                paths.some(({ region, prefix, subtree }) => {
                  const couldMatch = (candidate: string) =>
                    entry.options.scope === 'file'
                      ? candidate === entry.path
                      : candidate === entry.path ||
                        (entry.options.recursive ? inside(entry, candidate) : childOf(entry, candidate));
                  return (
                    couldMatch(region) ||
                    (subtree &&
                      (entry.path === region ||
                        region === '/' ||
                        entry.path.startsWith(prefix) ||
                        (entry.options.scope === 'directory' && entry.options.recursive && inside(entry, region))))
                  );
                });
              if (hit)
                retire(entry, {
                  type: 'terminal',
                  subscriptionId: entry.id,
                  code: reason === 'record-limit' ? 'SUBSCRIPTION_OVERFLOW' : 'SUBSCRIPTION_RESYNC_REQUIRED',
                });
            }
          },
          clientClosed(client) {
            for (const entry of [...entries.values()])
              if (entry.client.clientId === client.clientId && entry.client.channelId === client.channelId)
                remove(entry);
          },
          close() {
            for (const entry of [...entries.values()]) {
              host.send(entry.client, { type: 'terminal', subscriptionId: entry.id, code: 'SUBSCRIPTION_INTERRUPTED' });
              remove(entry);
            }
          },
        };
      },
    },
  };
}

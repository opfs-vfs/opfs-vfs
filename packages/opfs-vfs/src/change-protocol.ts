import { createVfsError } from './fs-errors';
import type {
  ChangeCommand,
  ChangeFrame,
  ChangeReply,
  ChangeType,
  FileChange,
  TerminalCode,
  WireSubscribeOptions,
} from './changes';

const MAX_BYTES = 16 * 1024 * 1024;
const changeTypes = new Set<ChangeType>(['create', 'update', 'delete']);
const terminalCodes = new Set([
  'SUBSCRIPTION_OVERFLOW',
  'SUBSCRIPTION_INTERRUPTED',
  'SUBSCRIPTION_CALLBACK_FAILED',
  'SUBSCRIPTION_RESYNC_REQUIRED',
]);
const omittedReasons = new Set(['disabled', 'deleted', 'not-file', 'too-large', 'unavailable']);

const hasOnly = (value: object, fields: readonly string[], keys = Reflect.ownKeys(value)) => {
  return keys.length === fields.length && keys.every((key) => typeof key === 'string' && fields.includes(key));
};
const hasFields = (
  value: object,
  required: readonly string[],
  optional: readonly string[],
  keys = Reflect.ownKeys(value),
) => {
  return (
    required.every((field) => keys.includes(field)) &&
    keys.every((key) => typeof key === 'string' && [...required, ...optional].includes(key))
  );
};
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
const validPath = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');
export function utf8Charge(value: string, budget: number): number {
  if (budget < 0) return Infinity;
  let charge = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) charge++;
    else if (code <= 0x7ff) charge += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charge += 4;
        index++;
      } else charge += 3;
    } else charge += 3;
    if (charge > budget) return Infinity;
  }
  return charge;
}
const freeze = <T extends object>(value: T): T => Object.freeze(value);

export function snapshotChangeCommand(
  command: unknown,
  optionBudget: number,
): { readonly command: ChangeCommand; readonly charge: number } {
  if (!Number.isSafeInteger(optionBudget) || optionBudget < 0)
    throw createVfsError('EINVAL', undefined, 'Invalid file change command');
  let overBudget = false;
  try {
    if (!isPlainObject(command)) throw new Error();
    const commandKeys = Reflect.ownKeys(command);
    const type = command.type;
    const subscriptionId = command.subscriptionId;
    if (!validId(subscriptionId)) throw new Error();
    if (type === 'register' && hasOnly(command, ['type', 'subscriptionId', 'options'], commandKeys)) {
      const options = command.options;
      if (!isPlainObject(options)) throw new Error();
      const optionKeys = Reflect.ownKeys(options);
      if (!hasFields(options, ['path', 'scope', 'recursive', 'events', 'content'], ['match'], optionKeys))
        throw new Error();
      const path = options.path;
      const scope = options.scope;
      const recursive = options.recursive;
      const eventsInput = options.events;
      const matchInput = options.match;
      const contentInput = options.content;
      if (
        !validPath(path) ||
        (scope !== 'file' && scope !== 'directory') ||
        typeof recursive !== 'boolean' ||
        !Array.isArray(eventsInput)
      )
        throw new Error();
      const eventLength = eventsInput.length;
      if (!Number.isSafeInteger(eventLength) || eventLength < 1 || eventLength > 3) throw new Error();
      const events: ChangeType[] = [];
      for (let index = 0; index < eventLength; index++) events.push(eventsInput[index] as ChangeType);
      if (events.some((event) => !changeTypes.has(event)) || new Set(events).size !== events.length) throw new Error();
      let matchSource: string | undefined;
      let matchFlags: string | undefined;
      if (matchInput !== undefined) {
        if (!isPlainObject(matchInput)) throw new Error();
        const matchKeys = Reflect.ownKeys(matchInput);
        if (!hasOnly(matchInput, ['source', 'flags'], matchKeys)) throw new Error();
        const source = matchInput.source;
        const flags = matchInput.flags;
        if (typeof source !== 'string' || typeof flags !== 'string') throw new Error();
        matchSource = source;
        matchFlags = flags;
      }
      let contentMaxBytes: number | false;
      if (contentInput === false) contentMaxBytes = false;
      else {
        if (!isPlainObject(contentInput)) throw new Error();
        const contentKeys = Reflect.ownKeys(contentInput);
        if (!hasOnly(contentInput, ['maxBytes'], contentKeys)) throw new Error();
        const maxBytes = contentInput.maxBytes;
        if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES)
          throw new Error();
        contentMaxBytes = maxBytes;
      }
      let charge = 512 + utf8Charge(subscriptionId, optionBudget - 512);
      charge += utf8Charge(path, optionBudget - charge);
      if (matchSource !== undefined) {
        charge += utf8Charge(matchSource, optionBudget - charge);
        charge += utf8Charge(matchFlags!, optionBudget - charge);
      }
      if (charge > optionBudget) {
        overBudget = true;
      } else {
        const snapshot: WireSubscribeOptions = freeze({
          path,
          scope,
          recursive,
          events: freeze(events),
          ...(matchSource !== undefined ? { match: freeze({ source: matchSource, flags: matchFlags! }) } : {}),
          content: contentMaxBytes === false ? false : freeze({ maxBytes: contentMaxBytes }),
        });
        return { command: freeze({ type: 'register' as const, subscriptionId, options: snapshot }), charge };
      }
    }
    if (
      (type === 'activate' || type === 'cancel' || type === 'terminal-ack') &&
      hasOnly(command, ['type', 'subscriptionId'], commandKeys)
    )
      return {
        command: freeze({ type, subscriptionId }) as ChangeCommand,
        charge: 0,
      };
    if (type === 'ack' && hasOnly(command, ['type', 'subscriptionId', 'deliveryId'], commandKeys)) {
      const deliveryId = command.deliveryId;
      if (typeof deliveryId === 'number' && Number.isSafeInteger(deliveryId) && deliveryId > 0)
        return { command: freeze({ type, subscriptionId, deliveryId }), charge: 0 };
    }
  } catch {
    // Invalid input or a hostile Proxy.
  }
  if (overBudget) throw createVfsError('ENOSPC', undefined, 'File change command is too large');
  throw createVfsError('EINVAL', undefined, 'Invalid file change command');
}

export function isChangeReply(command: ChangeCommand, reply: unknown): reply is ChangeReply {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return false;
  const value = reply as Record<string, unknown>;
  return command.type === 'register'
    ? hasOnly(value, ['type', 'subscriptionId']) &&
        value.type === 'registered' &&
        value.subscriptionId === command.subscriptionId
    : hasOnly(value, ['type']) && value.type === 'ok';
}

export function snapshotChangeFrame(frame: unknown, expectedGeneration: string): ChangeFrame | undefined {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return undefined;
  const raw = frame as Record<string, unknown>;
  if (
    raw.type === 'terminal' &&
    hasOnly(raw, ['type', 'subscriptionId', 'code']) &&
    validId(raw.subscriptionId) &&
    typeof raw.code === 'string' &&
    terminalCodes.has(raw.code)
  )
    return freeze({
      type: 'terminal' as const,
      subscriptionId: raw.subscriptionId as string,
      code: raw.code as TerminalCode,
    });
  if (raw.type === 'closed' && hasOnly(raw, ['type', 'subscriptionId']) && validId(raw.subscriptionId))
    return freeze({ type: 'closed' as const, subscriptionId: raw.subscriptionId as string });
  if (
    raw.type !== 'event' ||
    !hasOnly(raw, ['type', 'subscriptionId', 'deliveryId', 'change']) ||
    !validId(raw.subscriptionId) ||
    !Number.isSafeInteger(raw.deliveryId) ||
    (raw.deliveryId as number) <= 0
  )
    return undefined;
  const change = raw.change;
  if (
    !change ||
    typeof change !== 'object' ||
    Array.isArray(change) ||
    !hasOnly(change, ['type', 'path', 'kind', 'cursor', 'content'])
  )
    return undefined;
  const value = change as Record<string, unknown>;
  if (
    !changeTypes.has(value.type as ChangeType) ||
    !validPath(value.path) ||
    (value.kind !== 'file' && value.kind !== 'directory' && value.kind !== 'symlink')
  )
    return undefined;
  const cursor = value.cursor;
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    !hasOnly(cursor, ['generation', 'sequence']) ||
    !validId((cursor as Record<string, unknown>).generation) ||
    (cursor as Record<string, unknown>).generation !== expectedGeneration ||
    !Number.isSafeInteger((cursor as Record<string, unknown>).sequence) ||
    ((cursor as Record<string, unknown>).sequence as number) <= 0
  )
    return undefined;
  const content = value.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const contentValue = content as Record<string, unknown>;
  let snapshotContent: FileChange['content'];
  if (
    contentValue.status === 'included' &&
    hasOnly(contentValue, ['status', 'bytes']) &&
    contentValue.bytes instanceof Uint8Array &&
    contentValue.bytes.byteLength <= MAX_BYTES
  )
    snapshotContent = freeze({ status: 'included', bytes: contentValue.bytes });
  else if (
    contentValue.status === 'omitted' &&
    hasOnly(contentValue, ['status', 'reason']) &&
    typeof contentValue.reason === 'string' &&
    omittedReasons.has(contentValue.reason)
  )
    snapshotContent = freeze({
      status: 'omitted',
      reason: contentValue.reason as Extract<FileChange['content'], { status: 'omitted' }>['reason'],
    });
  else return undefined;
  return freeze({
    type: 'event' as const,
    subscriptionId: raw.subscriptionId as string,
    deliveryId: raw.deliveryId as number,
    change: freeze({
      type: value.type as ChangeType,
      path: value.path as string,
      kind: value.kind as FileChange['kind'],
      cursor: freeze({
        generation: (cursor as { generation: string }).generation,
        sequence: (cursor as { sequence: number }).sequence,
      }),
      content: snapshotContent,
    }),
  });
}

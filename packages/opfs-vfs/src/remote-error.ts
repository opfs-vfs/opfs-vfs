import type { VfsCorruptionCategory } from './fs-errors';

/** Bounded, validated error fields that may cross a worker, relay, status or SAB boundary. */
export interface RemoteErrorDetails {
  readonly message: string;
  readonly name?: string;
  readonly code?: string;
  readonly errno?: number;
  readonly category?: VfsCorruptionCategory;
  readonly offset?: number;
}

type RemoteErrorWire = { error: string } & Omit<RemoteErrorDetails, 'message'>;

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CATEGORIES = new Set<VfsCorruptionCategory>([
  'meta-snapshot',
  'data-wal',
  'bitmap',
  'meta-log',
  'format-version',
]);

function truncateMessage(message: string) {
  if (message.length <= 1024) return message;
  let end = 1023;
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${message.slice(0, end)}…`;
}

function read(error: object, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function messageFor(error: unknown, object: object | null) {
  const message = object ? read(object, 'message') : undefined;
  if (typeof message === 'string') return truncateMessage(message);
  try {
    return truncateMessage(String(error));
  } catch {
    return 'Unknown VFS error';
  }
}

export function toRemoteErrorDetails(error: unknown): RemoteErrorDetails {
  const object = error !== null && typeof error === 'object' ? error : null;
  const message = messageFor(error, object);
  const name = object ? read(object, 'name') : undefined;
  const code = object ? read(object, 'code') : undefined;
  const errno = object ? read(object, 'errno') : undefined;
  const category = object ? read(object, 'category') : undefined;
  const offset = object ? read(object, 'offset') : undefined;
  return Object.freeze({
    message,
    // The generic name adds nothing and keeps plain errors in the legacy { error, code } shape.
    ...(typeof name === 'string' && name !== 'Error' && NAME.test(name) ? { name } : {}),
    ...(typeof code === 'string' && CODE.test(code) ? { code } : {}),
    ...(typeof errno === 'number' && Number.isSafeInteger(errno) ? { errno } : {}),
    ...(typeof category === 'string' && CATEGORIES.has(category as VfsCorruptionCategory)
      ? { category: category as VfsCorruptionCategory }
      : {}),
    ...(typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}),
  });
}

export function serializeRemoteError(error: unknown): RemoteErrorWire {
  const { message, ...details } = toRemoteErrorDetails(error);
  return { error: message, ...details };
}

export function parseRemoteError(value: unknown): RemoteErrorDetails | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const allowed = new Set(['error', 'name', 'code', 'errno', 'category', 'offset']);
  if (!keys.every((key) => typeof key === 'string' && allowed.has(key)) || !keys.includes('error')) return null;
  const wire = value as Record<string, unknown>;
  let error: unknown;
  let name: unknown;
  let code: unknown;
  let errno: unknown;
  let category: unknown;
  let offset: unknown;
  const hasName = keys.includes('name');
  const hasCode = keys.includes('code');
  const hasErrno = keys.includes('errno');
  const hasCategory = keys.includes('category');
  const hasOffset = keys.includes('offset');
  try {
    error = wire.error;
    if (hasName) name = wire.name;
    if (hasCode) code = wire.code;
    if (hasErrno) errno = wire.errno;
    if (hasCategory) category = wire.category;
    if (hasOffset) offset = wire.offset;
  } catch {
    return null;
  }
  if (
    typeof error !== 'string' ||
    error.length > 1024 ||
    (hasName && (typeof name !== 'string' || !NAME.test(name))) ||
    (hasCode && (typeof code !== 'string' || !CODE.test(code))) ||
    (hasErrno && (typeof errno !== 'number' || !Number.isSafeInteger(errno))) ||
    (hasCategory && (typeof category !== 'string' || !CATEGORIES.has(category as VfsCorruptionCategory))) ||
    (hasOffset && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0))
  )
    return null;
  return Object.freeze({
    message: error,
    ...(hasName ? { name: name as string } : {}),
    ...(hasCode ? { code: code as string } : {}),
    ...(hasErrno ? { errno: errno as number } : {}),
    ...(hasCategory ? { category: category as VfsCorruptionCategory } : {}),
    ...(hasOffset ? { offset: offset as number } : {}),
  });
}

export function reviveRemoteError(details: RemoteErrorDetails): Error {
  const { message, name, ...fields } = details;
  const error = Object.assign(new Error(message), fields);
  if (name !== undefined) error.name = name;
  return error;
}

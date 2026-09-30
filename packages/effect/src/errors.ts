import { Schema } from 'effect';
import type { VfsCorruptionCategory } from '@opfs-vfs/opfs-vfs';

const categories = ['meta-snapshot', 'data-wal', 'bitmap', 'meta-log', 'format-version'] as const;

export const RemoteErrorDetails = Schema.Struct({
  message: Schema.String,
  name: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  errno: Schema.optionalKey(Schema.Number),
  category: Schema.optionalKey(Schema.Literals(categories)),
  offset: Schema.optionalKey(Schema.Number),
});
export interface RemoteErrorDetails extends Schema.Schema.Type<typeof RemoteErrorDetails> {}

export type ErrorOutcome = 'not-applied' | 'possibly-applied' | 'unknown';
export type VolumeErrorKind =
  | 'configuration'
  | 'unsupported'
  | 'filesystem'
  | 'conflict'
  | 'quota'
  | 'corruption'
  | 'encryption'
  | 'lifecycle'
  | 'subscription'
  | 'persistence'
  | 'unknown';

const contextFields = {
  fileName: Schema.NullOr(Schema.String),
  operation: Schema.String,
  path: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  outcome: Schema.Literals(['not-applied', 'possibly-applied', 'unknown']),
  details: Schema.NullOr(RemoteErrorDetails),
  cause: Schema.optionalKey(Schema.Defect()),
};

export class VolumeError extends Schema.TaggedError<VolumeError>()('VolumeError', {
  kind: Schema.Literals([
    'configuration',
    'unsupported',
    'filesystem',
    'conflict',
    'quota',
    'corruption',
    'encryption',
    'lifecycle',
    'subscription',
    'persistence',
    'unknown',
  ]),
  ...contextFields,
}) {}

export class EncryptionError extends Schema.TaggedError<EncryptionError>()('EncryptionError', {
  reason: Schema.Literals([
    'CredentialsRejected',
    'KeyDerivationFailed',
    'VaultCorrupt',
    'UnsupportedFormat',
    'SidecarCorrupt',
    'IntegrityFailure',
    'PlaintextVolume',
  ]),
  ...contextFields,
}) {}

export type SubscriptionErrorCode =
  | 'SUBSCRIPTION_OVERFLOW'
  | 'SUBSCRIPTION_INTERRUPTED'
  | 'SUBSCRIPTION_CALLBACK_FAILED'
  | 'SUBSCRIPTION_RESYNC_REQUIRED'
  | 'SUBSCRIPTION_RETIREMENT_UNKNOWN'
  | 'SUBSCRIPTION_SETUP_FAILED'
  | 'EINVAL'
  | 'EBADF';

export class SubscriptionError extends Schema.TaggedError<SubscriptionError>()('SubscriptionError', {
  code: Schema.Literals([
    'SUBSCRIPTION_OVERFLOW',
    'SUBSCRIPTION_INTERRUPTED',
    'SUBSCRIPTION_CALLBACK_FAILED',
    'SUBSCRIPTION_RESYNC_REQUIRED',
    'SUBSCRIPTION_RETIREMENT_UNKNOWN',
    'SUBSCRIPTION_SETUP_FAILED',
    'EINVAL',
    'EBADF',
  ]),
  fileName: Schema.String,
  path: Schema.String,
  sourceCode: Schema.optionalKey(Schema.String),
  details: Schema.NullOr(RemoteErrorDetails),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const MountError = Schema.Union([VolumeError, EncryptionError]);
export type MountError = typeof MountError.Type;

const read = (value: object, key: string): unknown => {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

export const remoteDetails = (error: unknown): RemoteErrorDetails => {
  const object = error !== null && (typeof error === 'object' || typeof error === 'function') ? error : null;
  const rawMessage = object ? read(object, 'message') : undefined;
  const truncate = (value: string) => {
    if (value.length <= 1024) return value;
    let end = 1023;
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return `${value.slice(0, end)}…`;
  };
  let message: string;
  if (typeof rawMessage === 'string') message = truncate(rawMessage);
  else {
    try {
      message = truncate(String(error));
    } catch {
      message = 'Unknown VFS error';
    }
  }
  const name = object ? read(object, 'name') : undefined;
  const code = object ? read(object, 'code') : undefined;
  const errno = object ? read(object, 'errno') : undefined;
  const category = object ? read(object, 'category') : undefined;
  const offset = object ? read(object, 'offset') : undefined;
  return {
    message,
    ...(typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && name !== 'Error' ? { name } : {}),
    ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
    ...(typeof errno === 'number' && Number.isSafeInteger(errno) ? { errno } : {}),
    ...(typeof category === 'string' && categories.includes(category as VfsCorruptionCategory)
      ? { category: category as VfsCorruptionCategory }
      : {}),
    ...(typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}),
  };
};

const lifecycleCodes = new Set([
  'VFS_SHUTTING_DOWN',
  'VFS_ATTACHMENT_LOST',
  'VFS_PROTOCOL_MISMATCH',
  'VFS_PLUGIN_MISMATCH',
  'VFS_NOT_LEADER',
  'VFS_LEADER_NOT_READY',
  'VFS_WORKER_FAILED',
  'VFS_INITIALIZATION_TIMEOUT',
  'VFS_OWNER_READY_TIMEOUT',
  'LEADER_RESPONSE_TIMEOUT',
  'VOLUME_IMPORTING',
]);
const encryptionReasons: Partial<Record<string, EncryptionError['reason']>> = {
  EVOLUMELOCKED: 'CredentialsRejected',
  EKDF: 'KeyDerivationFailed',
  EVAULTCORRUPT: 'VaultCorrupt',
  EVAULTFORMAT: 'UnsupportedFormat',
  ECRYPTSIDECAR: 'SidecarCorrupt',
  ECRYPTOINTEGRITY: 'IntegrityFailure',
  EPLAINTEXTVOLUME: 'PlaintextVolume',
};

export const classify = (details: RemoteErrorDetails): VolumeErrorKind => {
  const { code, category, name } = details;
  if (category || ['VfsCorruptionError', 'MetaSnapshotCorruptionError', 'DataWalCorruptionError'].includes(name ?? ''))
    return 'corruption';
  if (code && encryptionReasons[code]) return 'encryption';
  if (code === 'VFS_STORAGE_PLUGIN_REQUIRED') return 'unsupported';
  if (code === 'VFS_SYNC_OWNER_CHANGED' || code === 'VFS_ACK_OWNER_CHANGED') return 'persistence';
  if (code === 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT') return 'subscription';
  if (code && lifecycleCodes.has(code)) return 'lifecycle';
  if (code?.startsWith('SUBSCRIPTION_')) return 'subscription';
  if (code === 'ENOSPC' || name === 'QuotaExceededError') return 'quota';
  if (code === 'EEXIST') return 'conflict';
  if (/^E[A-Z0-9]+$/.test(code ?? '')) return 'filesystem';
  return 'unknown';
};

const trustedCause = (cause: unknown) => {
  try {
    return Schema.is(VolumeError)(cause) || Schema.is(EncryptionError)(cause) || Schema.is(SubscriptionError)(cause)
      ? cause
      : undefined;
  } catch {
    return undefined;
  }
};

export const volumeError = (
  error: unknown,
  fileName: string | null,
  operation: string,
  kind?: VolumeErrorKind,
  outcome: ErrorOutcome = 'unknown',
  path?: string,
): VolumeError => {
  const details = remoteDetails(error);
  const cause = trustedCause(error);
  const fields = {
    fileName: typeof fileName === 'string' ? fileName : null,
    operation,
    ...(path === undefined ? {} : { path }),
    ...(details.code ? { code: details.code } : {}),
    outcome,
    details,
    ...(cause === undefined ? {} : { cause }),
  };
  const classified = classify(details);
  const resolvedKind = kind === 'configuration' ? kind : classified === 'unknown' ? (kind ?? classified) : classified;
  return new VolumeError({ kind: resolvedKind, ...fields });
};

export const mountError = (
  error: unknown,
  fileName: string | null,
  operation: string,
  kind?: VolumeErrorKind,
  outcome: ErrorOutcome = 'unknown',
): MountError => {
  const details = remoteDetails(error);
  const classified = classify(details);
  const resolvedKind = kind === 'configuration' ? kind : classified === 'unknown' ? kind : classified;
  const reason =
    resolvedKind === 'configuration' ? undefined : details.code ? encryptionReasons[details.code] : undefined;
  if (!reason) return volumeError(error, fileName, operation, resolvedKind, outcome);
  const cause = trustedCause(error);
  return new EncryptionError({
    reason,
    fileName,
    operation,
    ...(details.code ? { code: details.code } : {}),
    outcome,
    details,
    ...(cause === undefined ? {} : { cause }),
  });
};

import { VfsCommandError, type RemoteErrorDetails } from '@opfs-vfs/opfs-vfs/worker';

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
export type VolumeErrorOutcome = 'not-applied' | 'possibly-applied' | 'unknown';

export class VolumeError extends Error {
  override readonly name = 'VolumeError';
  readonly kind: VolumeErrorKind;
  readonly operation: string;
  readonly volume: string | null;
  readonly path?: string;
  readonly details: RemoteErrorDetails | null;
  readonly outcome: VolumeErrorOutcome;

  constructor(init: {
    kind: VolumeErrorKind;
    operation: string;
    volume: string | null;
    path?: string;
    details?: RemoteErrorDetails | null;
    outcome: VolumeErrorOutcome;
    message?: string;
    cause?: unknown;
  }) {
    super(init.message ?? init.details?.message ?? 'Volume error', { cause: init.cause });
    this.kind = init.kind;
    this.operation = init.operation;
    this.volume = init.volume;
    this.path = init.path;
    this.details = init.details ?? null;
    this.outcome = init.outcome;
  }
}

export function configurationError(operation: string, volume: string | null, message: string) {
  return new VolumeError({ kind: 'configuration', operation, volume, message, outcome: 'not-applied' });
}

export function classify(details: RemoteErrorDetails | null, operation: string): VolumeErrorKind {
  const code = details?.code;
  if (
    [
      'EVOLUMELOCKED',
      'EVAULTCORRUPT',
      'EVAULTFORMAT',
      'EKDF',
      'ECRYPTOINTEGRITY',
      'ECRYPTSIDECAR',
      'EPLAINTEXTVOLUME',
    ].includes(code ?? '')
  )
    return 'encryption';
  if (code === 'VFS_STORAGE_PLUGIN_REQUIRED') return 'unsupported';
  if (
    [
      'VFS_SHUTTING_DOWN',
      'VFS_ATTACHMENT_LOST',
      'VFS_PROTOCOL_MISMATCH',
      'VFS_PLUGIN_MISMATCH',
      'VFS_NOT_LEADER',
      'VFS_LEADER_NOT_READY',
      'VFS_WORKER_FAILED',
      'VFS_INITIALIZATION_TIMEOUT',
      'LEADER_RESPONSE_TIMEOUT',
      'VOLUME_IMPORTING',
    ].includes(code ?? '')
  )
    return 'lifecycle';
  if (code?.startsWith('SUBSCRIPTION_')) return 'subscription';
  if (
    details?.category ||
    ['VfsCorruptionError', 'MetaSnapshotCorruptionError', 'DataWalCorruptionError'].includes(details?.name ?? '')
  )
    return 'corruption';
  if (code === 'ENOSPC' || details?.name === 'QuotaExceededError') return 'quota';
  if (code === 'EEXIST' || (code === 'EBUSY' && operation === 'writeFileBuffer')) return 'conflict';
  if (/^E[A-Z0-9]+$/.test(code ?? '')) return 'filesystem';
  return 'unknown';
}

export function toVolumeError(
  cause: unknown,
  input: { operation: string; volume: string | null; path?: string; mutation: boolean },
) {
  const command = cause instanceof VfsCommandError ? cause : null;
  // Reuse core's bounded `toRemoteErrorDetails` sanitization without importing an internal entry point.
  const details = command?.details ?? new VfsCommandError(cause, 'replied').details;
  return new VolumeError({
    kind: classify(details, input.operation),
    operation: input.operation,
    volume: input.volume,
    ...(input.path === undefined ? {} : { path: input.path }),
    details,
    outcome:
      command?.dispatch === 'refused'
        ? 'not-applied'
        : command?.dispatch === 'sent' && input.mutation
          ? 'possibly-applied'
          : 'unknown',
    cause,
  });
}

export function lifecycleError(details: RemoteErrorDetails, operation: string, volume: string) {
  return new VolumeError({ kind: classify(details, operation), operation, volume, details, outcome: 'unknown' });
}

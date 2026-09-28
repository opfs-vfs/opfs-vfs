import type { PersistenceSource } from './mount-context';
import type { DataWalSalvageEvent, LocalPersistenceState } from './opfs-vfs';
import { parseRemoteError, serializeRemoteError, type RemoteErrorDetails } from './remote-error';

/** Worker command that enables frames for one generation and requests a fresh one. */
export const PERSISTENCE_STATUS = 'PERSISTENCE_STATUS';
/** Frame type on the worker port and the owner channel. */
export const PERSISTENCE_FRAME = 'PERSISTENCE_FRAME';

/** Owner-reported local persistence for the current owner generation; `null` while unknown. */
export interface ClientPersistenceStatus {
  readonly state: LocalPersistenceState;
  /** Retained last failure of this owner generation; kept after the state leaves `error`. */
  readonly lastError: RemoteErrorDetails | null;
  /** Increases once per recorded failure; 0 means no failure in this owner generation. */
  readonly failureRevision: number;
  readonly lastSalvage: DataWalSalvageEvent | null;
}

export function encodePersistenceFrame(generation: string, sequence: number, source: PersistenceSource) {
  const salvage = source.salvage;
  return {
    version: 1,
    generation,
    sequence,
    state: source.state,
    failureRevision: source.failureRevision,
    lastError:
      source.failureRevision === 0
        ? null
        : serializeRemoteError(source.failure ?? new Error('Local persistence failed')),
    lastSalvage: salvage
      ? {
          reason: salvage.reason,
          truncatedAt: salvage.truncatedAt,
          discardedBytes: salvage.discardedBytes,
          detail: salvage.detail,
          at: salvage.at,
        }
      : null,
  };
}

const frameFields = new Set([
  'version',
  'generation',
  'sequence',
  'state',
  'failureRevision',
  'lastError',
  'lastSalvage',
]);
const salvageFields = new Set(['reason', 'truncatedAt', 'discardedBytes', 'detail', 'at']);
const states = new Set<LocalPersistenceState>(['clean', 'dirty', 'flushing', 'recovering', 'error']);
const salvageReasons = new Set<DataWalSalvageEvent['reason']>(['corrupt-frame', 'apply-failure', 'stampless-cycle']);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactFields(value: object, fields: Set<string>) {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.size && keys.every((key) => typeof key === 'string' && fields.has(key));
  } catch {
    return false;
  }
}

export function parsePersistenceFrame(
  value: unknown,
): { generation: string; sequence: number; persistence: ClientPersistenceStatus } | null {
  if (!plainObject(value) || !exactFields(value, frameFields)) return null;
  try {
    const { version, generation, sequence, state, failureRevision, lastSalvage } = value;
    let lastError = value.lastError;
    if (
      version !== 1 ||
      typeof generation !== 'string' ||
      generation.length < 1 ||
      generation.length > 128 ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      typeof state !== 'string' ||
      !states.has(state as LocalPersistenceState) ||
      typeof failureRevision !== 'number' ||
      !Number.isSafeInteger(failureRevision) ||
      failureRevision < 0 ||
      (state === 'error' && failureRevision === 0) ||
      (failureRevision === 0 ? lastError !== null : (lastError = parseRemoteError(lastError)) === null)
    )
      return null;
    let salvage: DataWalSalvageEvent | null = null;
    if (lastSalvage !== null) {
      if (!plainObject(lastSalvage) || !exactFields(lastSalvage, salvageFields)) return null;
      const { reason, truncatedAt, discardedBytes, detail, at } = lastSalvage;
      if (
        typeof reason !== 'string' ||
        !salvageReasons.has(reason as DataWalSalvageEvent['reason']) ||
        typeof truncatedAt !== 'number' ||
        !Number.isSafeInteger(truncatedAt) ||
        truncatedAt < 0 ||
        typeof discardedBytes !== 'number' ||
        !Number.isSafeInteger(discardedBytes) ||
        discardedBytes < 0 ||
        typeof detail !== 'string' ||
        detail.length > 1024 ||
        typeof at !== 'number' ||
        !Number.isFinite(at)
      )
        return null;
      salvage = Object.freeze({
        reason: reason as DataWalSalvageEvent['reason'],
        truncatedAt,
        discardedBytes,
        detail,
        at,
      });
    }
    return {
      generation,
      sequence,
      persistence: Object.freeze({
        state: state as LocalPersistenceState,
        lastError: lastError as RemoteErrorDetails | null,
        failureRevision,
        lastSalvage: salvage,
      }),
    };
  } catch {
    return null;
  }
}

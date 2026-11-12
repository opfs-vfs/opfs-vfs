import { createVfsError } from './fs-errors.js';
import type { OpfsVfsOptions } from './opfs-vfs.js';
import type { VfsPluginRequest } from './plugins.js';

export interface MountProfile {
  readonly version: 2;
  readonly capabilities: readonly string[];
  readonly plugins: readonly { readonly id: string; readonly contractVersion: 1; readonly compatibilityKey: string }[];
}
export interface SharedMountProfile extends MountProfile {
  readonly transport: 'shared-worker';
}

const requestFields = new Set(['id', 'contractVersion', 'compatibilityKey', 'requiredOpenMode', 'options']);
const profileFields = new Set(['version', 'capabilities', 'plugins']);
const sharedProfileFields = new Set(['version', 'capabilities', 'plugins', 'transport']);
const entryFields = new Set(['id', 'contractVersion', 'compatibilityKey']);
export const MOUNT_CAPABILITIES = ['error-details', 'persistence-status'] as const;
export const isValidPluginId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9.-]*$/.test(id);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const onlyFields = (value: object, fields: Set<string>) =>
  Reflect.ownKeys(value).every((key) => fields.has(String(key)));
const exactFields = (value: object, fields: Set<string>) =>
  onlyFields(value, fields) && [...fields].every((field) => Object.hasOwn(value, field));

/** Snapshot and validate page/worker requests before they can affect ownership. */
export function preparePluginRequests(
  plugins: unknown,
  openMode: OpfsVfsOptions['openMode'],
  fileName: string,
): { requests: VfsPluginRequest[]; profile: MountProfile } {
  const invalid = (message: string): never => {
    throw createVfsError('EINVAL', fileName, message);
  };
  if (plugins === undefined) plugins = [];
  if (!Array.isArray(plugins)) invalid('Plugin requests must be an array');
  let copied: unknown;
  try {
    copied = structuredClone(plugins);
  } catch {
    invalid('Plugin requests must be structured-cloneable');
  }
  const requests: VfsPluginRequest[] = [];
  const ids = new Set<string>();
  for (const value of copied as unknown[]) {
    if (!record(value) || !onlyFields(value, requestFields) || !Object.hasOwn(value, 'options')) {
      invalid('Invalid plugin request');
    }
    const { id, contractVersion, compatibilityKey, requiredOpenMode, options } = value as Record<string, unknown>;
    if (!isValidPluginId(id)) invalid('Invalid plugin id');
    const pluginId = id as string;
    if (ids.has(pluginId)) invalid(`Duplicate plugin id: ${pluginId}`);
    ids.add(pluginId);
    if (contractVersion !== 1) invalid(`Unsupported plugin contract: ${pluginId}`);
    if (typeof compatibilityKey !== 'string') invalid(`Invalid plugin compatibility key: ${pluginId}`);
    if (requiredOpenMode !== undefined && requiredOpenMode !== 'create-new')
      invalid(`Invalid required open mode: ${pluginId}`);
    if (requiredOpenMode && openMode !== requiredOpenMode) invalid(`Plugin ${pluginId} requires create-new`);
    if (requests.length >= 2) invalid('Too many plugin requests');
    requests.push({
      id: pluginId,
      contractVersion: 1,
      compatibilityKey: compatibilityKey as string,
      ...(requiredOpenMode ? { requiredOpenMode: 'create-new' as const } : {}),
      options,
    });
  }
  return { requests, profile: createMountProfile(requests) };
}

export function createMountProfile(
  plugins: readonly Pick<VfsPluginRequest, 'id' | 'contractVersion' | 'compatibilityKey'>[],
): MountProfile {
  return {
    version: 2,
    capabilities: [...new Set(MOUNT_CAPABILITIES)].sort(),
    plugins: plugins
      .map(({ id, contractVersion, compatibilityKey }) => ({ id, contractVersion, compatibilityKey }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** The normal v2 validator intentionally rejects this transport marker. */
export function createSharedMountProfile(
  plugins: readonly Pick<VfsPluginRequest, 'id' | 'contractVersion' | 'compatibilityKey'>[],
): SharedMountProfile {
  return { ...createMountProfile(plugins), transport: 'shared-worker' };
}

/**
 * Optional capability a shared owner announces once it holds {@link ownerLivenessLockName} for its generation.
 * It is never part of an expected profile: owners of an older build do not announce it, and followers of an older
 * build ignore it, so pages and hosts of different builds keep attaching to each other.
 */
export const OWNER_LIVENESS_CAPABILITY = 'owner-liveness-lock';

/** Held by a shared owner for as long as `generation` is mounted; followers queue on it to observe owner loss. */
export const ownerLivenessLockName = (fileName: string, generation: string) =>
  `opfs-vfs-owner-${fileName}-${generation}`;

/** The profile a shared owner announces: its required profile plus the optional capabilities it provides. */
export function announcedSharedProfile(profile: SharedMountProfile): SharedMountProfile {
  return { ...profile, capabilities: [...new Set([...profile.capabilities, OWNER_LIVENESS_CAPABILITY])].sort() };
}

/** Whether an announced owner profile offers the per-generation liveness lock. */
export function announcesOwnerLiveness(profile: unknown): boolean {
  const capabilities = record(profile) ? profile.capabilities : undefined;
  return Array.isArray(capabilities) && capabilities.includes(OWNER_LIVENESS_CAPABILITY);
}

/** Return the incompatibility code for a remote mount profile, if any. */
export function mountProfileMismatch(
  value: unknown,
  expected: MountProfile,
): 'VFS_PROTOCOL_MISMATCH' | 'VFS_PLUGIN_MISMATCH' | undefined {
  const capabilities: unknown = plainRecord(value) ? value.capabilities : undefined;
  if (
    !plainRecord(value) ||
    !exactFields(value, profileFields) ||
    value.version !== 2 ||
    !Array.isArray(capabilities) ||
    capabilities.length > 32 ||
    !capabilities.every(isValidPluginId) ||
    new Set(capabilities).size !== capabilities.length ||
    !expected.capabilities.every((capability) => capabilities.includes(capability)) ||
    !Array.isArray(value.plugins)
  )
    return 'VFS_PROTOCOL_MISMATCH';
  if (value.plugins.length !== expected.plugins.length) return 'VFS_PLUGIN_MISMATCH';
  if (
    !value.plugins.every((entry, index) => {
      const wanted = expected.plugins[index];
      return (
        record(entry) &&
        exactFields(entry, entryFields) &&
        isValidPluginId(entry.id) &&
        entry.id === wanted?.id &&
        entry.contractVersion === 1 &&
        entry.compatibilityKey === wanted.compatibilityKey
      );
    })
  )
    return 'VFS_PLUGIN_MISMATCH';
  return undefined;
}

export function sharedMountProfileMismatch(
  value: unknown,
  expected: SharedMountProfile,
): 'VFS_PROTOCOL_MISMATCH' | 'VFS_PLUGIN_MISMATCH' | undefined {
  if (!plainRecord(value) || !exactFields(value, sharedProfileFields) || value.transport !== 'shared-worker')
    return 'VFS_PROTOCOL_MISMATCH';
  return mountProfileMismatch(
    { version: value.version, capabilities: value.capabilities, plugins: value.plugins },
    expected,
  );
}

import { createVfsError } from './fs-errors';
import type { ConfiguredVfsPlugin, StorageSidecarSuffix } from './plugins';
import type { LogicalChangeContribution } from './changes';
import type { VolumeStorageFactory } from './storage-contract';
import { isValidPluginId } from './worker-plugins';

type OpenMode = 'open-or-create' | 'create-new' | 'open-existing';

export interface ValidatedConfiguredPlugin {
  readonly source: object;
  readonly id: string;
  readonly contractVersion: 1;
  readonly compatibilityKey: string;
  readonly requiredOpenMode?: 'create-new';
  readonly storage?: { readonly factory: VolumeStorageFactory; readonly sidecars: readonly StorageSidecarSuffix[] };
  readonly logicalChanges?: {
    readonly source: object;
    readonly contribution: LogicalChangeContribution;
    readonly create: LogicalChangeContribution['create'];
  };
}

/** Worker preflight snapshots, consumed once by the core constructor. Never carried in INIT. */
export const validatedPluginOptions = new WeakMap<object, readonly ValidatedConfiguredPlugin[]>();

const supportedSidecars = new Set<StorageSidecarSuffix>(['.vault', '.crypt', '.crypt.log']);
const pluginFields = new Set([
  'id',
  'contractVersion',
  'compatibilityKey',
  'requiredOpenMode',
  'storage',
  'logicalChanges',
]);
const storageFields = new Set(['factory', 'sidecars']);
const claimedPlugins = new WeakSet<object>();
const claimedFactories = new WeakSet<Function>();
const claimedContributions = new WeakSet<object>();
const ownOnly = (value: object, fields: ReadonlySet<string>) =>
  Reflect.ownKeys(value).every((field) => typeof field === 'string' && fields.has(field));

/** Validate and snapshot configured plugins without claiming them. */
export function validateConfiguredPlugins(
  plugins: unknown,
  openMode: OpenMode,
  fileName: string,
): readonly ValidatedConfiguredPlugin[] {
  if (plugins === undefined) return [];
  const invalid = (message: string): never => {
    throw createVfsError('EINVAL', fileName, message);
  };
  if (!Array.isArray(plugins)) invalid('Plugins must be an array');
  const validated: ValidatedConfiguredPlugin[] = [];
  const ids = new Set<string>();
  const factories = new Set<Function>();
  let storageCount = 0;
  let logicalChangeCount = 0;
  for (const plugin of plugins as unknown[]) {
    if (typeof plugin !== 'object' || plugin === null) invalid('Invalid configured plugin');
    const p = plugin as ConfiguredVfsPlugin;
    if (!ownOnly(p, pluginFields)) invalid('Unsupported plugin contribution');
    const { id, contractVersion, compatibilityKey, requiredOpenMode, storage, logicalChanges } = p;
    if (!isValidPluginId(id)) invalid('Invalid plugin id');
    if (ids.has(id)) invalid(`Duplicate plugin id: ${id}`);
    ids.add(id);
    if (contractVersion !== 1) invalid(`Unsupported plugin contract: ${id}`);
    if (typeof compatibilityKey !== 'string') invalid(`Invalid plugin compatibility key: ${id}`);
    if (requiredOpenMode !== undefined && requiredOpenMode !== 'create-new') {
      invalid(`Invalid required open mode: ${id}`);
    }
    if (requiredOpenMode && requiredOpenMode !== openMode) invalid(`Plugin ${id} requires create-new`);
    if ((storage === undefined) === (logicalChanges === undefined))
      invalid(`Plugin ${id} must contribute exactly one capability`);
    const base = {
      source: p,
      id,
      contractVersion: 1 as const,
      compatibilityKey,
      ...(requiredOpenMode ? { requiredOpenMode } : {}),
    };
    if (storage !== undefined) {
      if (
        typeof storage !== 'object' ||
        storage === null ||
        Array.isArray(storage) ||
        !ownOnly(storage, storageFields)
      ) {
        invalid(`Plugin ${id} requires a storage factory`);
      }
      const { factory, sidecars: declaredSidecars } = storage;
      if (typeof factory !== 'function') invalid(`Plugin ${id} requires a storage factory`);
      if (!Array.isArray(declaredSidecars)) invalid(`Plugin ${id} must declare storage sidecars`);
      const sidecars = [...declaredSidecars];
      if (new Set(sidecars).size !== sidecars.length || sidecars.some((suffix) => !supportedSidecars.has(suffix)))
        invalid(`Plugin ${id} declared invalid storage sidecars`);
      if (++storageCount > 1) invalid('Multiple storage plugins are unsupported');
      if (factories.has(factory)) invalid(`Configured plugin factory already used: ${id}`);
      factories.add(factory);
      validated.push({ ...base, storage: { factory, sidecars } });
    } else {
      if (
        typeof logicalChanges !== 'object' ||
        logicalChanges === null ||
        Array.isArray(logicalChanges) ||
        !ownOnly(logicalChanges, new Set(['version', 'create']))
      ) {
        invalid(`Plugin ${id} requires logical changes`);
      }
      const version = logicalChanges.version;
      const create = Reflect.get(logicalChanges, 'create') as LogicalChangeContribution['create'];
      if (version !== 1 || typeof create !== 'function') invalid(`Plugin ${id} requires logical changes`);
      if (++logicalChangeCount > 1) invalid('Multiple logical-change plugins are unsupported');
      if (factories.has(create)) invalid(`Configured plugin factory already used: ${id}`);
      factories.add(create);
      validated.push({
        ...base,
        logicalChanges: { source: logicalChanges, contribution: { version, create }, create },
      });
    }
  }
  return validated;
}

/** Claim before the first mount await, including when initialization later fails. */
export function claimConfiguredPlugins(plugins: readonly ValidatedConfiguredPlugin[], fileName: string): void {
  for (const plugin of plugins) {
    const factory = plugin.storage ? plugin.storage.factory : plugin.logicalChanges!.create;
    const contribution = plugin.logicalChanges?.source;
    if (
      claimedPlugins.has(plugin.source) ||
      claimedFactories.has(factory) ||
      (contribution && claimedContributions.has(contribution))
    ) {
      throw createVfsError('EINVAL', fileName, `Configured plugin already mounted: ${plugin.id}`);
    }
    claimedPlugins.add(plugin.source);
    claimedFactories.add(factory);
    if (contribution) claimedContributions.add(contribution);
  }
}

/** Check a new worker mount before closing an existing live mount. */
export function assertUnclaimedConfiguredPlugins(
  plugins: readonly ValidatedConfiguredPlugin[],
  fileName: string,
): void {
  for (const plugin of plugins) {
    const factory = plugin.storage ? plugin.storage.factory : plugin.logicalChanges!.create;
    const contribution = plugin.logicalChanges?.source;
    if (
      claimedPlugins.has(plugin.source) ||
      claimedFactories.has(factory) ||
      (contribution && claimedContributions.has(contribution))
    ) {
      throw createVfsError('EINVAL', fileName, `Configured plugin already mounted: ${plugin.id}`);
    }
  }
}

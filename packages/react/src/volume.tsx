import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  GENERATION_METHODS,
  getSupport,
  openOpfsVfsWorker,
  type ClientStatus,
  type GenerationClient,
  type GenerationMethod,
  type OpfsVfsWorkerOptions,
  type VfsSupportRequirement,
  type VfsWorkerFactory,
  type SharedWorkerFactory,
} from '@opfs-vfs/opfs-vfs/worker';
// @ts-expect-error Vite worker import with query string
import VfsWorker from './vfs.worker?worker&inline';
// @ts-expect-error Vite shared worker import with query string
import VfsSharedWorker from './vfs.shared-worker?sharedworker';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import type { VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';
import { SUBSCRIPTIONS_COMPATIBILITY_KEY, subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { configurationError, lifecycleError, toVolumeError, VolumeError } from './errors';
import { clientStore, type ClientStore } from './resources';
import { requestPersistentStorageOnMount } from './persistence';

export const DEFAULT_VOLUME: unique symbol = Symbol('opfs-vfs.default-volume');
export type VolumeName = string | typeof DEFAULT_VOLUME;
export type ManagedOptions = Omit<
  OpfsVfsWorkerOptions,
  | 'worker'
  | 'observerProtocol'
  | 'plugins'
  | 'transport'
  | 'sharedWorker'
  | 'signal'
  | 'attachTo'
  | 'sharedHost'
  | 'followerOnly'
  | 'attachmentId'
  | 'transportClose'
  | 'fallbackReason'
>;
export type VolumeStatus = 'pending' | 'ready' | 'recovering' | 'unsupported' | 'error' | 'closed';

interface VolumeState {
  readonly status: VolumeStatus;
  readonly error: VolumeError | null;
  readonly missingCapabilities: readonly VfsSupportRequirement[];
  readonly role: 'leader' | 'follower' | null;
  readonly generation: string | null;
  readonly persistence: ClientStatus['persistence'];
  readonly transport: ClientStatus['transport'] | null;
  readonly fallbackReason: ClientStatus['fallbackReason'];
  readonly isClosing: boolean;
}

export type ManagedVolumeResult = VolumeState & { readonly ownership: 'managed'; readonly close: () => Promise<void> };
export type BorrowedVolumeResult = VolumeState & { readonly ownership: 'borrowed' };
export type VolumeResult = ManagedVolumeResult | BorrowedVolumeResult;
const DESCRIPTOR_METHODS = [
  'open',
  'read',
  'write',
  'seek',
  'close',
  'fstat',
  'fsync',
  'ftruncate',
] as const satisfies readonly GenerationMethod[];
type DescriptorMethod = (typeof DESCRIPTOR_METHODS)[number];
type VolumeMethod = Exclude<GenerationMethod, DescriptorMethod>;
export type VolumeClient = Omit<GenerationClient, DescriptorMethod>;
const DESCRIPTOR_METHOD_SET = new Set<GenerationMethod>(DESCRIPTOR_METHODS);
const isVolumeMethod = (method: GenerationMethod): method is VolumeMethod => !DESCRIPTOR_METHOD_SET.has(method);

type SharedProviderProps = {
  name?: VolumeName;
  persistentStorage?: 'manual' | 'request-on-mount';
  onError?: (error: VolumeError) => void;
  children: ReactNode | ((volume: VolumeResult) => ReactNode);
};
export type ManagedVolumeProviderProps = SharedProviderProps & {
  fileName: string;
  worker?: VfsWorkerFactory;
  plugins?: readonly VfsPluginRequest[];
  options?: ManagedOptions;
  transport?: 'auto' | 'dedicated' | 'shared-worker';
  sharedWorker?: SharedWorkerFactory;
  client?: never;
};
export type BorrowedVolumeProviderProps = SharedProviderProps & {
  client: OpfsVfsWorkerClient;
  fileName?: never;
  worker?: never;
  plugins?: never;
  options?: never;
  transport?: never;
  sharedWorker?: never;
};
export type VolumeProviderProps = ManagedVolumeProviderProps | BorrowedVolumeProviderProps;

type Link = { readonly name: VolumeName; readonly binding: VolumeBinding; readonly parent: Link | null };
const Context = createContext<Link | null>(null);
const EMPTY_CAPABILITIES: readonly VfsSupportRequirement[] = Object.freeze([]);
const READS = new Set<GenerationMethod>(['readFileBuffer', 'stat', 'lstat', 'readdirEntries', 'readlink', 'realpath']);
const OPTION_KEYS = [
  'openMode',
  'forceLeader',
  'claimIfAvailable',
  'initTimeout',
  'debug',
  'bufferMode',
  'localDurabilityMode',
  'noatime',
  'recoveryMode',
  'sabSize',
  'debugWal',
  'maxFileSize',
  'maxNameLength',
  'maxPathDepth',
  'maxFiles',
  'maxTotalBytes',
] as const;
const OPTION_KEY_SET = new Set<string>(OPTION_KEYS);
const bundledWorker: VfsWorkerFactory = () => new VfsWorker({ type: 'module' });
const bundledSharedWorker: SharedWorkerFactory = (fileName) =>
  new VfsSharedWorker({ type: 'module', name: `opfs-vfs-react-${fileName}` });

type ManagedInput = {
  kind: 'managed';
  identity: string;
  fileName: string;
  worker: VfsWorkerFactory;
  observerProtocol?: boolean;
  plugins: readonly VfsPluginRequest[];
  options: ManagedOptions;
  transport: 'auto' | 'dedicated' | 'shared-worker';
  sharedWorker?: SharedWorkerFactory;
};
type BorrowedInput = {
  kind: 'borrowed';
  identity: OpfsVfsWorkerClient;
  fileName: string | null;
  client: OpfsVfsWorkerClient;
};
type Input = ManagedInput | BorrowedInput;
type InputHolder = { input: ManagedInput | { kind: 'borrowed'; client: OpfsVfsWorkerClient } | null };
type Source = {
  readonly snapshot: VolumeResult;
  readonly store: ClientStore | null;
  readonly ownerGeneration: string | null;
  attach(binding: VolumeBinding): void;
  detach(binding: VolumeBinding): void;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function validateName(value: unknown, operation: string, volume: string | null): VolumeName {
  if (value === undefined) return DEFAULT_VOLUME;
  if (value === DEFAULT_VOLUME || (typeof value === 'string' && value.length > 0)) return value;
  throw configurationError(operation, volume, 'Volume name must be a nonempty string or DEFAULT_VOLUME');
}

function validatePlugins(value: unknown, fileName: string, openMode: unknown): readonly VfsPluginRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw configurationError('configure', fileName, 'Plugins must be an array');
  const ids = new Set<string>();
  const requests: VfsPluginRequest[] = [];
  for (const request of value) {
    const profile = request as Record<string, unknown>;
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request) ||
      !Reflect.ownKeys(request).every((key) =>
        ['id', 'contractVersion', 'compatibilityKey', 'requiredOpenMode', 'options'].includes(String(key)),
      ) ||
      !Object.hasOwn(request, 'options') ||
      typeof profile.id !== 'string' ||
      !/^[a-z][a-z0-9.-]*$/.test(profile.id) ||
      profile.contractVersion !== 1
    )
      throw configurationError('configure', fileName, 'Plugin requests must have a compatible profile');
    if (ids.has(profile.id) || typeof profile.compatibilityKey !== 'string')
      throw configurationError('configure', fileName, 'Plugin requests must have a compatible profile');
    if (profile.requiredOpenMode !== undefined && profile.requiredOpenMode !== 'create-new')
      throw configurationError('configure', fileName, 'Plugin requests must have a compatible profile');
    if (profile.requiredOpenMode === 'create-new' && openMode !== 'create-new')
      throw configurationError('configure', fileName, 'Plugin requests must have a compatible profile');
    ids.add(profile.id);
    if (profile.id === 'subscriptions') {
      if (profile.contractVersion !== 1 || profile.compatibilityKey !== SUBSCRIPTIONS_COMPATIBILITY_KEY)
        throw configurationError('configure', fileName, 'Subscriptions plugin profile is incompatible');
    }
    requests.push({
      id: profile.id,
      contractVersion: 1,
      compatibilityKey: profile.compatibilityKey,
      ...(profile.requiredOpenMode ? { requiredOpenMode: 'create-new' as const } : {}),
      options: profile.options,
    });
  }
  return requests;
}

function validateOptions(value: unknown, fileName: string): ManagedOptions {
  if (value === undefined) return {};
  if (!plainObject(value)) throw configurationError('configure', fileName, 'Options must be a plain object');
  const options: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(value)) {
    const valid =
      option === undefined ||
      (['forceLeader', 'claimIfAvailable', 'debug', 'noatime', 'debugWal'].includes(key) &&
        typeof option === 'boolean') ||
      (key === 'openMode' && ['open-or-create', 'create-new', 'open-existing'].includes(option as string)) ||
      (key === 'bufferMode' && ['memory', 'disk'].includes(option as string)) ||
      (key === 'localDurabilityMode' && ['relaxed', 'balanced', 'strict'].includes(option as string)) ||
      (key === 'recoveryMode' && ['fail-stop', 'salvage'].includes(option as string)) ||
      (key === 'sabSize' && Number.isSafeInteger(option) && (option as number) > 0 && (option as number) % 4 === 0) ||
      (['initTimeout', 'maxFileSize', 'maxNameLength', 'maxPathDepth', 'maxFiles', 'maxTotalBytes'].includes(key) &&
        Number.isSafeInteger(option) &&
        (option as number) >= 0);
    if (!OPTION_KEY_SET.has(key) || !valid)
      throw configurationError('configure', fileName, 'Options contain an unsupported value');
    options[key] = option;
  }
  if (
    options.claimIfAvailable &&
    (options.forceLeader || (options.openMode !== 'open-existing' && options.openMode !== 'create-new'))
  )
    throw configurationError('configure', fileName, 'Options contain an unsupported value');
  return options as ManagedOptions;
}

function normalizedOptions(options: ManagedOptions) {
  const values = options as Record<string, unknown>;
  return {
    openMode: values.openMode ?? 'open-or-create',
    forceLeader: values.forceLeader ?? false,
    claimIfAvailable: values.claimIfAvailable ?? false,
    initTimeout: values.initTimeout || 15000,
    debug: values.debug ?? false,
    bufferMode: values.bufferMode ?? 'disk',
    localDurabilityMode: values.localDurabilityMode ?? 'balanced',
    noatime: values.noatime ?? false,
    recoveryMode: values.recoveryMode ?? 'salvage',
    sabSize: values.sabSize ?? 4 * 1024 * 1024,
    debugWal: values.debugWal ?? false,
    maxFileSize: Math.min((values.maxFileSize as number | undefined) ?? 0xffffffff, 0xffffffff),
    maxNameLength: values.maxNameLength ?? 255,
    maxPathDepth: values.maxPathDepth,
    maxFiles: values.maxFiles,
    maxTotalBytes: values.maxTotalBytes,
  };
}

function managedInput(props: Record<string, unknown>): ManagedInput {
  const fileName = props.fileName;
  if (
    typeof fileName !== 'string' ||
    fileName.length <= 4 ||
    !fileName.endsWith('.bin') ||
    fileName.includes('/') ||
    fileName.includes('\\')
  )
    // Core repeats this basename validation before opening.
    throw configurationError(
      'configure',
      typeof fileName === 'string' ? fileName : null,
      'fileName must be a .bin basename',
    );
  if (props.worker !== undefined && typeof props.worker !== 'function')
    throw configurationError('configure', fileName, 'worker must be a factory');
  const options = validateOptions(props.options, fileName);
  const transport = props.transport === undefined ? 'auto' : props.transport;
  if (transport !== 'auto' && transport !== 'dedicated' && transport !== 'shared-worker')
    throw configurationError('configure', fileName, 'transport must be auto, dedicated, or shared-worker');
  if (props.sharedWorker !== undefined && typeof props.sharedWorker !== 'function')
    throw configurationError('configure', fileName, 'sharedWorker must be a factory');
  if (transport === 'shared-worker' && props.worker && typeof props.sharedWorker !== 'function')
    throw configurationError('configure', fileName, 'shared-worker transport requires a SharedWorker factory');
  const plugins = validatePlugins(props.plugins, fileName, options.openMode);
  if (plugins.length && !props.worker)
    throw configurationError('configure', fileName, 'Plugin requests require an application worker');
  const subscription = subscriptionsRequest();
  const requests = plugins.some((request) => request.id === 'subscriptions')
    ? plugins
    : [
        ...plugins,
        {
          id: subscription.id,
          contractVersion: subscription.contractVersion,
          compatibilityKey: subscription.compatibilityKey,
          ...(subscription.requiredOpenMode ? { requiredOpenMode: subscription.requiredOpenMode } : {}),
          options: subscription.options,
        },
      ];
  if (requests.length > 2)
    throw configurationError('configure', fileName, 'Plugin requests must have a compatible profile');
  const profiles = requests
    .map(({ id, contractVersion, compatibilityKey, requiredOpenMode }) => ({
      id,
      contractVersion,
      compatibilityKey,
      requiredOpenMode,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    kind: 'managed',
    identity: JSON.stringify({ fileName, transport, options: normalizedOptions(options), profiles }),
    fileName,
    worker: (props.worker as VfsWorkerFactory | undefined) ?? bundledWorker,
    observerProtocol: props.worker === undefined,
    plugins: requests,
    options,
    transport,
    sharedWorker:
      (props.sharedWorker as SharedWorkerFactory | undefined) ?? (props.worker ? undefined : bundledSharedWorker),
  };
}

function validateInput(props: VolumeProviderProps): Input {
  const value = props as unknown as Record<string, unknown>;
  if (
    value.persistentStorage !== undefined &&
    value.persistentStorage !== 'manual' &&
    value.persistentStorage !== 'request-on-mount'
  )
    throw configurationError('configure', null, 'persistentStorage must be manual or request-on-mount');
  const hasClient = value.client !== undefined;
  const hasManaged =
    value.fileName !== undefined ||
    value.worker !== undefined ||
    value.plugins !== undefined ||
    value.options !== undefined ||
    value.transport !== undefined ||
    value.sharedWorker !== undefined;
  if (hasClient && hasManaged)
    throw configurationError('configure', null, 'Managed and borrowed provider props cannot be mixed');
  if (!hasClient) return managedInput(value);
  const client = value.client;
  if (
    !client ||
    typeof client !== 'object' ||
    !['getStatus', 'subscribeStatus', 'forGeneration'].every(
      (key) => typeof (client as Record<string, unknown>)[key] === 'function',
    )
  )
    throw configurationError('configure', null, 'client must be an OPFS VFS worker client');
  return {
    kind: 'borrowed',
    identity: client as OpfsVfsWorkerClient,
    fileName: (client as OpfsVfsWorkerClient).getStatus().fileName,
    client: client as OpfsVfsWorkerClient,
  };
}

function sameSnapshot(left: VolumeResult, right: VolumeResult) {
  return (
    left.status === right.status &&
    left.error === right.error &&
    left.missingCapabilities === right.missingCapabilities &&
    left.role === right.role &&
    left.generation === right.generation &&
    left.persistence === right.persistence &&
    left.transport === right.transport &&
    left.fallbackReason === right.fallbackReason &&
    left.isClosing === right.isClosing &&
    left.ownership === right.ownership &&
    (!('close' in left) || !('close' in right) || left.close === right.close)
  );
}

function resultFrom(
  status: ClientStatus,
  ownership: 'managed' | 'borrowed',
  store: ClientStore | null,
  errorFor: (details: NonNullable<ClientStatus['error']>, operation: string) => VolumeError,
  close?: () => Promise<void>,
): VolumeResult {
  const base = {
    missingCapabilities: EMPTY_CAPABILITIES,
    role: status.state === 'ready' || status.state === 'recovering' ? status.role : null,
    generation:
      status.state === 'ready' && store && status.ownerGeneration ? store.generation(status.ownerGeneration) : null,
    persistence: status.persistence,
    transport: status.transport,
    fallbackReason: status.fallbackReason,
  };
  const error = status.error ? errorFor(status.error, status.state === 'failed' ? 'lifecycle' : 'close') : null;
  const state: VolumeState =
    status.state === 'opening'
      ? { ...base, status: 'pending', error: null, isClosing: false }
      : status.state === 'ready'
        ? { ...base, status: 'ready', error: null, isClosing: false }
        : status.state === 'recovering'
          ? { ...base, status: 'recovering', error: null, isClosing: false }
          : status.state === 'closing'
            ? { ...base, status: 'closed', error: null, isClosing: true }
            : status.state === 'failed'
              ? { ...base, status: 'error', error, isClosing: false }
              : { ...base, status: 'closed', error, isClosing: false };
  return Object.freeze(ownership === 'managed' ? { ...state, ownership, close: close! } : { ...state, ownership });
}

export class VolumeBinding {
  #source: Source | null = null;
  #snapshot: VolumeResult;
  #serverSnapshot: VolumeResult;
  #listeners = new Set<() => void>();
  #attachments = 0;
  #lastReported: VolumeError | null = null;
  #lastPersistenceGeneration: string | null = null;
  #lastPersistenceFailureRevision = 0;
  #client: VolumeClient | null = null;
  #clientGeneration: string | null = null;
  #ownerGeneration: string | null = null;
  #conflict: VolumeError | null = null;
  #preAttachClose: Promise<void> | null = null;
  #consumed = false;
  onError: ((error: VolumeError) => void) | null = null;

  constructor(
    readonly kind: Input['kind'],
    readonly identity: Input['identity'],
    readonly fileName: string | null,
  ) {
    const state: VolumeState = {
      status: 'pending',
      error: null,
      missingCapabilities: EMPTY_CAPABILITIES,
      role: null,
      generation: null,
      persistence: null,
      transport: null,
      fallbackReason: null,
      isClosing: false,
    };
    this.#snapshot = Object.freeze(
      kind === 'managed'
        ? { ...state, ownership: 'managed' as const, close: () => this.#managedClose() }
        : { ...state, ownership: 'borrowed' as const },
    );
    this.#serverSnapshot = this.#snapshot;
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  readonly getServerSnapshot = () => this.#serverSnapshot;
  get store(): ClientStore | null {
    return this.#source?.store ?? null;
  }
  resourceStore(): { readonly store: ClientStore; readonly ownerGeneration: string } | null {
    if (this.#snapshot.status !== 'ready' || !this.#source?.store || !this.#ownerGeneration) return null;
    return { store: this.#source.store, ownerGeneration: this.#ownerGeneration };
  }
  get conflict(): VolumeError | null {
    return this.#conflict;
  }
  get consumed() {
    return this.#consumed;
  }

  attach(holder: InputHolder) {
    this.#consumed = true;
    const input = holder.input;
    holder.input = null;
    if (this.#preAttachClose) {
      return () => {};
    }
    const attachment = ++this.#attachments;
    if (this.#source) this.#source.attach(this);
    else {
      // Only a binding with a configuration conflict has neither a source nor its input; it throws on render.
      if (!input) return () => {};
      if (input.kind === 'managed') acquireManaged(this, input);
      else {
        const source = borrowedSources.get(input.client) ?? new BorrowedSource(input.client);
        borrowedSources.set(input.client, source);
        this.#source = source;
        source.attach(this);
      }
    }
    return () => {
      if (attachment === this.#attachments) this.#source?.detach(this);
    };
  }

  initial(source: Source) {
    if (this.#source !== source) this.#source = source;
    this.#lastReported = source.snapshot.error;
    if (this.#applySnapshot(source.snapshot, source.ownerGeneration)) this.#notify();
    if (source.ownerGeneration && source.snapshot.persistence) {
      this.#lastPersistenceGeneration = source.ownerGeneration;
      this.#lastPersistenceFailureRevision = source.snapshot.persistence.failureRevision;
    }
  }

  changed(source: Source) {
    return this.#source === source && this.#applySnapshot(source.snapshot, source.ownerGeneration);
  }

  notify() {
    this.#notify();
  }

  reportSnapshotError() {
    const error = this.#snapshot.error;
    if (error && error !== this.#lastReported) {
      this.#lastReported = error;
      this.report(error);
    }
    const { persistence } = this.#snapshot;
    if (!persistence || !this.#ownerGeneration) return;
    if (this.#lastPersistenceGeneration !== this.#ownerGeneration) {
      this.#lastPersistenceGeneration = this.#ownerGeneration;
      this.#lastPersistenceFailureRevision = 0;
    }
    if (persistence.failureRevision <= this.#lastPersistenceFailureRevision) return;
    this.#lastPersistenceFailureRevision = persistence.failureRevision;
    this.report(
      new VolumeError({
        kind: 'persistence',
        operation: 'persistence',
        volume: this.fileName,
        details: persistence.lastError,
        outcome: 'unknown',
      }),
    );
  }

  conflictWith(error: VolumeError) {
    this.#conflict = error;
    if (this.#applySnapshot(Object.freeze({ ...this.#snapshot }) as VolumeResult, this.#ownerGeneration))
      this.#notify();
  }

  volumeClient(): VolumeClient | null {
    const snapshot = this.#snapshot;
    const source = this.#source;
    if (
      snapshot.status !== 'ready' ||
      snapshot.isClosing ||
      !source?.store ||
      !this.#ownerGeneration ||
      !snapshot.generation
    )
      return null;
    if (this.#client && this.#clientGeneration === snapshot.generation) return this.#client;
    const facade = source.store.facade(this.#ownerGeneration);
    const client = {} as Record<VolumeMethod, (...args: unknown[]) => Promise<unknown>>;
    for (const method of GENERATION_METHODS.filter(isVolumeMethod)) {
      client[method] = async (...args) => {
        try {
          return await (facade[method] as (...methodArgs: unknown[]) => Promise<unknown>)(...args);
        } catch (cause) {
          const error = toVolumeError(cause, {
            operation: method,
            volume: this.fileName,
            ...(typeof args[0] === 'string' ? { path: args[0] } : {}),
            mutation: !READS.has(method),
          });
          this.report(error);
          throw error;
        }
      };
    }
    this.#clientGeneration = snapshot.generation;
    this.#client = Object.freeze(client) as VolumeClient;
    return this.#client;
  }

  report(error: VolumeError) {
    try {
      this.onError?.(error);
    } catch {
      // Error reporters cannot interfere with VFS operations.
    }
  }

  #managedClose() {
    if (this.#source instanceof ManagedEntry) return this.#source.close();
    if (this.#preAttachClose) return this.#preAttachClose;
    this.#preAttachClose = Promise.resolve();
    const close = (this.#snapshot as ManagedVolumeResult).close;
    if (
      this.#applySnapshot(
        Object.freeze({ ...pendingState(), status: 'closed', ownership: 'managed' as const, close }),
        null,
      )
    )
      this.#notify();
    return this.#preAttachClose;
  }

  #applySnapshot(snapshot: VolumeResult, ownerGeneration: string | null) {
    if (snapshot === this.#snapshot) return;
    const previous = this.#snapshot;
    this.#snapshot = snapshot;
    this.#ownerGeneration = ownerGeneration;
    if (previous.generation !== snapshot.generation || snapshot.status !== 'ready') {
      this.#client = null;
      this.#clientGeneration = null;
    }
    return true;
  }

  #notify() {
    for (const listener of [...this.#listeners]) listener();
  }
}

class ManagedEntry implements Source {
  readonly bindings = new Set<VolumeBinding>();
  client: import('@opfs-vfs/opfs-vfs/worker-client').OpfsVfsWorkerClient | null = null;
  store: ClientStore | null = null;
  ownerGeneration: string | null = null;
  snapshot: ManagedVolumeResult;
  closePromise: Promise<void> | null = null;
  opening: Promise<void> | null = null;
  closing = false;
  wasReady = false;
  unsubscribe: (() => void) | null = null;
  readonly abort = new AbortController();
  readonly closeResult = () => this.close();
  #lastStatusError: ClientStatus['error'] = null;
  #statusVolumeError: VolumeError | null = null;

  constructor(
    readonly fileName: string,
    readonly identity: string,
  ) {
    this.snapshot = pendingManaged(this.closeResult);
  }

  attach(binding: VolumeBinding) {
    this.bindings.add(binding);
    binding.initial(this);
  }
  detach(binding: VolumeBinding) {
    this.bindings.delete(binding);
  }

  start(input: ManagedInput) {
    this.opening = this.open(input).finally(() => {
      this.opening = null;
    });
  }

  private async open(input: ManagedInput) {
    const support = getSupport();
    if (!support.supported) {
      if (registry.get(this.fileName) === this) registry.delete(this.fileName);
      this.publish(
        Object.freeze({
          ...pendingState(),
          status: 'unsupported',
          error: new VolumeError({
            kind: 'unsupported',
            operation: 'open',
            volume: this.fileName,
            outcome: 'not-applied',
            message: 'This browser does not support the required OPFS VFS capabilities',
          }),
          missingCapabilities: support.missing,
          ownership: 'managed' as const,
          close: this.closeResult,
        }),
      );
      return;
    }
    try {
      const client = await openOpfsVfsWorker(this.fileName, {
        ...input.options,
        worker: input.worker,
        observerProtocol: input.observerProtocol,
        plugins: input.plugins,
        transport: input.transport,
        ...(input.sharedWorker ? { sharedWorker: input.sharedWorker } : {}),
        signal: this.abort.signal,
      });
      if (this.closing || registry.get(this.fileName) !== this) {
        await client.closeVfs().catch(() => {});
        client.dispose();
        return;
      }
      this.client = client;
      this.store = clientStore(client);
      this.unsubscribe = client.subscribeStatus(() => this.refresh());
      this.refresh();
    } catch (cause) {
      if (this.closing) return;
      if (registry.get(this.fileName) === this) registry.delete(this.fileName);
      const openError = toVolumeError(cause, { operation: 'open', volume: this.fileName, mutation: false });
      const details = openError.details;
      const unsupported = details?.code === 'VFS_UNSUPPORTED';
      this.client?.dispose();
      this.client = null;
      this.store = null;
      this.publish(
        Object.freeze({
          ...pendingState(),
          status: unsupported ? 'unsupported' : 'error',
          transport: input.transport === 'shared-worker' ? 'shared-worker' : null,
          error: new VolumeError({
            kind: unsupported ? 'unsupported' : openError.kind,
            operation: 'open',
            volume: this.fileName,
            details,
            outcome: unsupported ? 'not-applied' : openError.outcome,
            cause,
          }),
          ownership: 'managed' as const,
          close: this.closeResult,
        }),
      );
    }
  }

  refresh() {
    if (!this.client || this.closing) return;
    const status = this.client.getStatus();
    const errorFor = (details: NonNullable<ClientStatus['error']>, operation: string) => {
      if (details !== this.#lastStatusError) {
        this.#lastStatusError = details;
        this.#statusVolumeError = lifecycleError(
          details,
          status.state === 'failed' ? (this.wasReady ? 'lifecycle' : 'open') : operation,
          this.fileName,
        );
      }
      return this.#statusVolumeError!;
    };
    this.ownerGeneration = status.state === 'ready' ? status.ownerGeneration : null;
    if (status.state === 'ready') this.wasReady = true;
    const next = resultFrom(status, 'managed', this.store, errorFor, this.closeResult) as ManagedVolumeResult;
    if (status.state === 'failed' || status.state === 'closed') {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.client.dispose();
      this.client = null;
      this.store = null;
      this.ownerGeneration = null;
      if (registry.get(this.fileName) === this) registry.delete(this.fileName);
    }
    this.publish(next);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (
      this.snapshot.status === 'unsupported' ||
      this.snapshot.status === 'error' ||
      (this.snapshot.status === 'closed' && !this.snapshot.isClosing)
    )
      return (this.closePromise = Promise.resolve());
    this.closing = true;
    this.abort.abort();
    this.closePromise = (this.opening ?? Promise.resolve()).then(() => {
      const client = this.client;
      return client
        ? client.closeVfs().then(
            () => this.#finishClose(null),
            (cause) => {
              const error = toVolumeError(cause, { operation: 'close', volume: this.fileName, mutation: true });
              this.#finishClose(error);
              throw error;
            },
          )
        : this.#finishClose(null);
    });
    this.publish(
      Object.freeze({
        ...pendingState(),
        transport: this.snapshot.transport,
        fallbackReason: this.snapshot.fallbackReason,
        status: 'closed',
        ownership: 'managed' as const,
        close: this.closeResult,
        isClosing: true,
      }),
    );
    return this.closePromise;
  }

  #finishClose(error: VolumeError | null) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client = null;
    this.store = null;
    this.ownerGeneration = null;
    if (registry.get(this.fileName) === this) registry.delete(this.fileName);
    this.publish(
      Object.freeze({
        ...pendingState(),
        transport: this.snapshot.transport,
        fallbackReason: this.snapshot.fallbackReason,
        status: 'closed',
        error,
        ownership: 'managed' as const,
        close: this.closeResult,
      }),
    );
  }

  private publish(next: ManagedVolumeResult) {
    if (sameSnapshot(this.snapshot, next)) return;
    this.snapshot = next;
    const changed = [...this.bindings].filter((binding) => binding.changed(this));
    for (const binding of changed) binding.notify();
    for (const binding of changed) binding.reportSnapshotError();
  }
}

class BorrowedSource implements Source {
  readonly bindings = new Set<VolumeBinding>();
  readonly store: ClientStore;
  ownerGeneration: string | null = null;
  snapshot: BorrowedVolumeResult;
  #unsubscribe: (() => void) | null = null;
  #lastStatusError: ClientStatus['error'] = null;
  #statusVolumeError: VolumeError | null = null;
  #wasReady = false;

  constructor(readonly client: OpfsVfsWorkerClient) {
    this.store = clientStore(client);
    this.snapshot = pendingBorrowed();
  }

  attach(binding: VolumeBinding) {
    if (!this.#unsubscribe) this.#unsubscribe = this.client.subscribeStatus(() => this.#refresh());
    this.#refresh();
    this.bindings.add(binding);
    binding.initial(this);
  }
  detach(binding: VolumeBinding) {
    this.bindings.delete(binding);
    if (!this.bindings.size) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
    }
  }

  #refresh() {
    const status = this.client.getStatus();
    const errorFor = (details: NonNullable<ClientStatus['error']>, operation: string) => {
      if (details !== this.#lastStatusError) {
        this.#lastStatusError = details;
        this.#statusVolumeError = lifecycleError(
          details,
          status.state === 'failed' ? (this.#wasReady ? 'lifecycle' : 'open') : operation,
          status.fileName,
        );
      }
      return this.#statusVolumeError!;
    };
    this.ownerGeneration = status.state === 'ready' ? status.ownerGeneration : null;
    if (status.state === 'ready') this.#wasReady = true;
    const next = resultFrom(status, 'borrowed', this.store, errorFor) as BorrowedVolumeResult;
    if (sameSnapshot(this.snapshot, next)) return;
    this.snapshot = next;
    const changed = [...this.bindings].filter((binding) => binding.changed(this));
    for (const binding of changed) binding.notify();
    for (const binding of changed) binding.reportSnapshotError();
  }
}

const borrowedSources = new WeakMap<OpfsVfsWorkerClient, BorrowedSource>();
const registry = new Map<string, ManagedEntry>();

function pendingState(): VolumeState {
  return {
    status: 'pending',
    error: null,
    missingCapabilities: EMPTY_CAPABILITIES,
    role: null,
    generation: null,
    persistence: null,
    transport: null,
    fallbackReason: null,
    isClosing: false,
  };
}
function pendingManaged(close: () => Promise<void>): ManagedVolumeResult {
  return Object.freeze({ ...pendingState(), ownership: 'managed' as const, close });
}
function pendingBorrowed(): BorrowedVolumeResult {
  return Object.freeze({ ...pendingState(), ownership: 'borrowed' as const });
}

function acquireManaged(binding: VolumeBinding, input: ManagedInput) {
  let entry = registry.get(input.fileName);
  entry?.refresh();
  entry = registry.get(input.fileName);
  if (entry) {
    if (!entry.closing && entry.identity !== input.identity) {
      binding.conflictWith(
        configurationError(
          'configure',
          input.fileName,
          `Volume ${input.fileName} is already open with different configuration; use a keyed remount after close`,
        ),
      );
      return;
    }
    entry.attach(binding);
    return;
  }
  entry = new ManagedEntry(input.fileName, input.identity);
  registry.set(input.fileName, entry);
  entry.attach(binding);
  entry.start(input);
}

export function useVolumeBinding(name?: VolumeName): VolumeBinding {
  const key = validateName(name, 'lookup', null);
  let link = useContext(Context);
  while (link) {
    if (link.name === key) return link.binding;
    link = link.parent;
  }
  const label = typeof key === 'string' ? JSON.stringify(key) : String(key);
  throw configurationError('lookup', null, `No volume provider found for ${label}`);
}

/** Provides one managed or caller-owned OPFS VFS volume to its subtree. */
export function VolumeProvider(props: VolumeProviderProps): ReactNode {
  const input = validateInput(props);
  const name = validateName(props.name, 'configure', input.fileName);
  const parent = useContext(Context);
  const [binding] = useState(() => new VolumeBinding(input.kind, input.identity, input.fileName));
  if (binding.kind !== input.kind || binding.identity !== input.identity)
    throw configurationError('configure', input.fileName, 'Changing volume identity requires a keyed remount');
  const holder: InputHolder = {
    input: binding.consumed ? null : input.kind === 'managed' ? input : { kind: 'borrowed', client: input.client },
  };
  if (binding.conflict) throw binding.conflict;
  useEffect(() => {
    binding.onError = props.onError ?? null;
  });
  useEffect(() => {
    if (props.persistentStorage === 'request-on-mount') requestPersistentStorageOnMount();
  }, [props.persistentStorage]);
  useEffect(() => binding.attach(holder), [binding]);
  const result = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getServerSnapshot);
  const link = useMemo(() => Object.freeze({ name, binding, parent }), [name, binding, parent]);
  return (
    <Context value={link}>{typeof props.children === 'function' ? props.children(result) : props.children}</Context>
  );
}

/** Returns the current lifecycle state for the selected volume. */
export function useVolume(name?: VolumeName): VolumeResult {
  const binding = useVolumeBinding(name);
  return useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getServerSnapshot);
}

/** Returns a generation-pinned command handle while the selected volume is ready. */
export function useVolumeClient(name?: VolumeName): VolumeClient | null {
  const binding = useVolumeBinding(name);
  useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getServerSnapshot);
  return binding.volumeClient();
}

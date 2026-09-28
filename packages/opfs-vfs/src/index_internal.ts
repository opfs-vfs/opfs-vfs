// @ts-expect-error Vite worker import with query string
import VfsWorker from './worker?worker&inline';
// @ts-expect-error Vite SharedWorker import with query string
import DefaultSharedWorker from './default-shared-worker?sharedworker';
import { OpfsVfsWorkerClient, type OpfsVfsWorkerClientOptions, type VfsWorkerFactory } from './worker-client';
import { createVfsError } from './fs-errors';
import { getSupport } from './support';
import { createSharedWorkerFollower, probeSharedWorker, type SharedWorkerFactory } from './shared-worker';
import { mountProfileMismatch, preparePluginRequests } from './worker-plugins';
export {
  createSharedWorkerFollower,
  probeSharedWorker,
  startVfsSharedWorker,
  type SharedWorkerFactory,
} from './shared-worker';

export { getSupport, type VfsSupport, type VfsSupportRequirement } from './support';
export {
  GENERATION_METHODS,
  VfsCommandError,
  type ClientStatus,
  type ClientPersistenceStatus,
  type ClientFallbackReason,
  type ClientStatusState,
  type GenerationClient,
  type GenerationMethod,
  type RemoteErrorDetails,
  type VfsDispatch,
} from './worker-client';

export interface OpfsVfsWorkerOptions extends OpfsVfsWorkerClientOptions {
  /** Create a fresh application worker for each ownership acquisition. */
  worker?: VfsWorkerFactory;
  /** Enable passive observers for an application worker that supports the bundled protocol. */
  observerProtocol?: boolean;
}
export type { VfsWorkerFactory } from './worker-client';

export type OpenOpfsVfsWorkerOptions = Omit<OpfsVfsWorkerOptions, 'transport' | 'fallbackReason'> & {
  /** `auto` prefers a compatible SharedWorker and otherwise keeps a dedicated worker. */
  transport?: 'auto' | 'dedicated' | 'shared-worker';
  /** Required for SharedWorker mounts with application workers or plugins. */
  sharedWorker?: SharedWorkerFactory;
  /** Cancels transport discovery and SharedWorker attachment. */
  signal?: AbortSignal;
};

const defaultSharedWorker: SharedWorkerFactory = (fileName) =>
  new DefaultSharedWorker({ type: 'module', name: `opfs-vfs-${fileName}` }) as SharedWorker;

const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

async function hasCompatibleDedicatedOwner(
  fileName: string,
  options: OpfsVfsWorkerOptions,
  signal?: AbortSignal,
): Promise<'compatible' | 'none'> {
  if (signal?.aborted) throw abortError(signal);
  const held =
    typeof navigator.locks.query === 'function'
      ? navigator.locks
          .query()
          .then((locks) => (locks.held ?? []).some((lock) => lock.name === `opfs-vfs-lock-${fileName}`))
      : navigator.locks.request(`opfs-vfs-lock-${fileName}`, { ifAvailable: true }, (lock) => lock === null);
  if (!(await held)) return 'none';
  const expected = preparePluginRequests(options.plugins, options.openMode, fileName).profile;
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
    const finish = (value?: 'compatible' | 'none', error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      channel.close();
      if (error === undefined) resolve(value!);
      else reject(error);
    };
    const abort = () => finish(undefined, abortError(signal!));
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          Object.assign(new Error('Existing volume owner did not become ready'), {
            code: 'VFS_INITIALIZATION_TIMEOUT',
          }),
        ),
      options.initTimeout || 15_000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    channel.onmessage = ({ data }) => {
      if (data?.type !== 'LEADER_READY' || typeof data.generation !== 'string') return;
      const mismatch = mountProfileMismatch(data.profile, expected);
      if (mismatch === undefined) finish('compatible');
      else if (data.profile?.transport === 'shared-worker') finish('none');
      else
        finish(
          undefined,
          Object.assign(new Error('Existing dedicated owner profile is incompatible'), { code: mismatch, fileName }),
        );
    };
    if (signal?.aborted) return abort();
    channel.postMessage({ type: 'LEADER_PING' });
  });
}

/** Open once with a transport fixed for the lifetime of the returned client. */
export async function openOpfsVfsWorker(
  fileName = 'pgdata.bin',
  options: OpenOpfsVfsWorkerOptions = {},
): Promise<OpfsVfsWorkerClient> {
  const { transport = 'auto', sharedWorker, signal, ...workerOptions } = options;
  const { worker: dedicatedWorker, observerProtocol: _observerProtocol, ...sharedOptions } = workerOptions;
  if (transport !== 'auto' && transport !== 'dedicated' && transport !== 'shared-worker')
    throw createVfsError('EINVAL', fileName, 'transport must be auto, dedicated, or shared-worker');
  if (transport !== 'dedicated' && workerOptions.forceLeader)
    throw createVfsError('EINVAL', fileName, 'forceLeader requires dedicated transport');
  if (sharedWorker !== undefined && typeof sharedWorker !== 'function')
    throw createVfsError('EINVAL', fileName, 'SharedWorker must be a factory');
  if (signal?.aborted) throw abortError(signal);
  const support = getSupport();
  if (!support.supported)
    throw Object.assign(new Error(`Unsupported VFS requirements: ${support.missing.join(', ')}`), {
      code: 'VFS_UNSUPPORTED',
      missing: support.missing,
    });
  if (transport === 'dedicated') return new OpfsVfsWorker(fileName, workerOptions);

  const needsApplicationWorker = dedicatedWorker !== undefined || (workerOptions.plugins?.length ?? 0) > 0;
  const factory = sharedWorker ?? (needsApplicationWorker ? undefined : defaultSharedWorker);
  if (!factory) {
    if (transport === 'shared-worker')
      throw createVfsError('EINVAL', fileName, 'SharedWorker transport requires an application SharedWorker factory');
    return new OpfsVfsWorker(fileName, { ...workerOptions, fallbackReason: 'shared-worker-factory-unavailable' });
  }
  if (transport === 'auto' && (await hasCompatibleDedicatedOwner(fileName, workerOptions, signal)) === 'compatible')
    return new OpfsVfsWorker(fileName, { ...workerOptions, fallbackReason: 'existing-dedicated-owner' });
  if (typeof SharedWorker !== 'function') {
    if (transport === 'shared-worker')
      throw Object.assign(new Error('SharedWorker is unavailable'), { code: 'VFS_UNSUPPORTED' });
    return new OpfsVfsWorker(fileName, { ...workerOptions, fallbackReason: 'shared-worker-api-unavailable' });
  }
  const supported = await probeSharedWorker(fileName, factory, signal, workerOptions.initTimeout || 15_000);
  if (!supported) {
    if (transport === 'shared-worker')
      throw Object.assign(new Error('SharedWorker sync access handles are unavailable'), { code: 'VFS_UNSUPPORTED' });
    return new OpfsVfsWorker(fileName, { ...workerOptions, fallbackReason: 'shared-worker-sync-handle-unavailable' });
  }
  return createSharedWorkerFollower(fileName, sharedOptions, factory, signal);
}

/** Worker client using the bundled worker or an application-owned worker factory. */
export class OpfsVfsWorker extends OpfsVfsWorkerClient {
  private readonly bundled: boolean;
  protected override get standardWorker(): boolean {
    return this.bundled;
  }

  constructor(fileName = 'pgdata.bin', options: OpfsVfsWorkerOptions = {}) {
    options = { ...options };
    if (options.plugins?.length && !options.worker) {
      throw createVfsError('EINVAL', fileName, 'Plugin requests require an application worker');
    }
    if (options.worker !== undefined && typeof options.worker !== 'function') {
      throw createVfsError('EINVAL', fileName, 'Worker must be a factory');
    }
    if (options.observerProtocol !== undefined && typeof options.observerProtocol !== 'boolean') {
      throw createVfsError('EINVAL', fileName, 'observerProtocol must be a boolean');
    }
    if (options.attachTo !== undefined && options.worker) {
      throw createVfsError('EINVAL', fileName, 'Passive attachments use the bundled worker profile');
    }
    const { observerProtocol, ...clientOptions } = options;
    super(fileName, clientOptions, options.worker ?? (() => new VfsWorker()));
    this.bundled = options.worker === undefined || observerProtocol === true;
  }
}

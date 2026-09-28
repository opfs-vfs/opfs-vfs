import { parseRemoteError, reviveRemoteError, serializeRemoteError } from './remote-error';
import { OpfsVfsWorkerClient, type OpfsVfsWorkerClientOptions, type VfsWorkerEndpoint } from './worker-client';
import { startVfsWorker } from './worker-runtime';
import {
  createSharedMountProfile,
  preparePluginRequests,
  sharedMountProfileMismatch,
  type SharedMountProfile,
} from './worker-plugins';
import type { VfsPluginRegistration, VfsPluginRequest } from './plugins';

type Attach = {
  readonly type: 'ATTACH';
  readonly version: 1;
  readonly clientId: string;
  readonly fileName: string;
  readonly options: OpfsVfsWorkerClientOptions;
  readonly plugins: readonly VfsPluginRequest[];
  readonly profile: SharedMountProfile;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const attach = (value: unknown): Attach | null => {
  if (!record(value) || Reflect.ownKeys(value).length !== 7) return null;
  const { type, version, clientId, fileName, options, plugins, profile } = value;
  return type === 'ATTACH' &&
    version === 1 &&
    typeof clientId === 'string' &&
    clientId.length > 0 &&
    clientId.length <= 128 &&
    typeof fileName === 'string' &&
    fileName &&
    record(options) &&
    Array.isArray(plugins) &&
    record(profile)
    ? (value as Attach)
    : null;
};

function portWorker(port: MessagePort, close: () => void): VfsWorkerEndpoint {
  port.start();
  return {
    postMessage: (message, transfer) =>
      Array.isArray(transfer) ? port.postMessage(message, transfer) : port.postMessage(message, transfer),
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => port.addEventListener(type, listener, options),
    removeEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => port.removeEventListener(type, listener, options),
    terminate: close,
    get onmessage() {
      return port.onmessage as ((event: MessageEvent) => void) | null;
    },
    set onmessage(listener) {
      port.onmessage = listener as ((this: MessagePort, event: MessageEvent) => unknown) | null;
    },
    get onerror() {
      return null as ((event: ErrorEvent) => unknown) | null;
    },
    set onerror(listener) {
      port.onmessageerror = listener as unknown as ((this: MessagePort, event: MessageEvent) => unknown) | null;
    },
  };
}

/** Entry point for a stable application SharedWorker module. */
export function startVfsSharedWorker({ plugins = [] }: { plugins?: readonly VfsPluginRegistration[] } = {}) {
  const scope = self as unknown as SharedWorkerGlobalScope;
  let owner: OpfsVfsWorkerClient | undefined;
  let profile: SharedMountProfile | undefined;
  let ownerFileName: string | undefined;
  let starting: Promise<void> | undefined;
  let startingOwner: OpfsVfsWorkerClient | undefined;
  const pendingAttaches = new Set<string>();
  const committedAttaches = new Set<string>();
  const reservationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let cancelledStart = false;
  let closing = false;
  let probeResult: Promise<boolean> | undefined;
  const fatal = () => {
    if (closing) return;
    closing = true;
    setTimeout(() => scope.close(), 0);
  };
  const releaseReservation = (clientId: string) => {
    pendingAttaches.delete(clientId);
    const timer = reservationTimers.get(clientId);
    if (timer) clearTimeout(timer);
    reservationTimers.delete(clientId);
    if (pendingAttaches.size || committedAttaches.size) return;
    cancelledStart = true;
    closing = true;
    if (owner) {
      const stale = owner;
      owner = undefined;
      profile = undefined;
      ownerFileName = undefined;
      void stale
        .closeVfs()
        .catch(() => stale.dispose())
        .finally(() => scope.close());
    } else {
      startingOwner?.dispose();
      setTimeout(() => scope.close(), 0);
    }
  };
  const start = async (request: Attach) => {
    if (typeof navigator.storage?.getDirectory !== 'function')
      throw Object.assign(new Error('OPFS is unavailable'), { code: 'VFS_UNSUPPORTED' });
    if (
      typeof FileSystemFileHandle === 'undefined' ||
      typeof FileSystemFileHandle.prototype.createSyncAccessHandle !== 'function'
    )
      throw Object.assign(new Error('SharedWorker cannot create sync access handles'), { code: 'VFS_UNSUPPORTED' });
    const prepared = preparePluginRequests(request.plugins, request.options.openMode, request.fileName);
    const expected = createSharedMountProfile(prepared.requests);
    const mismatch = sharedMountProfileMismatch(request.profile, expected);
    if (mismatch) throw Object.assign(new Error('SharedWorker profile mismatch'), { code: mismatch });
    const channel = new MessageChannel();
    startVfsWorker({ plugins, endpoint: channel.port1 });
    const next = new OpfsVfsWorkerClient(
      request.fileName,
      { ...request.options, plugins: prepared.requests, sharedHost: true, claimIfAvailable: true },
      () => portWorker(channel.port2, () => channel.port2.close()),
    );
    startingOwner = next;
    next.subscribeStatus(() => {
      const state = next.getStatus().state;
      if ((state === 'failed' || state === 'closed') && !cancelledStart) fatal();
    });
    await next.ready;
    startingOwner = undefined;
    if (pendingAttaches.size === 0) {
      await next.closeVfs().catch(() => next.dispose());
      return;
    }
    owner = next;
    profile = expected;
    ownerFileName = request.fileName;
  };
  scope.onconnect = ({ ports }) => {
    const port = ports[0];
    if (!port) return;
    let attached = false;
    let attachClientId: string | undefined;
    port.start();
    port.onmessageerror = () => port.close();
    port.onmessage = async ({ data }) => {
      if (record(data) && data.type === 'CANCEL' && typeof data.clientId === 'string') {
        if (data.clientId !== attachClientId) return;
        releaseReservation(data.clientId);
        port.close();
        return;
      }
      if (record(data) && data.type === 'COMMIT' && typeof data.clientId === 'string') {
        if (data.clientId !== attachClientId || !pendingAttaches.delete(data.clientId)) return;
        const timer = reservationTimers.get(data.clientId);
        if (timer) clearTimeout(timer);
        reservationTimers.delete(data.clientId);
        committedAttaches.add(data.clientId);
        return;
      }
      const requestProbe = probe(data);
      if (requestProbe) {
        try {
          if (closing) throw Object.assign(new Error('SharedWorker is shutting down'), { code: 'VFS_SHUTTING_DOWN' });
          const supported = starting
            ? await starting.then(() => {
                const state = owner?.getStatus().state;
                if (closing || state === 'closing')
                  throw Object.assign(new Error('SharedWorker is shutting down'), { code: 'VFS_SHUTTING_DOWN' });
                if (state !== 'ready')
                  throw Object.assign(new Error('SharedWorker owner is unavailable'), { code: 'VFS_ATTACHMENT_LOST' });
                return true;
              })
            : await (probeResult ??= probeSyncAccessHandle()).catch((error) => {
                probeResult = undefined;
                throw error;
              });
          port.postMessage({ type: 'PROBE_RESULT', id: requestProbe.id, supported });
        } catch (error) {
          port.postMessage({ type: 'ERROR', id: requestProbe.id, error: serializeRemoteError(error) });
        } finally {
          port.close();
        }
        return;
      }
      if (attached) {
        try {
          port.postMessage({
            type: 'ERROR',
            error: serializeRemoteError(
              Object.assign(new Error('SharedWorker accepts one ATTACH per port'), { code: 'EINVAL' }),
            ),
          });
        } finally {
          port.close();
        }
        return;
      }
      attached = true;
      const request = attach(data);
      if (!request) {
        try {
          port.postMessage({
            type: 'ERROR',
            error: serializeRemoteError(Object.assign(new Error('Invalid SharedWorker attach'), { code: 'EINVAL' })),
          });
        } finally {
          port.close();
        }
        return;
      }
      if (closing) {
        port.postMessage({
          type: 'ERROR',
          error: serializeRemoteError(
            Object.assign(new Error('SharedWorker is shutting down'), { code: 'VFS_SHUTTING_DOWN' }),
          ),
        });
        port.close();
        return;
      }
      pendingAttaches.add(request.clientId);
      attachClientId = request.clientId;
      reservationTimers.set(
        request.clientId,
        setTimeout(() => releaseReservation(request.clientId), request.options.initTimeout || 15_000),
      );
      try {
        if (!starting) {
          cancelledStart = false;
          starting = start(request).finally(() => {
            startingOwner = undefined;
            if (!owner) starting = undefined;
          });
        }
        await starting;
        if (!pendingAttaches.has(request.clientId)) return;
        if (ownerFileName !== request.fileName)
          throw Object.assign(new Error('SharedWorker volume mismatch'), { code: 'VFS_PROTOCOL_MISMATCH' });
        const mismatch = profile && sharedMountProfileMismatch(request.profile, profile);
        if (mismatch) throw Object.assign(new Error('SharedWorker profile mismatch'), { code: mismatch });
        const status = owner?.getStatus();
        if (status?.state === 'closing')
          throw Object.assign(new Error('SharedWorker is shutting down'), { code: 'VFS_SHUTTING_DOWN' });
        const generation = status?.ownerGeneration;
        if (status?.state !== 'ready' || !generation || !profile)
          throw Object.assign(new Error('SharedWorker owner is unavailable'), { code: 'VFS_ATTACHMENT_LOST' });
        port.postMessage({ type: 'READY', generation, profile });
        const timer = reservationTimers.get(request.clientId);
        if (timer) clearTimeout(timer);
        reservationTimers.set(
          request.clientId,
          setTimeout(() => releaseReservation(request.clientId), request.options.initTimeout || 15_000),
        );
      } catch (error) {
        releaseReservation(request.clientId);
        port.postMessage({ type: 'ERROR', error: serializeRemoteError(error) });
        // A rejected first mount poisons this named worker. Deliver the typed
        // refusal first, then let a later page create a fresh instance.
        if (!owner && !cancelledStart) setTimeout(fatal, 0);
      }
    };
  };
}

export type SharedWorkerEndpoint = {
  readonly port: MessagePort;
  onerror: ((event: ErrorEvent) => unknown) | null;
};

export type SharedWorkerFactory = (fileName: string) => SharedWorkerEndpoint;

type Probe = { readonly type: 'PROBE'; readonly version: 1; readonly id: string };
const probe = (value: unknown): Probe | null =>
  record(value) &&
  Reflect.ownKeys(value).length === 3 &&
  value.type === 'PROBE' &&
  value.version === 1 &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  value.id.length <= 128
    ? (value as Probe)
    : null;

const probeSyncAccessHandle = async () => {
  if (typeof navigator.storage?.getDirectory !== 'function')
    throw Object.assign(new Error('OPFS is unavailable'), { code: 'VFS_UNSUPPORTED' });
  if (
    typeof FileSystemFileHandle === 'undefined' ||
    typeof FileSystemFileHandle.prototype.createSyncAccessHandle !== 'function'
  )
    return false;
  const name = `opfs-vfs-probe-${crypto.randomUUID()}`;
  const root = await navigator.storage.getDirectory();
  let handle: FileSystemSyncAccessHandle | undefined;
  try {
    handle = await root.getFileHandle(name, { create: true }).then((file) => file.createSyncAccessHandle());
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') return false;
    throw error;
  } finally {
    try {
      handle?.close();
    } finally {
      await root.removeEntry(name).catch((error) => {
        if (error instanceof DOMException && error.name === 'NotFoundError') return;
        throw error;
      });
    }
  }
};

/** Probe a fresh SharedWorker port without mounting a named volume. */
export function probeSharedWorker(
  fileName: string,
  worker: SharedWorkerFactory,
  signal?: AbortSignal,
  timeout = 15_000,
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const shared = worker(fileName);
  const port = shared.port;
  const id = crypto.randomUUID();
  port.start();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (result?: boolean, error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      port.onmessage = null;
      port.onmessageerror = null;
      shared.onerror = null;
      port.close();
      if (error === undefined) resolve(result!);
      else reject(error);
    };
    const abort = () => finish(undefined, signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          Object.assign(new Error('SharedWorker probe timed out'), { code: 'VFS_INITIALIZATION_TIMEOUT' }),
        ),
      timeout,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    port.onmessageerror = () =>
      finish(undefined, Object.assign(new Error('SharedWorker probe failed'), { code: 'VFS_WORKER_FAILED' }));
    shared.onerror = () =>
      finish(undefined, Object.assign(new Error('SharedWorker probe failed'), { code: 'VFS_WORKER_FAILED' }));
    port.onmessage = ({ data }) => {
      if (!record(data) || data.id !== id) return;
      if (data.type === 'PROBE_RESULT' && typeof data.supported === 'boolean') finish(data.supported);
      else if (data.type === 'ERROR') {
        const error = parseRemoteError(data.error);
        finish(undefined, error ? reviveRemoteError(error) : new Error('Invalid SharedWorker probe response'));
      } else finish(undefined, new Error('Invalid SharedWorker probe response'));
    };
    try {
      port.postMessage({ type: 'PROBE', version: 1, id });
    } catch (error) {
      finish(undefined, error);
    }
  });
}

/** Bootstrap a page follower before it enters the existing BroadcastChannel route. */
export async function createSharedWorkerFollower(
  fileName: string,
  options: OpfsVfsWorkerClientOptions,
  worker: SharedWorkerFactory,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const prepared = preparePluginRequests(options.plugins, options.openMode, fileName);
  const profile = createSharedMountProfile(prepared.requests);
  const shared = worker(fileName);
  const port = shared.port;
  const clientId = crypto.randomUUID();
  let committed = false;
  const cancelReservation = () => {
    if (committed) return;
    try {
      port.postMessage({ type: 'CANCEL', clientId });
    } catch {
      // Closing the local port remains sufficient when the host has already gone away.
    }
  };
  port.start();
  const bootstrap = await new Promise<{ generation: string; profile: SharedMountProfile }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      port.onmessage = null;
      port.onmessageerror = null;
      shared.onerror = null;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      port.close();
      reject(error);
    };
    const cancel = cancelReservation;
    const abort = () => {
      cancel();
      fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      cancel();
      fail(Object.assign(new Error('SharedWorker bootstrap timed out'), { code: 'VFS_INITIALIZATION_TIMEOUT' }));
    }, options.initTimeout || 15_000);
    port.onmessageerror = () =>
      fail(Object.assign(new Error('SharedWorker bootstrap failed'), { code: 'VFS_WORKER_FAILED' }));
    shared.onerror = () =>
      fail(Object.assign(new Error('SharedWorker bootstrap failed'), { code: 'VFS_WORKER_FAILED' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    port.onmessage = ({ data }) => {
      if (!record(data)) return;
      if (data.type === 'ERROR') {
        const error = parseRemoteError(data.error);
        fail(
          error
            ? reviveRemoteError(error)
            : Object.assign(new Error('SharedWorker bootstrap failed'), { code: 'VFS_WORKER_FAILED' }),
        );
        return;
      }
      if (data.type !== 'READY' || typeof data.generation !== 'string') return;
      const mismatch = sharedMountProfileMismatch(data.profile, profile);
      if (mismatch) fail(Object.assign(new Error('SharedWorker profile mismatch'), { code: mismatch }));
      else {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ generation: data.generation, profile });
      }
    };
    try {
      port.postMessage({
        type: 'ATTACH',
        version: 1,
        clientId,
        fileName,
        options,
        plugins: prepared.requests,
        profile,
      });
    } catch (error) {
      fail(error);
    }
  });
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const client = new OpfsVfsWorkerClient(
      fileName,
      {
        ...options,
        transport: 'shared-worker',
        plugins: prepared.requests,
        followerOnly: bootstrap,
        attachmentId: clientId,
        transportClose: () => {
          cancelReservation();
          port.close();
        },
      },
      () => {
        throw new Error('SharedWorker followers never spawn a dedicated worker');
      },
    );
    const commit = () => {
      if (committed) return;
      try {
        port.postMessage({ type: 'COMMIT', clientId });
        committed = true;
        signal?.removeEventListener('abort', abortBeforeCommit);
      } catch {
        client.dispose();
      }
    };
    const abortBeforeCommit = () => {
      cancelReservation();
      client.dispose();
    };
    signal?.addEventListener('abort', abortBeforeCommit, { once: true });
    if (signal?.aborted) abortBeforeCommit();
    else void client.ready.then(commit, abortBeforeCommit);
    return client;
  } catch (error) {
    cancelReservation();
    port.close();
    throw error;
  }
}

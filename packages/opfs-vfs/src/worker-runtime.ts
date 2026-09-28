import { createVfsError } from './fs-errors';
import { serializeRemoteError } from './remote-error';
import { MAX_WHOLE_FILE_BYTES, OpfsVfs, OpenFlags, type OpfsVfsOptions, type WriteFileBufferOptions } from './opfs-vfs';
import { assertUnclaimedConfiguredPlugins, validateConfiguredPlugins, validatedPluginOptions } from './plugin-config';
import type { ConfiguredVfsPlugin, VfsPluginRegistration } from './plugins';
import { SyncMessenger } from './sync-messenger';
import { closeVolume, volumeFileNames } from './volume-files';
import { shouldLogWorkerError } from './worker-errors';
import { createMountProfile, isValidPluginId, preparePluginRequests } from './worker-plugins';
import { markMountReplacement, mountGenerations, persistenceSources, workerChangeOpeners } from './mount-context';
import type { ChangeCommand, ChangeFrame, FileChangeChannel } from './changes';
import { encodePersistenceFrame, PERSISTENCE_FRAME, PERSISTENCE_STATUS } from './persistence-status';

export type WorkerInitPayload = Record<string, unknown>;

type WorkerEndpoint = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: StructuredSerializeOptions | Transferable[]): void;
};
let endpoint: WorkerEndpoint;

let vfs: OpfsVfs | null = null;
let messenger: SyncMessenger | null = null;
let debugEnabled = false;
let started = false;
// SAB-6: track the live listen() loop so a re-INIT can cancel the previous one
// instead of leaking a second loop running against the old SAB.
let listenAbort: AbortController | null = null;
let initialized = false;
let initializedGeneration: string | null = null;
let initInFlight = false;
let activeGeneration: string | null = null;
type PersistenceEmitter = {
  readonly mount: OpfsVfs;
  readonly generation: string;
  sequence: number;
  enabled: boolean;
  queued: boolean;
  last?: { state: string; failureRevision: number };
};
let persistenceEmitter: PersistenceEmitter | undefined;
let repliesInFlight = 0;
type ChangeRoute = 'local' | 'follower-relay';
type RuntimeChangeChannel = {
  readonly mount: OpfsVfs;
  readonly generation: string;
  readonly clientId: string;
  readonly channelId: string;
  readonly route: ChangeRoute;
  state: 'opening' | 'open' | 'closed';
  channel?: FileChangeChannel;
};
const changeChannels = new Map<string, RuntimeChangeChannel>();
const changeChannelCounts = new Map<string, number>();

const changeChannelKey = (clientId: string, channelId: string) => JSON.stringify([clientId, channelId]);
const validChangeId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;

function clearChangeChannels() {
  changeChannels.clear();
  changeChannelCounts.clear();
}

function releaseChangeChannel(entry: RuntimeChangeChannel) {
  const key = changeChannelKey(entry.clientId, entry.channelId);
  if (changeChannels.get(key) !== entry) return;
  changeChannels.delete(key);
  const count = changeChannelCounts.get(entry.clientId) ?? 1;
  if (count <= 1) changeChannelCounts.delete(entry.clientId);
  else changeChannelCounts.set(entry.clientId, count - 1);
}

function isCurrentChangeChannel(entry: RuntimeChangeChannel) {
  return (
    entry.state === 'open' &&
    changeChannels.get(changeChannelKey(entry.clientId, entry.channelId)) === entry &&
    vfs === entry.mount &&
    activeGeneration === entry.generation
  );
}

function persistenceFrame(emitter: PersistenceEmitter, forced = false) {
  emitter.queued = false;
  if (vfs !== emitter.mount || activeGeneration !== emitter.generation) return;
  const source = persistenceSources.get(emitter.mount)?.read();
  if (
    !source ||
    (!forced && emitter.last?.state === source.state && emitter.last.failureRevision === source.failureRevision)
  )
    return;
  const payload = encodePersistenceFrame(emitter.generation, ++emitter.sequence, source);
  emitter.last = { state: source.state, failureRevision: source.failureRevision };
  return payload;
}

function postPersistence(emitter: PersistenceEmitter) {
  if (repliesInFlight > 0) return;
  const payload = persistenceFrame(emitter);
  if (!payload) return;
  try {
    endpoint.postMessage({ type: PERSISTENCE_FRAME, payload });
  } catch {
    // A failed recipient cannot affect the mounted volume.
  }
}

function createPersistenceEmitter(mount: OpfsVfs, generation: string) {
  const emitter: PersistenceEmitter = { mount, generation, sequence: 0, enabled: false, queued: false };
  persistenceEmitter = emitter;
  persistenceSources.get(mount)?.watch(() => {
    if (!emitter.enabled || emitter.queued) return;
    emitter.queued = true;
    // One frame per turn. Replies go first; SAB and timer transitions stay microtasks.
    queueMicrotask(() => postPersistence(emitter));
  });
}

function persistenceRequest(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw createVfsError('EINVAL', undefined, 'Invalid persistence status request');
  try {
    const prototype = Object.getPrototypeOf(payload);
    const keys = Reflect.ownKeys(payload);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 2 ||
      keys.some((key) => key !== 'version' && key !== 'generation')
    )
      throw createVfsError('EINVAL', undefined, 'Invalid persistence status request');
    const { version, generation } = payload as Record<string, unknown>;
    if (version !== 1 || typeof generation !== 'string' || generation.length < 1 || generation.length > 128)
      throw createVfsError('EINVAL', undefined, 'Invalid persistence status request');
    return generation;
  } catch {
    throw createVfsError('EINVAL', undefined, 'Invalid persistence status request');
  }
}

function debugLog(...args: unknown[]) {
  if (debugEnabled) {
    console.log(...args);
  }
}

type CommandPayload = WorkerInitPayload;

function getString(payload: CommandPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`Expected string payload field: ${key}`);
  return value;
}

/**
 * SEC-2: validate numeric message fields at the worker boundary before they
 * reach the VFS. `getNumber` requires a non-negative safe integer (the common
 * case: fds, offsets, sizes, lengths, modes, flags). NaN/Infinity/float/negative
 * are rejected with a VfsError EINVAL so the failure serializes like every other
 * VFS error (the shared error serializer reads `.code`) instead of wedging the worker. Pass
 * `{ signed: true }` for fields that are legitimately negative (e.g. a relative
 * seek offset), which still rejects NaN/Infinity/non-integers.
 */
function getNumber(payload: CommandPayload, key: string, opts?: { signed?: boolean }): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!opts?.signed && value < 0)) {
    throw createVfsError('EINVAL', undefined, `Invalid numeric payload field: ${key}`);
  }
  return value;
}

function getOptionalNumber(payload: CommandPayload, key: string): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  return getNumber(payload, key);
}

function getOptionalBoolean(payload: CommandPayload, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

const initFields = new Set([
  'fileName',
  'sab',
  'debug',
  'plugins',
  'openMode',
  'bufferMode',
  'localDurabilityMode',
  'debugWal',
  'noatime',
  'recoveryMode',
  'maxFileSize',
  'maxNameLength',
  'maxPathDepth',
  'maxFiles',
  'maxTotalBytes',
  'generation',
]);

function decodeInit(value: unknown): {
  fileName: string;
  sab?: SharedArrayBuffer;
  debug: boolean;
  options: OpfsVfsOptions;
  plugins: unknown;
  generation: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw createVfsError('EINVAL', undefined, 'Invalid INIT payload');
  const payload = value as WorkerInitPayload;
  for (const field of Reflect.ownKeys(payload)) {
    if (!initFields.has(String(field)))
      throw createVfsError('EINVAL', undefined, `Unsupported INIT field: ${String(field)}`);
  }
  const fileName = payload.fileName;
  if (typeof fileName !== 'string') throw createVfsError('EINVAL', undefined, 'Invalid INIT fileName');
  volumeFileNames(fileName);
  const invalid = (field: string): never => {
    throw createVfsError('EINVAL', fileName, `Invalid INIT field: ${field}`);
  };
  if (typeof payload.generation !== 'string' || !payload.generation) invalid('generation');
  const sab = payload.sab;
  if (
    sab !== undefined &&
    (typeof SharedArrayBuffer !== 'function' ||
      !(sab instanceof SharedArrayBuffer) ||
      sab.byteLength <= 64 ||
      sab.byteLength % 4 !== 0)
  )
    invalid('sab');
  if (payload.debug !== undefined && typeof payload.debug !== 'boolean') invalid('debug');
  const enums = {
    openMode: ['open-or-create', 'create-new', 'open-existing'],
    bufferMode: ['disk', 'memory'],
    localDurabilityMode: ['balanced', 'strict', 'relaxed'],
    recoveryMode: ['fail-stop', 'salvage'],
  } as const;
  for (const [field, allowed] of Object.entries(enums)) {
    const option = payload[field];
    if (option !== undefined && !allowed.includes(option as never)) invalid(field);
  }
  for (const field of ['debugWal', 'noatime']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') invalid(field);
  }
  for (const field of ['maxFileSize', 'maxNameLength', 'maxPathDepth', 'maxFiles', 'maxTotalBytes']) {
    const option = payload[field];
    if (option !== undefined && (typeof option !== 'number' || !Number.isSafeInteger(option) || option < 0))
      invalid(field);
  }
  const options: OpfsVfsOptions = {
    openMode: payload.openMode as OpfsVfsOptions['openMode'],
    bufferMode: payload.bufferMode as OpfsVfsOptions['bufferMode'],
    localDurabilityMode: payload.localDurabilityMode as OpfsVfsOptions['localDurabilityMode'],
    debugWal: payload.debugWal as OpfsVfsOptions['debugWal'],
    noatime: payload.noatime as OpfsVfsOptions['noatime'],
    recoveryMode: payload.recoveryMode as OpfsVfsOptions['recoveryMode'],
    maxFileSize: payload.maxFileSize as OpfsVfsOptions['maxFileSize'],
    maxNameLength: payload.maxNameLength as OpfsVfsOptions['maxNameLength'],
    maxPathDepth: payload.maxPathDepth as OpfsVfsOptions['maxPathDepth'],
    maxFiles: payload.maxFiles as OpfsVfsOptions['maxFiles'],
    maxTotalBytes: payload.maxTotalBytes as OpfsVfsOptions['maxTotalBytes'],
  };
  return {
    fileName,
    sab: sab as SharedArrayBuffer | undefined,
    debug: payload.debug === true,
    options,
    plugins: payload.plugins,
    generation: payload.generation as string,
  };
}

function decodeFileChangeEnvelope(
  value: unknown,
  type: 'FILE_CHANGES_OPEN' | 'FILE_CHANGES_COMMAND' | 'FILE_CHANGES_CLOSE',
): { generation: string; clientId: string; channelId: string; route: ChangeRoute; command?: ChangeCommand } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw createVfsError('EINVAL', undefined, 'Invalid file change channel');
  const payload = value as Record<string, unknown>;
  const fields =
    type === 'FILE_CHANGES_COMMAND'
      ? ['version', 'generation', 'clientId', 'channelId', 'route', 'command']
      : ['version', 'generation', 'clientId', 'channelId', 'route'];
  const keys = Reflect.ownKeys(payload);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(String(key))))
    throw createVfsError('EINVAL', undefined, 'Invalid file change channel');
  if (
    payload.version !== 1 ||
    !validChangeId(payload.generation) ||
    !validChangeId(payload.clientId) ||
    !validChangeId(payload.channelId) ||
    (payload.route !== 'local' && payload.route !== 'follower-relay') ||
    (type === 'FILE_CHANGES_COMMAND' &&
      (typeof payload.command !== 'object' || payload.command === null || Array.isArray(payload.command)))
  ) {
    throw createVfsError('EINVAL', undefined, 'Invalid file change channel');
  }
  return {
    generation: payload.generation as string,
    clientId: payload.clientId as string,
    channelId: payload.channelId as string,
    route: payload.route as ChangeRoute,
    command: payload.command as ChangeCommand | undefined,
  };
}

function isFileChangeType(
  value: unknown,
): value is 'FILE_CHANGES_OPEN' | 'FILE_CHANGES_COMMAND' | 'FILE_CHANGES_CLOSE' {
  return value === 'FILE_CHANGES_OPEN' || value === 'FILE_CHANGES_COMMAND' || value === 'FILE_CHANGES_CLOSE';
}

function assertFileChangeRequestEnvelope(
  value: unknown,
  type: 'FILE_CHANGES_OPEN' | 'FILE_CHANGES_COMMAND' | 'FILE_CHANGES_CLOSE',
) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw createVfsError('EINVAL', undefined, 'Invalid file change request');
  const message = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(message);
  if (
    keys.length !== 4 ||
    keys.some((key) => !['id', 'type', 'payload', 'data'].includes(String(key))) ||
    !Number.isSafeInteger(message.id) ||
    (message.id as number) <= 0 ||
    message.type !== type ||
    message.data !== undefined
  ) {
    throw createVfsError('EINVAL', undefined, 'Invalid file change request');
  }
}

function failChangePost(entry: RuntimeChangeChannel) {
  if (!isCurrentChangeChannel(entry)) return;
  entry.state = 'closed';
  releaseChangeChannel(entry);
  entry.channel?.close();
  try {
    endpoint.postMessage({
      type: 'FILE_CHANGES_INTERRUPTED',
      payload: {
        version: 1,
        generation: entry.generation,
        clientId: entry.clientId,
        channelId: entry.channelId,
        route: entry.route,
        code: 'SUBSCRIPTION_INTERRUPTED',
      },
    });
  } catch {
    // Cleanup must not depend on notifying a failed recipient.
  }
}

function postChangeMessage(entry: RuntimeChangeChannel, type: string, extra: Record<string, unknown> = {}) {
  if (!isCurrentChangeChannel(entry)) return;
  const frame = extra.frame as ChangeFrame | undefined;
  const bytes =
    frame?.type === 'event' && frame.change.content.status === 'included' ? frame.change.content.bytes : undefined;
  const message = {
    type,
    payload: {
      version: 1,
      generation: entry.generation,
      clientId: entry.clientId,
      channelId: entry.channelId,
      route: entry.route,
      ...extra,
    },
  };
  try {
    if (bytes) endpoint.postMessage(message, { transfer: [bytes.buffer as ArrayBuffer] });
    else endpoint.postMessage(message);
  } catch {
    failChangePost(entry);
  }
}

async function handleFileChangeMessage(
  type: 'FILE_CHANGES_OPEN' | 'FILE_CHANGES_COMMAND' | 'FILE_CHANGES_CLOSE',
  id: number,
  payload: unknown,
) {
  const send = (result: unknown) => endpoint.postMessage({ id, type, result });
  const envelope = decodeFileChangeEnvelope(payload, type);
  const mount = vfs;
  if (!mount || activeGeneration !== envelope.generation)
    throw createVfsError('EBADF', undefined, 'File change channel is closed');
  const key = changeChannelKey(envelope.clientId, envelope.channelId);

  if (type === 'FILE_CHANGES_OPEN') {
    if (
      changeChannels.has(key) ||
      (changeChannelCounts.get(envelope.clientId) ?? 0) >= 32 ||
      changeChannels.size >= 128
    )
      throw createVfsError('ENOSPC', undefined, 'Too many file change channels');
    const opener = workerChangeOpeners.get(mount);
    if (!opener) throw createVfsError('ENOTSUP', undefined, 'Logical changes unavailable');
    const entry: RuntimeChangeChannel = { ...envelope, mount, state: 'opening' };
    changeChannels.set(key, entry);
    changeChannelCounts.set(envelope.clientId, (changeChannelCounts.get(envelope.clientId) ?? 0) + 1);
    try {
      const channel = await opener.open(
        entry.clientId,
        entry.route,
        (frame: ChangeFrame) => postChangeMessage(entry, 'FILE_CHANGES_FRAME', { frame }),
        (code) => postChangeMessage(entry, 'FILE_CHANGES_INTERRUPTED', { code }),
        () =>
          postChangeMessage(
            entry,
            entry.route === 'follower-relay' ? 'FILE_CHANGES_INTERRUPTED' : 'FILE_CHANGES_CLOSED',
            entry.route === 'follower-relay' ? { code: 'SUBSCRIPTION_INTERRUPTED' } : {},
          ),
        entry.channelId,
      );
      if (
        changeChannels.get(key) !== entry ||
        entry.state === 'closed' ||
        vfs !== mount ||
        activeGeneration !== entry.generation ||
        channel.generation !== entry.generation
      ) {
        channel.close();
        throw createVfsError('EBADF', undefined, 'File change channel is closed');
      }
      entry.channel = channel;
      entry.state = 'open';
      send({ generation: channel.generation });
    } catch (error) {
      releaseChangeChannel(entry);
      throw error;
    }
    return;
  }

  const entry = changeChannels.get(key);
  if (!entry || entry.generation !== envelope.generation || entry.route !== envelope.route)
    throw createVfsError('EBADF', undefined, 'File change channel is closed');
  if (type === 'FILE_CHANGES_CLOSE') {
    entry.state = 'closed';
    releaseChangeChannel(entry);
    entry.channel?.close();
    send('OK');
    return;
  }
  if (entry.state !== 'open' || !entry.channel)
    throw createVfsError('EBADF', undefined, 'File change channel is closed');
  const result = await entry.channel.request(envelope.command!);
  if (!isCurrentChangeChannel(entry)) throw createVfsError('EBADF', undefined, 'File change channel is closed');
  send(result);
}

export function startVfsWorker({
  plugins = [],
  endpoint: nextEndpoint = self as unknown as WorkerEndpoint,
}: { plugins?: readonly VfsPluginRegistration[]; endpoint?: WorkerEndpoint } = {}) {
  if (started) throw new Error('VFS worker already started');
  if (!Array.isArray(plugins)) throw new Error('Worker plugins must be an array');
  const registry = new Map<string, VfsPluginRegistration>();
  for (const registration of plugins) {
    if (
      (typeof registration !== 'object' && typeof registration !== 'function') ||
      registration === null ||
      typeof registration.id !== 'string' ||
      !isValidPluginId(registration.id) ||
      typeof registration.configure !== 'function' ||
      registry.has(registration.id)
    ) {
      throw new Error('Invalid or duplicate worker plugin registration');
    }
    registry.set(registration.id, registration);
  }
  started = true;
  endpoint = nextEndpoint;
  endpoint.onmessage = async (event) => {
    const message = event.data;
    const id = message?.id;
    const type = message?.type;
    const payload = message?.payload;
    const data = message?.data;
    let replyInFlight = false;
    debugLog('VFS Worker message:', type, id);

    if (type === 'PING') {
      endpoint.postMessage({ id, type: 'PONG' });
      return;
    }

    try {
      if (isFileChangeType(type)) {
        assertFileChangeRequestEnvelope(message, type);
        await handleFileChangeMessage(type, id as number, payload);
        return;
      }
      switch (type) {
        case 'INIT': {
          const { fileName, sab, debug, options, plugins: requested, generation } = decodeInit(payload);
          // Overlapping INITs would swap `vfs` under the one still mounting.
          if (initInFlight) throw createVfsError('EBUSY', fileName, 'VFS initialization already in progress');
          if (initialized && generation === initializedGeneration)
            throw createVfsError('EINVAL', fileName, 'VFS owner generation already mounted');
          initInFlight = true;
          try {
            const { requests } = preparePluginRequests(requested, options.openMode, fileName);
            // Resolve the whole list before any plugin factory runs.
            const registrations = requests.map((request) => {
              const registration = registry.get(request.id);
              if (!registration) throw createVfsError('EINVAL', fileName, `Unknown worker plugin: ${request.id}`);
              return registration;
            });
            const configured: ConfiguredVfsPlugin[] = requests.map((request, index) => {
              try {
                return registrations[index]!.configure(request.options);
              } catch (error) {
                // Plugin validation may inspect secret options. Never relay its error text.
                let errorCode: unknown = 'EINVAL';
                if (typeof error === 'object' && error !== null) {
                  try {
                    errorCode = (error as { code?: unknown }).code;
                  } catch {}
                }
                const code =
                  typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : 'EINVAL';
                const pluginError = createVfsError(
                  'EINVAL',
                  fileName,
                  `Invalid worker plugin options: ${request.id}`,
                ) as Error & {
                  code: string;
                };
                pluginError.code = code;
                throw pluginError;
              }
            });
            const validated = validateConfiguredPlugins(configured, options.openMode ?? 'open-or-create', fileName);
            assertUnclaimedConfiguredPlugins(validated, fileName);
            for (let index = 0; index < requests.length; index++) {
              const request = requests[index]!;
              const actual = validated[index]!;
              if (
                actual.id !== request.id ||
                actual.contractVersion !== request.contractVersion ||
                actual.compatibilityKey !== request.compatibilityKey ||
                actual.requiredOpenMode !== request.requiredOpenMode
              ) {
                throw createVfsError('EINVAL', fileName, `Worker plugin request mismatch: ${request.id}`);
              }
            }
            const profile = createMountProfile(validated);
            debugEnabled = debug;
            // SAB-6: INIT idempotency. A second INIT must not leave the previous
            // listen() loop running against the old SAB. Cancel it and drop the old
            // VFS before constructing the new one.
            if (initialized) {
              listenAbort?.abort();
              listenAbort = null;
              messenger = null;
              for (const entry of changeChannels.values()) {
                if (entry.state === 'opening') entry.state = 'closed';
              }
              // Closing owns extension cleanup and releases OPFS handles. Dropping
              // the old VFS without it would leak private mount state until GC.
              // Best-effort — a close failure must not break the re-INIT.
              try {
                if (vfs) {
                  markMountReplacement(vfs);
                  await closeVolume(vfs);
                }
              } catch {
                // ignore
              }
              // `closeVolume` schedules normal lifecycle callbacks. Clear only
              // after those callbacks run, so local close and replacement
              // interruption notifications keep their protocol route.
              queueMicrotask(clearChangeChannels);
              vfs = null;
              activeGeneration = null;
              persistenceEmitter = undefined;
              initialized = false;
            }
            try {
              validatedPluginOptions.set(options, validated);
              mountGenerations.set(options, generation);
              vfs = new OpfsVfs(fileName, options);
              await vfs.ready;
              activeGeneration = generation;
              createPersistenceEmitter(vfs, generation);
            } catch (error) {
              const serialized = serializeRemoteError(error);
              const msg = `VFS init failed: ${serialized.error}`;
              const { error: _message, ...details } = serialized;
              console.error(msg);
              endpoint.postMessage({
                id,
                type: 'ERROR',
                result: serializeRemoteError({ message: msg, ...details }),
              });
              return;
            }

            initialized = true;
            initializedGeneration = generation;
            endpoint.postMessage({ id, type: 'INIT', result: { profile } });

            if (typeof SharedArrayBuffer === 'function' && sab instanceof SharedArrayBuffer) {
              listenAbort = new AbortController();
              messenger = new SyncMessenger(sab);
              messenger.listen(handleSyncCommand, { signal: listenAbort.signal });
            }
          } finally {
            initInFlight = false;
          }
          break;
        }
        case PERSISTENCE_STATUS: {
          const generation = persistenceRequest(payload);
          const emitter = persistenceEmitter;
          if (!vfs || !emitter || generation !== activeGeneration)
            throw createVfsError('EBADF', undefined, 'VFS persistence status is unavailable');
          emitter.enabled = true;
          emitter.queued = false;
          const result = persistenceFrame(emitter, true);
          if (!result) throw createVfsError('EBADF', undefined, 'VFS persistence status is unavailable');
          endpoint.postMessage({ id, type, result });
          break;
        }
        default: {
          replyInFlight = true;
          repliesInFlight++;
          const { result, data: resData } = await handleSyncCommand(type, payload, data);
          const persistence = persistenceEmitter?.queued ? persistenceFrame(persistenceEmitter) : undefined;
          endpoint.postMessage(
            { id, type, result, data: resData, ...(persistence === undefined ? {} : { persistence }) },
            resData ? [resData.buffer] : [],
          );
          break;
        }
      }
    } catch (error) {
      const serialized = serializeRemoteError(error);
      const errorMsg = isFileChangeType(type)
        ? `File change control failed: ${serialized.code ?? 'EIO'}`
        : serialized.error;
      if (shouldLogWorkerError({ code: serialized.code, message: errorMsg, payload, type })) {
        console.error('VFS Worker error:', errorMsg);
      }
      const persistence =
        type !== 'INIT' && type !== PERSISTENCE_STATUS && !isFileChangeType(type) && persistenceEmitter?.queued
          ? persistenceFrame(persistenceEmitter)
          : undefined;
      endpoint.postMessage({
        id,
        type: 'ERROR',
        // File-change control keeps its fixed message; the other validated fields still apply.
        result: isFileChangeType(type) ? { ...serialized, error: errorMsg } : serialized,
        ...(persistence === undefined ? {} : { persistence }),
      });
    } finally {
      const emitter = persistenceEmitter;
      if (replyInFlight && --repliesInFlight === 0 && emitter?.queued) queueMicrotask(() => postPersistence(emitter));
    }
  };
}

async function handleSyncCommand(
  type: string,
  payload: unknown,
  data?: Uint8Array,
): Promise<{ result: unknown; data?: Uint8Array }> {
  if (!vfs) throw new Error('VFS not initialized');

  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`Invalid payload for command: ${type}`);
  }
  const p = payload as CommandPayload;
  switch (type) {
    // These commands finish and close their descriptors before yielding. Passive
    // clients never receive an fd that can outlive an attachment or owner.
    case 'READ_FILE_BUFFER': {
      const path = getString(p, 'path');
      const limit = getNumber(p, 'limit');
      if (limit > MAX_WHOLE_FILE_BYTES) throw createVfsError('EFBIG', path);
      const fd = vfs.openSync(path, OpenFlags.O_RDONLY);
      try {
        const { size } = vfs.fstatSync(fd);
        if (size > limit) throw createVfsError('EFBIG', path);
        const { buffer, read } = vfs.readSync(fd, size, 0);
        return { result: { read }, data: buffer.subarray(0, read) };
      } finally {
        vfs.closeSync(fd);
      }
    }
    case 'WRITE_FILE_BUFFER': {
      const path = getString(p, 'path');
      if (!(data instanceof Uint8Array)) throw createVfsError('EINVAL', path);
      const expected = p.expected;
      if (expected !== undefined && !(expected instanceof Uint8Array)) throw createVfsError('EINVAL', path);
      if (
        (p.exclusive !== undefined && typeof p.exclusive !== 'boolean') ||
        (p.append !== undefined && typeof p.append !== 'boolean')
      )
        throw createVfsError('EINVAL', path);
      vfs.writeFileBufferSync(path, data, {
        exclusive: p.exclusive,
        expected,
        append: p.append,
      } satisfies WriteFileBufferOptions);
      return { result: 'OK' };
    }
    case 'RENAME_NO_REPLACE': {
      const oldPath = getString(p, 'oldPath');
      const newPath = getString(p, 'newPath');
      try {
        // lstat also recognizes dangling symlinks, which existsSync follows.
        vfs.lstatSync(newPath);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        vfs.renameSync(oldPath, newPath);
        return { result: 'OK' };
      }
      throw createVfsError('EEXIST', newPath);
    }
    case 'MKDIR':
      vfs.mkdirSync(
        getString(p, 'path'),
        getOptionalBoolean(p, 'recursive')
          ? { recursive: true, mode: getOptionalNumber(p, 'mode') }
          : getOptionalNumber(p, 'mode'),
      );
      return { result: 'OK' };
    case 'OPEN': {
      const fd = vfs.openSync(getString(p, 'path'), getOptionalNumber(p, 'flags'), getOptionalNumber(p, 'mode'));
      return { result: fd };
    }
    case 'WRITE': {
      // writeSync validates the descriptor before accepting an empty write.
      const written = vfs.writeSync(getNumber(p, 'fd'), data ?? new Uint8Array(0), getOptionalNumber(p, 'offset'));
      return { result: written };
    }
    case 'READ': {
      const { buffer, read } = vfs.readSync(getNumber(p, 'fd'), getNumber(p, 'size'), getOptionalNumber(p, 'offset'));
      return { result: { read }, data: buffer };
    }
    case 'SEEK': {
      // offset is signed for relative whence (SEEK_CUR/SEEK_END).
      const pos = vfs.seekSync(getNumber(p, 'fd'), getNumber(p, 'offset', { signed: true }), getNumber(p, 'whence'));
      return { result: pos };
    }
    case 'CLOSE':
      vfs.closeSync(getNumber(p, 'fd'));
      return { result: 'OK' };
    case 'FSTAT':
      return { result: vfs.fstatSync(getNumber(p, 'fd')) };
    case 'FSYNC':
      vfs.fsyncSync(getNumber(p, 'fd'));
      return { result: 'OK' };
    case 'FTRUNCATE':
      vfs.ftruncateSync(getNumber(p, 'fd'), getNumber(p, 'size'));
      return { result: 'OK' };
    case 'CHMOD':
      vfs.chmodSync(getString(p, 'path'), getNumber(p, 'mode'));
      return { result: 'OK' };
    case 'UTIMES':
      vfs.utimesSync(getString(p, 'path'), getNumber(p, 'atimeMs'), getNumber(p, 'mtimeMs'));
      return { result: 'OK' };
    case 'SYMLINK':
      vfs.symlinkSync(getString(p, 'target'), getString(p, 'path'), getOptionalNumber(p, 'mode'));
      return { result: 'OK' };
    case 'LINK':
      vfs.linkSync(getString(p, 'existingPath'), getString(p, 'newPath'));
      return { result: 'OK' };
    case 'READLINK':
      return { result: vfs.readlinkSync(getString(p, 'path')) };
    case 'REALPATH':
      return { result: vfs.realpathSync(getString(p, 'path')) };
    case 'UNLINK':
      vfs.unlinkSync(getString(p, 'path'));
      return { result: 'OK' };
    case 'RMDIR':
      vfs.rmdirSync(getString(p, 'path'));
      return { result: 'OK' };
    case 'REMOVE':
      vfs.removeSync(getString(p, 'path'));
      return { result: 'OK' };
    case 'RENAME':
      vfs.renameSync(getString(p, 'oldPath'), getString(p, 'newPath'));
      return { result: 'OK' };
    case 'TRUNCATE':
      vfs.truncateSync(getString(p, 'path'), getNumber(p, 'size'));
      return { result: 'OK' };
    case 'EXISTS':
      return { result: vfs.existsSync(getString(p, 'path')) };
    case 'STAT':
      return { result: vfs.statSync(getString(p, 'path')) };
    case 'LSTAT':
      return { result: vfs.lstatSync(getString(p, 'path')) };
    case 'READDIR':
      return { result: vfs.readdirSync(getString(p, 'path')) };
    case 'READDIR_NAMES':
      return { result: vfs.readdirNamesSync(getString(p, 'path')) };
    case 'READDIR_ENTRIES':
      return { result: vfs.readdirEntriesSync(getString(p, 'path')) };
    case 'LIST_PATHS':
      return { result: vfs.listPathsSync() };
    case 'SYNC':
      vfs.syncSync();
      return { result: 'OK' };
    case 'FLUSH':
      vfs.flushVfs();
      return { result: 'OK' };
    case 'CLOSE_VFS':
      try {
        await closeVolume(vfs);
        // Keep `initialized`: the next INIT still has to cancel the old SAB listener.
        initializedGeneration = null;
        return { result: 'OK' };
      } finally {
        queueMicrotask(clearChangeChannels);
      }
    default:
      throw new Error(`Unknown command: ${type}`);
  }
}

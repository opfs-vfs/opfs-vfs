import {
  type MkdirOptions,
  OpenFlags,
  type OpfsVfsOptions,
  type VfsDirEntry,
  type VfsStat,
  type WriteFileBufferOptions,
} from './opfs-vfs';
import { SAB_SIZE, SyncMessenger } from './sync-messenger';
import type { VfsPluginRequest } from './plugins';
import {
  createSharedMountProfile,
  mountProfileMismatch,
  preparePluginRequests,
  sharedMountProfileMismatch,
  type MountProfile,
  type SharedMountProfile,
} from './worker-plugins';
import { findVolumeFile, volumeFileNames, VolumeImportingError } from './volume-files';
import type { ChangeCommand, ChangeFrame, ChangeReply, FileChangeChannel } from './changes';
import { isChangeReply, snapshotChangeCommand, snapshotChangeFrame } from './change-protocol';
import {
  parseRemoteError,
  reviveRemoteError,
  serializeRemoteError,
  toRemoteErrorDetails,
  type RemoteErrorDetails,
} from './remote-error';
import {
  parsePersistenceFrame,
  PERSISTENCE_FRAME,
  PERSISTENCE_STATUS,
  type ClientPersistenceStatus,
} from './persistence-status';

export { getSupport, type VfsSupport, type VfsSupportRequirement } from './support';
export type { RemoteErrorDetails } from './remote-error';
export type { ClientPersistenceStatus } from './persistence-status';

export type VfsWorkerFactory = () => Worker;
export interface VfsWorkerEndpoint {
  postMessage(message: unknown, transfer?: StructuredSerializeOptions | Transferable[]): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
}

/** What this client knows about one command invocation's delivery.
 * `refused` failed a check or `postMessage` before delivery; `sent` may have been applied without a validated reply;
 * `replied` has a validated owner error reply (which may still be partially applied).
 */
export type VfsDispatch = 'refused' | 'sent' | 'replied';

/** A generation-bound command failure with this invocation's dispatch evidence and its cause's details. */
export class VfsCommandError extends Error {
  override readonly name = 'VfsCommandError';
  readonly dispatch: VfsDispatch;
  readonly details: RemoteErrorDetails;

  constructor(cause: unknown, dispatch: VfsDispatch) {
    const details = toRemoteErrorDetails(cause);
    super(details.message, { cause });
    this.dispatch = dispatch;
    this.details = details;
  }
}

/** The async path methods available on a generation-bound client. */
export const GENERATION_METHODS = [
  'readFileBuffer',
  'writeFileBuffer',
  'stat',
  'lstat',
  'readdirEntries',
  'readlink',
  'realpath',
  'mkdir',
  'unlink',
  'rmdir',
  'remove',
  'rename',
  'renameNoReplace',
  'truncate',
  'chmod',
  'utimes',
  'link',
  'symlink',
  'sync',
] as const;

export type GenerationMethod = (typeof GENERATION_METHODS)[number];
export type GenerationClient = Readonly<Pick<OpfsVfsWorkerClient, GenerationMethod>>;

export type ClientStatusState = 'opening' | 'ready' | 'recovering' | 'closing' | 'failed' | 'closed';
export type ClientFallbackReason =
  | 'shared-worker-api-unavailable'
  | 'shared-worker-sync-handle-unavailable'
  | 'shared-worker-factory-unavailable'
  | 'existing-dedicated-owner';

/**
 * Local client lifecycle. Snapshots are frozen and keep their identity until a field changes.
 * `persistence` is owner-reported state for the current `ownerGeneration`, or null while unknown: opening,
 * recovering, routing loss, after page resume until resync, and closed or failed. It is not a durability receipt
 * for a particular command. On resume, a follower goes `recovering`, invalidates routing, and renegotiates with
 * the owner; a leader nulls `persistence` until a fresh worker snapshot.
 */
export interface ClientStatus {
  readonly fileName: string;
  readonly transport: 'dedicated' | 'shared-worker';
  readonly fallbackReason: ClientFallbackReason | null;
  readonly state: ClientStatusState;
  readonly role: 'leader' | 'follower' | null;
  readonly ownerGeneration: string | null;
  readonly error: RemoteErrorDetails | null;
  readonly persistence: ClientPersistenceStatus | null;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  dispatch?: DispatchRecord;
};

type DispatchRecord = { sent: boolean; replied: boolean };

type WorkerCommandPayload = Record<string, unknown>;

interface WorkerResponseMessage {
  id: number;
  type: string;
  result?: unknown;
  data?: Uint8Array;
  persistence?: unknown;
}

interface LeaderCommandMessage {
  id: number;
  type: 'COMMAND';
  payload: {
    type: string;
    payload: WorkerCommandPayload;
  };
  tabId: string;
  clientId: string;
  generation: string;
  data?: Uint8Array;
}

interface LeaderResponseMessage extends WorkerResponseMessage {
  tabId?: string;
  generation?: string;
}

type ChangeCallbacks = {
  receive: (frame: ChangeFrame) => void;
  interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
  closed: () => void;
  generation: string;
  lane?: BroadcastChannel;
  closedState: boolean;
  clientClosed: boolean;
};
type RelayedChangeChannel = { clientId: string; channelId: string };
const changeKey = (clientId: string, channelId: string) => JSON.stringify([clientId, channelId]);
const changeKeyPrefix = (clientId: string) => `${JSON.stringify([clientId]).slice(0, -1)},`;
const isChangeId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const changeLaneName = (fileName: string, generation: string, clientId: string) =>
  `opfs-vfs-changes-${fileName}-${generation}-${clientId}`;

const VFS_SHUTTING_DOWN_CODE = 'VFS_SHUTTING_DOWN';
const LEADER_RESPONSE_TIMEOUT_CODE = 'LEADER_RESPONSE_TIMEOUT';
const INITIALIZATION_TIMEOUT_CODE = 'VFS_INITIALIZATION_TIMEOUT';
// SAB-6: the synchronous SAB API only works on the leader (the only instance
// running a listen() loop on the shared SAB). A follower calling it would block
// for the full 30s call timeout against a SAB nobody services. Fail fast with a
// typed error instead so callers can fall back to the async API or re-elect.
const NOT_LEADER_CODE = 'VFS_NOT_LEADER';
const LEADER_NOT_READY_CODE = 'VFS_LEADER_NOT_READY';
const ATTACHMENT_LOST_CODE = 'VFS_ATTACHMENT_LOST';
const PROTOCOL_MISMATCH_MESSAGE =
  'This page and the volume owner use incompatible opfs-vfs builds. Reload this page and close other tabs that use this volume.';
const DISCONNECTED_FOLLOWER_CHANGE_ERROR = 'The follower disconnected. Reconnect to use this volume.';
const LEADER_ONLY_COMMANDS = new Set(['INIT', 'CLOSE_VFS', 'PING']);
const FILE_CHANGE_COMMANDS = new Set(['FILE_CHANGES_OPEN', 'FILE_CHANGES_COMMAND', 'FILE_CHANGES_CLOSE']);
const LONG_COMMANDS = new Set(['FLUSH', 'SYNC', 'FSYNC', 'CLOSE_VFS', 'LIST_PATHS']);
const LONG_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const TAKEOVER_SHUTDOWN_TIMEOUT_MS = 3_000;
// Passive observers (devtools) fail fast so their UI can offer a reconnect.
const OBSERVER_COMMAND_TIMEOUT_MS = 5_000;
const commandTimeout = (type: string) =>
  LONG_COMMANDS.has(type) ? LONG_COMMAND_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS;
const OBSERVER_COMMANDS = new Set([
  'READ_FILE_BUFFER',
  'WRITE_FILE_BUFFER',
  'RENAME_NO_REPLACE',
  'MKDIR',
  'CHMOD',
  'UTIMES',
  'SYMLINK',
  'LINK',
  'READLINK',
  'REALPATH',
  'UNLINK',
  'RMDIR',
  'REMOVE',
  'TRUNCATE',
  'EXISTS',
  'STAT',
  'LSTAT',
  'READDIR',
  'READDIR_NAMES',
  'READDIR_ENTRIES',
  'LIST_PATHS',
  'SYNC',
  'FLUSH',
]);

export interface WorkerInspection {
  protocol: 1;
  generation: string;
}

/** Probe a ready standard worker without opening storage or entering its election. */
export function inspectWorker(name: string, options: { timeout?: number } = {}): Promise<WorkerInspection | null> {
  const timeout = options.timeout ?? 500;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Probe timeout must be positive');
  return probeWorker(name, timeout);
}

function probeWorker(name: string, timeout: number, signal?: AbortSignal): Promise<WorkerInspection | null> {
  const channel = new BroadcastChannel(`opfs-vfs-${name}`);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(null);
    const finish = (result: WorkerInspection | null) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      channel.close();
      resolve(result);
    };
    if (signal?.aborted) {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    channel.onmessage = ({ data }) => {
      if (
        data?.type === 'OBSERVER_INFO' &&
        data.id === id &&
        data.protocol === 1 &&
        typeof data.generation === 'string'
      ) {
        finish({ protocol: 1, generation: data.generation });
      }
    };
    channel.postMessage({ type: 'OBSERVER_PROBE', id });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactOwnKeys(value: unknown, fields: readonly string[]) {
  if (!isObject(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length && keys.every((key) => typeof key === 'string' && fields.includes(key));
  } catch {
    return false;
  }
}

function makeCodedError(message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  if (code) {
    error.code = code;
  }
  return error;
}

function serializeChangeError(error: unknown) {
  const details = toRemoteErrorDetails(error);
  const code = details.code ?? 'EIO';
  return serializeRemoteError({ ...details, message: `File change control failed: ${code}`, code });
}

type BufferedResponse<T> =
  T extends Record<string, unknown> ? T & { buffer: Uint8Array } : { result: T; buffer: Uint8Array };

function withOptionalBuffer<T>(value: T, buffer?: Uint8Array): T | BufferedResponse<T> {
  if (!buffer) return value;
  if (isObject(value)) {
    return { ...value, buffer } as BufferedResponse<T>;
  }
  return { result: value, buffer } as unknown as BufferedResponse<T>;
}

export interface OpfsVfsWorkerClientOptions extends Omit<OpfsVfsOptions, 'plugins' | '_wrapSyncAccessHandle'> {
  plugins?: readonly VfsPluginRequest[];
  /** @see OpfsVfsOptions.openMode */
  openMode?: OpfsVfsOptions['openMode'];
  forceLeader?: boolean;
  /** Passive connection to this inspected generation; never becomes an owner. */
  attachTo?: string;
  /** Claim an idle volume without queueing. Requires explicit open-existing or create-new. */
  claimIfAvailable?: boolean;
  initTimeout?: number;
  debug?: boolean;
  /** @see OpfsVfsOptions.bufferMode */
  bufferMode?: 'memory' | 'disk';
  /** @see OpfsVfsOptions.localDurabilityMode */
  localDurabilityMode?: 'relaxed' | 'balanced' | 'strict';
  /** @see OpfsVfsOptions.noatime */
  noatime?: OpfsVfsOptions['noatime'];
  /** @see OpfsVfsOptions.recoveryMode */
  recoveryMode?: OpfsVfsOptions['recoveryMode'];
  /**
   * SAB-5: payload-region size for the synchronous SAB bridge, in bytes
   * (default {@link SAB_SIZE}, ~4MB). This is the per-message transfer cap;
   * larger reads/writes are transparently chunked. Mainly useful for tests that
   * want to exercise chunking with a small SAB without moving large buffers.
   */
  sabSize?: number;
  /** @internal SharedWorker host admission; not part of normal page ownership. */
  sharedHost?: boolean;
  /** @internal A page follower admitted by a validated SharedWorker host. */
  followerOnly?: { readonly generation: string; readonly profile: SharedMountProfile };
  /** @internal Stable page identity supplied by a SharedWorker ATTACH. */
  attachmentId?: string;
  /** @internal Releases the bootstrap transport with this page client. */
  transportClose?: () => void;
  /** @internal The transport selected before client construction. */
  transport?: 'dedicated' | 'shared-worker';
  /** @internal Immutable automatic-selection diagnostic. */
  fallbackReason?: ClientFallbackReason | null;
}

export class OpfsVfsWorkerClient {
  private worker: VfsWorkerEndpoint | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private isLeader = false;
  private isShuttingDown = false;
  private closing = false;
  private shutdownPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private channel: BroadcastChannel;
  private fileName: string;
  private initTimeout = 15000;
  private messenger: SyncMessenger | undefined;
  private abortController = new AbortController();
  private workerFailure: Error | null = null;
  private workerReady?: Promise<void>;
  private initSent = false;
  private resourcesDisposed = false;
  private opened = false;
  private rejectReady?: (error: unknown) => void;
  private readonly closedSignal: Promise<never>;
  private onInitFailure: ((error: unknown) => void) | null = null;
  private debug: boolean;
  private debugStartedAt?: number;
  private debugLifecycleListeners?: {
    readonly visibilitychange: () => void;
    readonly pagehide: (event: PageTransitionEvent) => void;
    readonly freeze: () => void;
  };
  private bufferMode: 'memory' | 'disk';
  private openMode?: OpfsVfsOptions['openMode'];
  private localDurabilityMode: 'relaxed' | 'balanced' | 'strict';
  private noatime?: OpfsVfsOptions['noatime'];
  private recoveryMode?: OpfsVfsOptions['recoveryMode'];
  private readonly workerFactory: () => VfsWorkerEndpoint;
  private pluginRequests: VfsPluginRequest[];
  private readonly profile: MountProfile;
  private readonly sharedProfile?: SharedMountProfile;
  private readonly followerOnly?: { readonly generation: string; readonly profile: SharedMountProfile };
  private readonly sharedHost: boolean;
  private readonly volumeOptions: Pick<
    OpfsVfsOptions,
    'debugWal' | 'maxFileSize' | 'maxNameLength' | 'maxPathDepth' | 'maxFiles' | 'maxTotalBytes'
  >;
  // SAB-6: set once this instance's leader worker has finished INIT, so a leader
  // can answer follower readiness pings and broadcast its own readiness.
  private leaderReady = false;
  private generation = crypto.randomUUID();
  private readonly attachTo?: string;
  private readonly attachmentId: string;
  private readonly transportClose?: () => void;
  private readonly transport: ClientStatus['transport'];
  private readonly fallbackReason: ClientFallbackReason | null;
  private leaderGeneration?: string;
  private relayedFds = new Map<number, string>();
  private clientLockRequested = false;
  private readonly lockRequests: Promise<unknown>[] = [];
  private clientFds = new Map<string, Set<number>>();
  private clientRequests = new Map<string, Set<Promise<unknown>>>();
  private clientChecks = new Map<string, Promise<boolean>>();
  private deadClients = new Set<string>();
  // Only unmatched cancellations are evictable; pending OPENs keep their own state.
  private cancelledRelays = new Set<string>();
  private pendingOpens = new Map<string, { cancelled: boolean }>();
  private completedOpens = new Map<string, { clientId: string; fd: number }>();
  private readonly changeChannels = new Map<string, ChangeCallbacks>();
  private readonly relayedChangeChannels = new Map<string, RelayedChangeChannel>();
  private readonly pendingRelayedChangeOpens = new Map<string, { cancelled: boolean }>();
  private readonly relayedChangeLanes = new Map<string, BroadcastChannel>();
  private readonly relayedChangeControls = new Map<string, Promise<void>>();
  private readonly relayedChangeControlCounts = new Map<string, number>();
  private readonly pendingRelayedRegisters = new Map<string, { cancelled: boolean }>();
  private relayedChangeOptionBytes = 0;
  private readonly pendingChangeRequests = new Map<number, { cleanup: () => void; reject: (error: unknown) => void }>();
  private followerChangeLane?: { generation: string; lane: BroadcastChannel };
  private openingChangeChannels = 0;
  private localChangeOptionBytes = 0;
  private localChangeControlCount = 0;
  private readonly localChangeSubscriptions = new Set<string>();
  private readonly localChangeTerminalIds = new Set<string>();
  private readonly remoteErrors = new WeakSet<object>();
  private readonly claimIfAvailable: boolean;
  // SAB-6: invoked by the broadcast handler when a leader signals readiness, to
  // resolve a follower's `ready` (gated on a real ack, not a bare timer).
  private onLeaderReady: ((generation: string) => void) | null = null;
  private status!: ClientStatus;
  private ownerPersistence?: {
    generation: string;
    sequence: number;
    /** Failure history never decreases within one generation, even while `value` is null after resume. */
    failureRevision: number;
    value: ClientPersistenceStatus | null;
  };
  private persistenceFollowers = false;
  private pendingFollowerFrame?: unknown;
  private followerPersistenceFlushQueued = false;
  private followerPersistenceChannel?: MessageChannel;
  private relayedWorkerRequests = 0;
  private persistenceResync = 0;
  /** A follower's outstanding snapshot request; until its reply, untagged or other frames are ignored. */
  private persistenceSnapshotRequest?: string;
  private persistenceRequests = 0;
  private readonly resumePersistence = () => {
    this.trace('page-resume');
    if (this.resourcesDisposed || this.closing || this.isShuttingDown || !this.opened || this.attachTo !== undefined)
      return;
    if (this.isLeader && this.leaderReady) {
      if (this.ownerPersistence) this.ownerPersistence = { ...this.ownerPersistence, value: null };
      this.republishStatus();
      void this.requestWorkerPersistence(true);
    } else if (!this.isLeader) {
      this.invalidateRouting('The page resumed, so the owner route is renegotiated.');
      this.trace('leader-ping-sent', 'resume');
      this.channel.postMessage({ type: 'LEADER_PING' });
    }
  };
  private readonly onPageShow = (event: PageTransitionEvent) => {
    this.trace('pageshow', event.persisted ? 'persisted' : 'not-persisted');
    if (event.persisted) this.resumePersistence();
  };
  // One entry per subscription, so subscribing the same function twice needs two unsubscribes.
  private readonly statusListeners = new Set<{ readonly listener: () => void }>();
  private statusNotificationQueued = false;
  private closeFailure: unknown;
  private closeFailed = false;
  public ready: Promise<void>;

  /** Only the bundled client enables passive observation. */
  protected get standardWorker(): boolean {
    return false;
  }

  /** Whether this client's transport has been disposed. Reconnection requires a new client. */
  get disposed(): boolean {
    return this.resourcesDisposed;
  }

  constructor(
    fileName: string = 'pgdata.bin',
    options: OpfsVfsWorkerClientOptions = {},
    workerFactory: () => VfsWorkerEndpoint,
  ) {
    options = { ...options };
    if ('encryption' in options) {
      throw new Error('Encryption is only available from the premium worker');
    }
    if (options.attachTo !== undefined && (!options.attachTo || options.forceLeader || options.claimIfAvailable)) {
      throw new Error('attachTo requires a generation and cannot be combined with ownership options');
    }
    if (
      options.claimIfAvailable &&
      !options.sharedHost &&
      (options.forceLeader || (options.openMode !== 'open-existing' && options.openMode !== 'create-new'))
    ) {
      throw new Error('claimIfAvailable requires open-existing or create-new and cannot be combined with forceLeader');
    }
    this.attachTo = options.attachTo;
    this.claimIfAvailable = options.claimIfAvailable ?? options.sharedHost === true;
    this.sharedHost = options.sharedHost === true;
    this.followerOnly = options.followerOnly;
    if (options.attachmentId !== undefined && (typeof options.attachmentId !== 'string' || !options.attachmentId))
      throw makeCodedError('Invalid attachment identity', 'EINVAL');
    this.attachmentId = options.attachmentId ?? crypto.randomUUID();
    this.transportClose = options.transportClose;
    const actualTransport = options.followerOnly || options.sharedHost ? 'shared-worker' : 'dedicated';
    if (options.transport !== undefined && options.transport !== actualTransport)
      throw makeCodedError('Invalid client transport', 'EINVAL');
    if (options.fallbackReason !== undefined && actualTransport !== 'dedicated')
      throw makeCodedError('SharedWorker clients cannot have a fallback reason', 'EINVAL');
    this.transport = actualTransport;
    this.fallbackReason = options.fallbackReason ?? null;
    if (options.sharedHost && (options.forceLeader || options.followerOnly))
      throw makeCodedError('Invalid shared worker owner options', 'EINVAL');
    if (options.followerOnly && (options.forceLeader || options.claimIfAvailable || options.attachTo))
      throw makeCodedError('followerOnly cannot claim ownership', 'EINVAL');
    this.fileName = fileName;
    this.status = Object.freeze<ClientStatus>({
      fileName,
      transport: this.transport,
      fallbackReason: this.fallbackReason,
      state: 'opening',
      role: null,
      ownerGeneration: null,
      error: null,
      persistence: null,
    });
    this.debug = options.debug ?? false;
    if (this.debug) this.debugStartedAt = performance.now();
    this.bufferMode = options.bufferMode ?? 'disk';
    this.openMode = options.openMode;
    this.localDurabilityMode = options.localDurabilityMode ?? 'balanced';
    this.noatime = options.noatime;
    this.recoveryMode = options.recoveryMode;
    this.workerFactory = workerFactory;
    const prepared = preparePluginRequests(options.plugins, options.openMode, fileName);
    this.pluginRequests = prepared.requests;
    this.profile = prepared.profile;
    this.sharedProfile = options.sharedHost
      ? createSharedMountProfile(prepared.requests)
      : options.followerOnly?.profile;
    if (options.attachTo !== undefined && this.pluginRequests.length) {
      throw makeCodedError('Passive attachments cannot request plugins', 'EINVAL');
    }
    const allowed = new Set([
      'plugins',
      'worker',
      'blockingSab', // Removed legacy switch is accepted but never forwarded.
      'openMode',
      'forceLeader',
      'attachTo',
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
      'sharedHost',
      'followerOnly',
      'attachmentId',
      'transportClose',
      'transport',
      'fallbackReason',
    ]);
    if (Object.keys(options).some((key) => !allowed.has(key)))
      throw makeCodedError('Unsupported worker option', 'EINVAL');
    this.volumeOptions = {
      debugWal: options.debugWal,
      maxFileSize: options.maxFileSize,
      maxNameLength: options.maxNameLength,
      maxPathDepth: options.maxPathDepth,
      maxFiles: options.maxFiles,
      maxTotalBytes: options.maxTotalBytes,
    };
    // SharedWorker owners relay asynchronous page commands. Page followers retain
    // the synchronous bridge, so WebKit hosts without SharedArrayBuffer can mount.
    if (!options.sharedHost) {
      const sabSize = options.sabSize ?? SAB_SIZE;
      this.messenger = new SyncMessenger(new SharedArrayBuffer(sabSize + 64));
    }
    this.channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
    this.channel.onmessage = this.handleBroadcastMessage.bind(this);
    if (typeof document !== 'undefined') {
      document.addEventListener('resume', this.resumePersistence);
      globalThis.addEventListener('pageshow', this.onPageShow);
      if (this.debug) {
        const visibilitychange = () => this.trace('visibilitychange');
        const pagehide = (event: PageTransitionEvent) =>
          this.trace('pagehide', event.persisted ? 'persisted' : 'not-persisted');
        const freeze = () => this.trace('page-freeze');
        this.debugLifecycleListeners = { visibilitychange, pagehide, freeze };
        document.addEventListener('visibilitychange', visibilitychange);
        globalThis.addEventListener('pagehide', pagehide);
        document.addEventListener('freeze', freeze);
      }
    }
    this.trace('client-created', this.debugCapabilities(), true);

    const initTimeout = options.initTimeout || 15000;
    this.initTimeout = initTimeout;
    this.isLeader = options.forceLeader ?? false;

    // A disposal before init() installs its own handler (for example an incompatible owner announcing
    // itself during the storage preflight) still rejects `ready` with that error, without waiting.
    const disposedEarly = new Promise<never>((_, reject) => {
      this.onInitFailure = reject;
    });
    const initChain = Promise.race([disposedEarly, this.initialize(options.forceLeader, initTimeout)]).then(
      () => {
        this.opened = true;
        this.refreshStatus();
      },
      (error) => {
        if (!this.closing) this.disposeLocalResources(error);
        throw error;
      },
    );
    this.closedSignal = new Promise<never>((_, reject) => {
      this.rejectReady = reject;
    });
    void this.closedSignal.catch(() => {});
    this.ready = Promise.race([initChain, this.closedSignal]);
    void this.ready.catch(() => {});
  }

  /** Current lifecycle snapshot; no I/O. */
  getStatus(): ClientStatus {
    return this.status;
  }

  /** Emits narrow, payload-free lifecycle data for an explicitly debug-enabled client. */
  private trace(event: string, detail?: string, includeUserAgent = false) {
    if (!this.debug || this.debugStartedAt === undefined) return;
    const visibility = typeof document === 'undefined' ? 'unavailable' : document.visibilityState;
    const ownerGeneration = this.isLeader ? this.generation : (this.attachTo ?? this.leaderGeneration ?? null);
    console.info(
      '[opfs-vfs:diag] ' +
        JSON.stringify({
          at: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - this.debugStartedAt),
          client: this.attachmentId,
          event,
          role: this.isLeader ? 'leader' : 'follower',
          state: this.status.state,
          ownerGeneration,
          visibility,
          ...(detail === undefined ? {} : { detail }),
          ...(includeUserAgent && typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}),
        }),
    );
  }

  private debugCapabilities() {
    if (!this.debug) return undefined;
    return `locks=${typeof navigator.locks?.request === 'function'},broadcast=${typeof BroadcastChannel === 'function'},opfs=${typeof navigator.storage?.getDirectory === 'function'},isolated=${globalThis.crossOriginIsolated === true}`;
  }

  /** Notify `listener` (in a microtask, coalesced) after the snapshot changes. Returns an idempotent unsubscribe. */
  subscribeStatus(listener: () => void): () => void {
    if (typeof listener !== 'function') throw makeCodedError('Invalid status listener', 'EINVAL');
    const entry = { listener };
    this.statusListeners.add(entry);
    return () => {
      this.statusListeners.delete(entry);
    };
  }

  private publishStatus(
    state: ClientStatusState,
    role: ClientStatus['role'],
    ownerGeneration: string | null,
    error: RemoteErrorDetails | null,
  ) {
    const current = this.status;
    const owned = this.ownerPersistence;
    const persistence = owned && ownerGeneration && owned.generation === ownerGeneration ? owned.value : null;
    if (
      current.state === state &&
      current.role === role &&
      current.ownerGeneration === ownerGeneration &&
      current.error === error &&
      current.persistence === persistence
    )
      return;
    this.status = Object.freeze<ClientStatus>({
      fileName: this.fileName,
      transport: this.transport,
      fallbackReason: this.fallbackReason,
      state,
      role,
      ownerGeneration,
      error,
      persistence,
    });
    if (this.statusListeners.size === 0 || this.statusNotificationQueued) return;
    this.statusNotificationQueued = true;
    queueMicrotask(() => {
      this.statusNotificationQueued = false;
      for (const entry of [...this.statusListeners]) {
        // A listener may unsubscribe another one during this flush.
        if (!this.statusListeners.has(entry)) continue;
        try {
          entry.listener();
        } catch {
          // Status listeners are isolated from lifecycle dispatch.
        }
      }
    });
  }

  private republishStatus() {
    const { state, role, ownerGeneration, error } = this.status;
    this.publishStatus(state, role, ownerGeneration, error);
  }

  private acceptPersistence(payload: unknown, expectedGeneration: string | undefined): boolean {
    const frame = parsePersistenceFrame(payload);
    if (
      !frame ||
      frame.generation !== expectedGeneration ||
      (this.ownerPersistence?.generation === frame.generation &&
        (frame.sequence <= this.ownerPersistence.sequence ||
          frame.persistence.failureRevision < this.ownerPersistence.failureRevision))
    )
      return false;
    const previous = this.ownerPersistence?.generation === frame.generation ? this.ownerPersistence.value : undefined;
    const previousSalvage = previous?.lastSalvage;
    const nextSalvage = frame.persistence.lastSalvage;
    const same =
      previous !== undefined &&
      previous !== null &&
      previous.state === frame.persistence.state &&
      previous.failureRevision === frame.persistence.failureRevision &&
      previous.lastError?.message === frame.persistence.lastError?.message &&
      previous.lastError?.name === frame.persistence.lastError?.name &&
      previous.lastError?.code === frame.persistence.lastError?.code &&
      previous.lastError?.errno === frame.persistence.lastError?.errno &&
      previous.lastError?.category === frame.persistence.lastError?.category &&
      previous.lastError?.offset === frame.persistence.lastError?.offset &&
      (previousSalvage === null
        ? nextSalvage === null
        : nextSalvage !== null &&
          previousSalvage?.truncatedAt === nextSalvage.truncatedAt &&
          previousSalvage.discardedBytes === nextSalvage.discardedBytes &&
          previousSalvage.reason === nextSalvage.reason &&
          previousSalvage.detail === nextSalvage.detail &&
          previousSalvage.at === nextSalvage.at);
    this.ownerPersistence = {
      generation: frame.generation,
      sequence: frame.sequence,
      failureRevision: frame.persistence.failureRevision,
      value: same ? previous! : frame.persistence,
    };
    this.republishStatus();
    return true;
  }

  private receiveWorkerPersistence(payload: unknown) {
    if (this.acceptPersistence(payload, this.generation) && this.persistenceFollowers && !this.resourcesDisposed)
      this.queueFollowerPersistence(payload);
  }

  private queueFollowerPersistence(payload: unknown) {
    this.pendingFollowerFrame = payload;
    if (this.relayedWorkerRequests > 0) return;
    this.scheduleFollowerPersistenceFlush();
  }

  private scheduleFollowerPersistenceFlush() {
    if (this.followerPersistenceFlushQueued) return;
    this.followerPersistenceFlushQueued = true;
    if (!this.followerPersistenceChannel) {
      this.followerPersistenceChannel = new MessageChannel();
      this.followerPersistenceChannel.port1.onmessage = () => {
        this.followerPersistenceFlushQueued = false;
        const payload = this.pendingFollowerFrame;
        this.pendingFollowerFrame = undefined;
        if (payload !== undefined && this.persistenceFollowers && !this.resourcesDisposed)
          this.channel.postMessage({ type: PERSISTENCE_FRAME, payload });
      };
    }
    this.followerPersistenceChannel.port2.postMessage(null);
  }

  private postRelayResponse(message: Record<string, unknown>) {
    const persistence = this.pendingFollowerFrame;
    this.pendingFollowerFrame = undefined;
    this.channel.postMessage({ ...message, ...(persistence === undefined ? {} : { persistence }) });
  }

  private discardPendingFollowerFrame(reply: unknown) {
    const pending = parsePersistenceFrame(this.pendingFollowerFrame);
    const sent = parsePersistenceFrame(reply);
    if (pending && sent && pending.sequence <= sent.sequence) this.pendingFollowerFrame = undefined;
  }

  /** `request` is a follower's resync id: its reply is broadcast tagged with it, even if this leader drops it. */
  private requestWorkerPersistence(resync = false, request?: string) {
    if (!this.worker) return;
    const token = ++this.persistenceRequests;
    if (resync) this.persistenceResync = token;
    return this.requestWorker(PERSISTENCE_STATUS, { version: 1, generation: this.generation })
      .then((result) => {
        const fresh = this.persistenceResync === 0 || token >= this.persistenceResync;
        if (fresh) this.persistenceResync = 0;
        if (request === undefined) {
          if (fresh) this.receiveWorkerPersistence(result);
          return;
        }
        if (fresh) this.acceptPersistence(result, this.generation);
        if (!this.resourcesDisposed) {
          this.channel.postMessage({ type: PERSISTENCE_FRAME, payload: result, request });
          this.discardPendingFollowerFrame(result);
        }
      })
      .catch(() => {});
  }

  private recordCloseFailure(error: unknown) {
    this.closeFailure = error;
    this.closeFailed = true;
    if (this.resourcesDisposed && this.status.error === null)
      this.publishStatus('closed', null, null, toRemoteErrorDetails(error));
  }

  private refreshStatus() {
    if (this.closing || this.status.state === 'failed' || this.status.state === 'closed') return;
    if (this.isShuttingDown && !this.resourcesDisposed) return;
    if (!this.opened) {
      this.publishStatus('opening', null, null, null);
      return;
    }
    const role = this.isLeader ? 'leader' : 'follower';
    const ownerGeneration = this.isLeader
      ? this.leaderReady
        ? this.generation
        : null
      : (this.attachTo ?? this.leaderGeneration ?? null);
    this.publishStatus(ownerGeneration ? 'ready' : 'recovering', role, ownerGeneration, null);
  }

  private async initialize(forceLeader: boolean | undefined, initTimeout: number) {
    volumeFileNames(this.fileName);
    const root = await navigator.storage.getDirectory();
    if (await findVolumeFile(root, [this.fileName.replace(/\.bin$/, '.importing')])) {
      throw new VolumeImportingError(this.fileName);
    }
    this.checkAvailable('STAT');

    if (this.followerOnly) {
      await this.initFollowerOnly();
    } else if (this.attachTo !== undefined) {
      await probeWorker(this.fileName, initTimeout, this.abortController.signal).then((owner) => {
        this.checkAvailable('STAT');
        if (owner?.generation !== this.attachTo) {
          const error = makeCodedError(
            'The inspected owner is no longer available. Reconnect explicitly.',
            ATTACHMENT_LOST_CODE,
          );
          this.disposeLocalResources(error);
          throw error;
        }
      });
    } else if (forceLeader) {
      this.isLeader = true;
      await this.spawnWorker();
    } else {
      await this.initWithTimeout(initTimeout);
    }
  }

  private initFollowerOnly() {
    return new Promise<void>((resolve, reject) => {
      const expected = this.followerOnly!;
      this.onInitFailure = reject;
      this.onLeaderReady = (generation) => {
        if (generation !== expected.generation) {
          reject(makeCodedError('The SharedWorker generation changed. Reconnect explicitly.', ATTACHMENT_LOST_CODE));
          return;
        }
        if (this.clientLockRequested) return;
        this.clientLockRequested = true;
        this.leaderGeneration = generation;
        const lock = navigator.locks
          .request(
            `opfs-vfs-client-${this.fileName}-${this.attachmentId}`,
            { signal: this.abortController.signal },
            async () => {
              this.onLeaderReady = null;
              resolve();
              this.watchSharedOwner(expected.generation);
              await new Promise<void>((done) => {
                if (this.abortController.signal.aborted) done();
                else this.abortController.signal.addEventListener('abort', () => done(), { once: true });
              });
            },
          )
          .catch(reject);
        this.lockRequests.push(lock);
      };
      this.onLeaderReady(expected.generation);
    });
  }

  /** A follower may observe the owner lock, but never mounts or promotes on release. */
  private watchSharedOwner(generation: string) {
    const watch = navigator.locks
      .request(`opfs-vfs-lock-${this.fileName}`, { signal: this.abortController.signal }, async (lock) => {
        if (!lock || this.resourcesDisposed || this.closing) return;
        this.disposeLocalResources(
          makeCodedError(
            generation === this.followerOnly?.generation
              ? 'The SharedWorker owner stopped. Reconnect explicitly.'
              : 'The SharedWorker generation changed. Reconnect explicitly.',
            ATTACHMENT_LOST_CODE,
          ),
        );
      })
      .catch(() => {});
    this.lockRequests.push(watch);
  }

  private async initWithTimeout(initTimeout: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.init(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            // A Promise.race rejection alone leaves init()'s navigator.locks
            // request queued. It can acquire later and become a zombie leader
            // after the caller has already handled the timeout. Abort and
            // dispose the whole local topology before publishing rejection.
            const error = makeCodedError('VFS Initialization Timeout', INITIALIZATION_TIMEOUT_CODE);
            this.trace('initialization-timeout', INITIALIZATION_TIMEOUT_CODE);
            this.disposeLocalResources(error);
            reject(error);
          }, initTimeout);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async init() {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          this.onLeaderReady = null;
          this.onInitFailure = null;
          resolve();
        }
      };
      const fail = (error: unknown) => {
        if (!resolved) {
          resolved = true;
          this.onLeaderReady = null;
          this.onInitFailure = null;
          reject(error);
        }
      };
      this.onInitFailure = fail;
      this.onLeaderReady = this.claimIfAvailable
        ? null
        : (generation) => {
            if (!this.clientLockRequested) {
              this.clientLockRequested = true;
              this.leaderGeneration = generation;
              this.refreshStatus();
              this.trace('follower-client-lock-requested');
              const clientLock = navigator.locks
                .request(
                  `opfs-vfs-client-${this.fileName}-${this.attachmentId}`,
                  { signal: this.abortController.signal },
                  async () => {
                    this.trace('follower-client-lock-acquired');
                    try {
                      done();
                      await new Promise<void>((resolve) => {
                        if (this.abortController.signal.aborted) resolve();
                        else this.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
                      });
                    } finally {
                      this.trace('follower-client-lock-callback-finished');
                    }
                  },
                )
                .catch((error) => {
                  this.trace('follower-client-lock-failed');
                  fail(error);
                });
              this.lockRequests.push(clientLock);
            }
          };

      this.trace('owner-lock-requested', this.claimIfAvailable ? 'if-available' : 'wait');
      const ownerLock = navigator.locks
        .request(
          `opfs-vfs-lock-${this.fileName}`,
          this.claimIfAvailable ? { ifAvailable: true } : { signal: this.abortController.signal },
          async (lock) => {
            // A shared shutdown can release the owner lock before its reply arrives.
            // Finish that request before deciding whether this follower may take over.
            if (this.shutdownPromise) {
              let timeout: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  this.shutdownPromise.catch(() => {}),
                  new Promise<void>((resolve) => {
                    timeout = setTimeout(resolve, TAKEOVER_SHUTDOWN_TIMEOUT_MS);
                  }),
                ]);
              } finally {
                if (timeout !== undefined) clearTimeout(timeout);
              }
            }
            if (this.abortController.signal.aborted || this.isShuttingDown) return;
            if (this.closing) {
              // The owner lock proves the captured owner is gone, so reject its pending routed work.
              this.invalidateRouting();
              return;
            }
            if (!lock) {
              this.trace('owner-lock-unavailable');
              this.disposeLocalResources(makeCodedError('Volume is already in use', 'EBUSY'));
              return;
            }
            this.isLeader = true;
            this.trace('owner-lock-acquired');
            try {
              await this.spawnWorker();
              if (!this.abortController.signal.aborted && !this.isShuttingDown && !this.closing) {
                // SAB-6: leader is fully ready — announce it so already-waiting
                // followers can resolve, and answer future readiness pings.
                this.leaderReady = true;
                this.refreshStatus();
                this.trace('leader-ready-sent', 'initial');
                this.channel.postMessage({
                  type: 'LEADER_READY',
                  generation: this.generation,
                  profile: this.sharedProfile ?? this.profile,
                });
                done();
              }
              await new Promise((lockResolve) => {
                if (this.abortController.signal.aborted) lockResolve(undefined);
                else this.abortController.signal.addEventListener('abort', lockResolve, { once: true });
              });
            } catch (e) {
              fail(e);
            } finally {
              this.trace('owner-lock-callback-finished');
            }
          },
        )
        .catch((e) => {
          fail(e);
        });
      this.lockRequests.push(ownerLock);

      // Listen before requesting the lock, then ask an existing leader to
      // acknowledge readiness. A new leader broadcasts after completing INIT.
      if (!this.claimIfAvailable) {
        this.trace('leader-ping-sent', 'initial');
        this.channel.postMessage({ type: 'LEADER_PING' });
      }
    });
  }

  private spawnWorker() {
    this.invalidateRouting();
    this.generation = crypto.randomUUID();
    this.leaderReady = false;
    this.refreshStatus();
    this.initSent = false;
    this.trace('worker-spawn-requested');
    if (this.debug) {
      console.log('OpfsVfsWorker: Spawning worker...');
    }
    this.workerReady = this._spawnWorkerInner().then(
      () => {
        this.leaderReady = true;
        this.refreshStatus();
      },
      (error) => {
        this.disposeLocalResources(error);
        throw error;
      },
    );
    return this.workerReady;
  }

  private async _spawnWorkerInner() {
    this.worker = this.workerFactory();
    this.trace('worker-spawned');
    this.worker!.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.failWorker('VFS worker crashed', event.error ?? new Error(event.message));
    };
    this.worker!.addEventListener('messageerror', (event) =>
      this.failWorker('VFS worker response could not be decoded', event),
    );
    const worker = this.worker!;
    worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
      if (this.worker !== worker) return;
      const { id, type, result, data } = event.data;
      if (type === PERSISTENCE_FRAME) {
        if (this.persistenceResync === 0) this.receiveWorkerPersistence((event.data as { payload?: unknown }).payload);
        return;
      }
      if (type === 'FILE_CHANGES_FRAME' || type === 'FILE_CHANGES_INTERRUPTED' || type === 'FILE_CHANGES_CLOSED') {
        this.handleWorkerChangeMessage(type, result ?? (event.data as { payload?: unknown }).payload);
        return;
      }
      const pending = this.pendingRequests.get(id);
      if (pending) {
        if (type === 'ERROR') {
          const error = this.makeRemoteError(result);
          if (this.remoteErrors.has(error) && pending.dispatch) pending.dispatch.replied = true;
          pending.reject(error);
        } else {
          pending.resolve(withOptionalBuffer(result, data));
        }
        this.pendingRequests.delete(id);
      }
      // A frame riding on a reply is consumed even when its request already timed out: the worker sends it once.
      if (Object.hasOwn(event.data, 'persistence') && this.persistenceResync === 0)
        this.receiveWorkerPersistence(event.data.persistence);
    };

    await this.requestWorker('PING', {}, undefined, 5000);
    this.trace('worker-pong-received');

    if (this.debug) {
      console.log('OpfsVfsWorker: Worker PONG received, starting INIT...');
    }

    this.initSent = true;
    this.trace('worker-init-sent');
    const initialized = await this.requestWorker<{ profile: unknown }>(
      'INIT',
      {
        fileName: this.fileName,
        ...(this.messenger ? { sab: this.messenger.buffer } : {}),
        debug: this.debug,
        bufferMode: this.bufferMode,
        openMode: this.openMode,
        localDurabilityMode: this.localDurabilityMode,
        noatime: this.noatime,
        recoveryMode: this.recoveryMode,
        ...this.volumeOptions,
        plugins: this.pluginRequests,
        generation: this.generation,
      },
      undefined,
      this.initTimeout, // Mounting (hydration, WAL replay) scales with the volume.
    );
    const mismatch = mountProfileMismatch(initialized?.profile, this.profile);
    if (mismatch)
      throw makeCodedError(
        mismatch === 'VFS_PROTOCOL_MISMATCH'
          ? PROTOCOL_MISMATCH_MESSAGE
          : 'Worker mounted an incompatible plugin profile',
        mismatch,
      );
    this.trace('worker-init-complete');
    // Initial snapshot during readiness. A closing client skips it.
    if (!this.closing && !this.isShuttingDown) await this.requestWorkerPersistence();
  }

  private makeRemoteError(payload: unknown): Error & Partial<Omit<RemoteErrorDetails, 'message' | 'name'>> {
    const details = parseRemoteError(payload);
    if (!details) return new Error('Invalid VFS error response');
    const error = reviveRemoteError(details) as Error & Partial<Omit<RemoteErrorDetails, 'message' | 'name'>>;
    this.remoteErrors.add(error);
    return error;
  }

  private normalizeOpenFlags(flags: number | boolean | undefined): number {
    if (flags === true) {
      return OpenFlags.O_CREAT | OpenFlags.O_RDWR;
    }
    if (flags === false || flags === undefined) {
      return OpenFlags.O_RDONLY;
    }
    return flags;
  }

  private async handleBroadcastMessage(event: MessageEvent) {
    if (this.resourcesDisposed) return;
    const rawType = (event.data as { type?: unknown })?.type;
    if (typeof rawType === 'string' && rawType.startsWith('CHANGE_')) {
      await this.handleChangeBroadcast(event.data);
      return;
    }
    if (rawType === 'OBSERVER_PROBE') {
      if (this.standardWorker && this.isLeader && this.leaderReady && !this.isShuttingDown) {
        this.channel.postMessage({
          type: 'OBSERVER_INFO',
          id: event.data.id,
          protocol: 1,
          generation: this.generation,
        });
      }
      return;
    }
    if (rawType === 'OBSERVER_GONE') {
      if (this.attachTo !== undefined && event.data.generation === this.attachTo) {
        this.disposeLocalResources(
          makeCodedError(
            'The owner disconnected. Pending operation results may be unknown; reconnect explicitly.',
            ATTACHMENT_LOST_CODE,
          ),
        );
      }
      return;
    }
    if (rawType === 'OBSERVER_COMMAND') {
      if (this.standardWorker && this.isLeader) void this.handleObserverCommand(event.data);
      return;
    }
    if (rawType === PERSISTENCE_FRAME) {
      if (this.isLeader || this.attachTo !== undefined) return;
      const { payload, request } = event.data as { payload: unknown; request?: unknown };
      const tagged = hasExactOwnKeys(event.data, ['type', 'payload', 'request']);
      if (!tagged && !hasExactOwnKeys(event.data, ['type', 'payload'])) return;
      // While a snapshot request is outstanding, only its reply can prove the value is current.
      if (this.persistenceSnapshotRequest !== undefined && (!tagged || request !== this.persistenceSnapshotRequest))
        return;
      if (this.acceptPersistence(payload, this.leaderGeneration)) this.persistenceSnapshotRequest = undefined;
      return;
    }
    if (rawType === 'PERSISTENCE_REQUEST') {
      if (!hasExactOwnKeys(event.data, ['type', 'version', 'generation', 'request'])) return;
      const { version, generation, request } = event.data as {
        version: unknown;
        generation: unknown;
        request: unknown;
      };
      if (
        this.isLeader &&
        this.leaderReady &&
        !this.isShuttingDown &&
        version === 1 &&
        generation === this.generation &&
        isChangeId(request)
      ) {
        this.persistenceFollowers = true;
        void this.requestWorkerPersistence(false, request as string);
      }
      return;
    }
    if (
      (rawType === 'RESPONSE' || rawType === 'RESPONSE_ERROR') &&
      !this.isLeader &&
      this.attachTo === undefined &&
      this.persistenceSnapshotRequest === undefined &&
      Object.hasOwn(event.data, 'persistence')
    ) {
      this.acceptPersistence((event.data as { persistence: unknown }).persistence, this.leaderGeneration);
    }
    // SAB-6 readiness handshake (handled regardless of role):
    //  - A follower resolves its `ready` when a leader announces LEADER_READY.
    //  - A leader that is already ready answers a follower's LEADER_PING.
    if (rawType === 'LEADER_READY') {
      if (!this.isLeader && this.attachTo === undefined) {
        const { generation, profile } = event.data;
        const mismatch = this.followerOnly
          ? sharedMountProfileMismatch(profile, this.followerOnly.profile)
          : mountProfileMismatch(profile, this.profile);
        if (this.followerOnly && generation !== this.followerOnly.generation) {
          this.disposeLocalResources(
            makeCodedError('The SharedWorker generation changed. Reconnect explicitly.', ATTACHMENT_LOST_CODE),
          );
          return;
        }
        if (mismatch === 'VFS_PROTOCOL_MISMATCH') {
          this.disposeLocalResources(makeCodedError(PROTOCOL_MISMATCH_MESSAGE, mismatch));
          return;
        }
        if (this.openMode === 'create-new' && this.onLeaderReady && !this.followerOnly) {
          this.disposeLocalResources(makeCodedError('Volume already exists', 'EEXIST'));
          return;
        }
        if (generation !== this.leaderGeneration) this.invalidateRouting();
        if (typeof generation !== 'string' || !generation) {
          this.disposeLocalResources(
            makeCodedError('Owner has an incompatible or missing plugin profile', 'VFS_PLUGIN_MISMATCH'),
          );
          return;
        }
        if (mismatch) {
          this.disposeLocalResources(makeCodedError('Owner has an incompatible or missing plugin profile', mismatch));
          return;
        }
        this.leaderGeneration = generation;
        this.refreshStatus();
        this.trace('leader-ready-received');
        if (
          !this.ownerPersistence ||
          this.ownerPersistence.generation !== generation ||
          this.ownerPersistence.value === null
        ) {
          const request = crypto.randomUUID();
          this.persistenceSnapshotRequest = request;
          this.channel.postMessage({ type: 'PERSISTENCE_REQUEST', version: 1, generation, request });
        }
        this.onLeaderReady?.(generation);
      }
      return;
    }
    if (rawType === 'LEADER_PING') {
      this.trace('leader-ping-received');
      if (this.isLeader && this.leaderReady && !this.isShuttingDown) {
        this.trace('leader-ready-sent', 'reply');
        this.channel.postMessage({
          type: 'LEADER_READY',
          generation: this.generation,
          profile: this.sharedProfile ?? this.profile,
        });
      }
      return;
    }

    if (!this.isLeader) return;
    const message = event.data as LeaderCommandMessage | LeaderResponseMessage;
    const { id, type, data } = message;
    if (type === 'CANCEL') {
      const { clientId } = event.data as { clientId?: unknown };
      if (typeof clientId !== 'string') return;
      const key = `${clientId}:${id}`;
      const opened = this.completedOpens.get(key);
      const opening = this.pendingOpens.get(key);
      if (opened) {
        this.completedOpens.delete(key);
        this.clientFds.get(clientId)?.delete(opened.fd);
        void this.requestWorker('CLOSE', { fd: opened.fd }, undefined, LONG_COMMAND_TIMEOUT_MS).catch(() => {});
      } else if (opening) {
        opening.cancelled = true;
      } else {
        this.cancelledRelays.add(key);
        if (this.cancelledRelays.size > 1024) this.cancelledRelays.delete(this.cancelledRelays.values().next().value!);
      }
      return;
    }
    if (type === 'COMMAND' && 'payload' in message) {
      const { payload, tabId, clientId, generation } = message;
      const ownerGeneration = this.generation;
      if (generation !== ownerGeneration || this.deadClients.has(clientId)) {
        const error = makeCodedError(
          generation !== ownerGeneration
            ? 'The leader changed. Reconnect to use this volume.'
            : 'The follower disconnected. Reconnect to use this volume.',
          ATTACHMENT_LOST_CODE,
        );
        this.postRelayResponse({
          id,
          type: 'RESPONSE_ERROR',
          result: serializeRemoteError(error),
          tabId,
          generation: ownerGeneration,
        });
        return;
      }
      // Followers may relay filesystem commands only: an INIT or CLOSE_VFS would
      // re-initialise or close the leader's own mount underneath it.
      const refusal =
        this.isShuttingDown && payload.type !== 'SHUTDOWN_LEADER'
          ? makeCodedError('Shared VFS is shutting down', VFS_SHUTTING_DOWN_CODE)
          : LEADER_ONLY_COMMANDS.has(payload.type) || FILE_CHANGE_COMMANDS.has(payload.type)
            ? makeCodedError(`${payload.type} cannot be relayed to the leader`, 'EPERM')
            : undefined;
      if (refusal) {
        this.postRelayResponse({
          id,
          type: 'RESPONSE_ERROR',
          result: serializeRemoteError(refusal),
          tabId,
          generation: ownerGeneration,
        });
        return;
      }
      const key = `${clientId}:${id}`;
      const opening = payload.type === 'OPEN' ? { cancelled: this.cancelledRelays.delete(key) } : undefined;
      if (opening) this.pendingOpens.set(key, opening);
      const check = this.clientChecks.get(clientId) ?? this.watchClient(clientId);
      const live = await check;
      if (
        !live ||
        !this.isLeader ||
        generation !== this.generation ||
        this.clientChecks.get(clientId) !== check ||
        this.deadClients.has(clientId) ||
        this.resourcesDisposed
      ) {
        this.pendingOpens.delete(key);
        if (!this.resourcesDisposed) {
          const error = makeCodedError(
            'The follower disconnected. Reconnect to use this volume.',
            ATTACHMENT_LOST_CODE,
          );
          this.postRelayResponse({
            id,
            type: 'RESPONSE_ERROR',
            result: serializeRemoteError(error),
            tabId,
            generation: ownerGeneration,
          });
        }
        return;
      }
      // SEC-5 — BroadcastChannel trust model: a BroadcastChannel reaches every
      // same-origin browsing context, so ANY same-origin script (any tab,
      // worker, iframe) can send SHUTDOWN_LEADER and make the current leader
      // relinquish the OPFS locks. This is intentional and acceptable under the
      // VFS's stated single-origin / single-user trust model (the same script
      // could open the OPFS files directly). There is deliberately no
      // authentication of the sender; do NOT add cross-origin-style checks here
      // — the channel name is already origin- and database-scoped.
      if (payload.type === 'SHUTDOWN_LEADER') {
        this.beginLeaderShutdown(true)
          .then(() => {
            if (this.resourcesDisposed) return;
            this.postRelayResponse({ id, type: 'RESPONSE', result: 'OK', tabId, generation: ownerGeneration });
            queueMicrotask(() => {
              this.disposeLocalResources();
            });
          })
          .catch((error) => {
            this.recordCloseFailure(error);
            if (this.resourcesDisposed) return;
            this.postRelayResponse({
              id,
              type: 'RESPONSE_ERROR',
              result: serializeRemoteError(error),
              tabId,
              generation: ownerGeneration,
            });
            queueMicrotask(() => {
              this.disposeLocalResources();
            });
          });
        return;
      }
      this.relayedWorkerRequests++;
      const request = this.sendToWorker(payload.type, payload.payload, data, generation)
        .then(async (result) => {
          if (payload.type === 'OPEN' && typeof result === 'number') {
            if (opening?.cancelled || this.deadClients.has(clientId)) {
              await this.requestWorker('CLOSE', { fd: result }, undefined, LONG_COMMAND_TIMEOUT_MS);
              return;
            }
            this.clientFds.get(clientId)?.add(result);
            this.completedOpens.set(key, { clientId, fd: result });
          } else if (payload.type === 'CLOSE' && typeof payload.payload.fd === 'number') {
            for (const fds of this.clientFds.values()) fds.delete(payload.payload.fd);
            for (const [openKey, opened] of this.completedOpens) {
              if (opened.fd === payload.payload.fd) this.completedOpens.delete(openKey);
            }
          }
          this.cancelledRelays.delete(key);
          if (this.resourcesDisposed) return;
          const resData =
            isObject(result) && result.buffer instanceof Uint8Array ? (result.buffer as Uint8Array) : undefined;
          this.postRelayResponse({ id, type: 'RESPONSE', result, tabId, data: resData, generation: ownerGeneration });
        })
        .catch((error) => {
          this.cancelledRelays.delete(key);
          if (this.resourcesDisposed) return;
          this.postRelayResponse({
            id,
            type: 'RESPONSE_ERROR',
            result: serializeRemoteError(error),
            tabId,
            generation: ownerGeneration,
          });
        });
      const requests = this.clientRequests.get(clientId)!;
      requests.add(request);
      void request.finally(() => {
        requests.delete(request);
        this.pendingOpens.delete(key);
        if (--this.relayedWorkerRequests === 0 && this.pendingFollowerFrame !== undefined)
          this.scheduleFollowerPersistenceFlush();
      });
    }
  }

  private watchClient(clientId: string) {
    const lockName = `opfs-vfs-client-${this.fileName}-${clientId}`;
    const check = navigator.locks
      .request(lockName, { ifAvailable: true }, (lock) => {
        // A live follower holds this lock before sending its first command.
        if (lock || this.resourcesDisposed) return false;
        const fds = new Set<number>();
        this.clientFds.set(clientId, fds);
        this.clientRequests.set(clientId, new Set());
        void navigator.locks
          .request(lockName, { signal: this.abortController.signal }, async () => {
            this.deadClients.add(clientId);
            this.closeRelayedChangeChannels(clientId);
            await Promise.allSettled([...this.clientRequests.get(clientId)!]);
            for (const fd of fds) {
              try {
                await this.requestWorker('CLOSE', { fd }, undefined, LONG_COMMAND_TIMEOUT_MS);
              } catch {
                // The worker may already have closed during leader shutdown.
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            this.clientFds.delete(clientId);
            this.clientRequests.delete(clientId);
            this.clientChecks.delete(clientId);
            this.deadClients.delete(clientId);
            for (const [key, opened] of this.completedOpens) {
              if (opened.clientId === clientId) this.completedOpens.delete(key);
            }
          });
        return true;
      })
      .catch(() => false);
    this.clientChecks.set(clientId, check);
    void check.then((live) => {
      if (!live) this.clientChecks.delete(clientId);
    });
    return check;
  }

  private async handleChangeBroadcast(message: unknown) {
    if (!isObject(message)) return;
    const { type, id, generation, clientId, channelId, tabId } = message;
    if (
      type !== 'CHANGE_OPEN' &&
      type !== 'CHANGE_COMMAND' &&
      type !== 'CHANGE_CLOSE' &&
      type !== 'CHANGE_RESPONSE' &&
      type !== 'CHANGE_ERROR'
    )
      return;
    if (
      message.version !== 1 ||
      !Number.isSafeInteger(id) ||
      !isChangeId(generation) ||
      !isChangeId(clientId) ||
      !isChangeId(channelId) ||
      !isChangeId(tabId)
    )
      return;
    const changeGeneration = generation as string;
    const changeClientId = clientId as string;
    const changeChannelId = channelId as string;
    const reply = (result: unknown, error?: unknown, transportError?: string) => {
      if (!this.resourcesDisposed)
        this.channel.postMessage({
          type: error === undefined ? 'CHANGE_RESPONSE' : 'CHANGE_ERROR',
          version: 1,
          id,
          tabId,
          generation: this.generation,
          clientId,
          channelId,
          ...(error === undefined
            ? { result }
            : {
                result: transportError
                  ? serializeRemoteError({ message: transportError, code: ATTACHMENT_LOST_CODE })
                  : serializeChangeError(error),
              }),
        });
    };
    if (type === 'CHANGE_RESPONSE' || type === 'CHANGE_ERROR') return;
    const keys = Reflect.ownKeys(message);
    const allowed =
      type === 'CHANGE_COMMAND'
        ? ['type', 'version', 'id', 'tabId', 'generation', 'clientId', 'channelId', 'command']
        : ['type', 'version', 'id', 'tabId', 'generation', 'clientId', 'channelId'];
    if (keys.length !== allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return;
    if (!this.isLeader) return;
    const shuttingDown = this.isShuttingDown && type !== 'CHANGE_CLOSE';
    if (
      !this.leaderReady ||
      changeGeneration !== this.generation ||
      this.deadClients.has(changeClientId) ||
      shuttingDown
    ) {
      reply(
        undefined,
        makeCodedError(
          shuttingDown
            ? 'Shared VFS is shutting down'
            : this.deadClients.has(changeClientId)
              ? DISCONNECTED_FOLLOWER_CHANGE_ERROR
              : 'The leader changed. Reconnect to use this volume.',
          shuttingDown ? VFS_SHUTTING_DOWN_CODE : ATTACHMENT_LOST_CODE,
        ),
        this.deadClients.has(changeClientId) && !shuttingDown ? DISCONNECTED_FOLLOWER_CHANGE_ERROR : undefined,
      );
      return;
    }
    const key = changeKey(changeClientId, changeChannelId);
    if (type === 'CHANGE_OPEN') {
      const clientChannels = [...this.relayedChangeChannels.values()].filter(
        (channel) => channel.clientId === changeClientId,
      ).length;
      const clientOpenings = [...this.pendingRelayedChangeOpens.keys()].filter((opening) =>
        opening.startsWith(changeKeyPrefix(changeClientId)),
      ).length;
      if (
        this.relayedChangeChannels.size + this.pendingRelayedChangeOpens.size >= 128 ||
        clientChannels + clientOpenings >= 32
      ) {
        reply(undefined, makeCodedError('Too many file change channels', 'EMFILE'));
        return;
      }
      if (this.relayedChangeChannels.has(key)) return reply({ generation: this.generation });
      if (this.pendingRelayedChangeOpens.has(key)) {
        reply(undefined, makeCodedError('File change channel is already opening', 'EBUSY'));
        return;
      }
      const opening = { cancelled: false };
      this.pendingRelayedChangeOpens.set(key, opening);
      const check = this.clientChecks.get(changeClientId) ?? this.watchClient(changeClientId);
      if (
        !(await check) ||
        opening.cancelled ||
        this.resourcesDisposed ||
        this.isShuttingDown ||
        changeGeneration !== this.generation ||
        this.deadClients.has(changeClientId) ||
        this.clientChecks.get(changeClientId) !== check
      ) {
        this.pendingRelayedChangeOpens.delete(key);
        reply(
          undefined,
          this.isShuttingDown
            ? makeCodedError('Shared VFS is shutting down', VFS_SHUTTING_DOWN_CODE)
            : makeCodedError('The follower disconnected. Reconnect to use this volume.', ATTACHMENT_LOST_CODE),
          this.isShuttingDown ? undefined : DISCONNECTED_FOLLOWER_CHANGE_ERROR,
        );
        return;
      }
      try {
        const result = await this.requestWorker<{ generation: string }>('FILE_CHANGES_OPEN', {
          version: 1,
          generation: this.generation,
          clientId: changeClientId,
          channelId: changeChannelId,
          route: 'follower-relay',
        });
        if (
          opening.cancelled ||
          this.resourcesDisposed ||
          changeGeneration !== this.generation ||
          this.deadClients.has(changeClientId) ||
          this.clientChecks.get(changeClientId) !== check
        ) {
          this.pendingRelayedChangeOpens.delete(key);
          void this.requestWorker('FILE_CHANGES_CLOSE', {
            version: 1,
            generation: this.generation,
            clientId: changeClientId,
            channelId: changeChannelId,
            route: 'follower-relay',
          }).catch(() => {});
          return;
        }
        let lane = this.relayedChangeLanes.get(changeClientId);
        if (!lane) {
          lane = new BroadcastChannel(changeLaneName(this.fileName, this.generation, changeClientId));
          this.relayedChangeLanes.set(changeClientId, lane);
        }
        this.relayedChangeChannels.set(key, { clientId: changeClientId, channelId: changeChannelId });
        this.pendingRelayedChangeOpens.delete(key);
        reply(result);
      } catch (error) {
        this.pendingRelayedChangeOpens.delete(key);
        reply(undefined, error);
      }
      return;
    }
    if (type === 'CHANGE_CLOSE') {
      const opening = this.pendingRelayedChangeOpens.get(key);
      if (opening) opening.cancelled = true;
      this.closeRelayedChangeChannel(key);
      reply({ type: 'ok' });
      return;
    }
    if (type !== 'CHANGE_COMMAND' || !this.relayedChangeChannels.has(key) || !isObject(message.command)) {
      reply(undefined, makeCodedError('Invalid file change control', 'EINVAL'));
      return;
    }
    let snapshot: { command: ChangeCommand; charge: number };
    try {
      snapshot = snapshotChangeCommand(message.command, 16 * 1024 * 1024 - this.relayedChangeOptionBytes);
    } catch (error) {
      reply(undefined, error);
      return;
    }
    const command = snapshot.command;
    const registerKey =
      typeof command.subscriptionId === 'string'
        ? JSON.stringify([changeClientId, changeChannelId, command.subscriptionId])
        : undefined;
    if (command.type === 'cancel' && registerKey) {
      const pendingRegister = this.pendingRelayedRegisters.get(registerKey);
      if (pendingRegister) {
        pendingRegister.cancelled = true;
        reply({ type: 'ok' });
        return;
      }
    }
    const queued = this.relayedChangeControlCounts.get(changeClientId) ?? 0;
    if (queued >= 64) {
      if (command.type !== 'register') {
        this.relayedChangeLanes.get(changeClientId)?.postMessage({
          type: 'CHANGE_INTERRUPTED',
          version: 1,
          generation: this.generation,
          clientId: changeClientId,
          channelId: changeChannelId,
          code: 'SUBSCRIPTION_INTERRUPTED',
        });
        this.closeRelayedChangeChannel(key);
      }
      reply(undefined, makeCodedError('File change control queue is full', 'ENOSPC'));
      return;
    }
    if (command.type === 'register' && registerKey && !this.pendingRelayedRegisters.has(registerKey))
      this.pendingRelayedRegisters.set(registerKey, { cancelled: false });
    this.relayedChangeControlCounts.set(changeClientId, queued + 1);
    this.relayedChangeOptionBytes += snapshot.charge;
    const previous = this.relayedChangeControls.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        try {
          if (this.isShuttingDown) {
            reply(undefined, makeCodedError('Shared VFS is shutting down', VFS_SHUTTING_DOWN_CODE));
            return;
          }
          if (command.type === 'register' && registerKey) {
            const pendingRegister = this.pendingRelayedRegisters.get(registerKey);
            if (pendingRegister?.cancelled) {
              this.pendingRelayedRegisters.delete(registerKey);
              reply(undefined, makeCodedError('File change registration was cancelled', 'ECANCELED'));
              return;
            }
            this.pendingRelayedRegisters.delete(registerKey);
          }
          const result = await this.requestWorker<ChangeReply>('FILE_CHANGES_COMMAND', {
            version: 1,
            generation: this.generation,
            clientId: changeClientId,
            channelId: changeChannelId,
            route: 'follower-relay',
            command,
          });
          if (!isChangeReply(command, result)) throw makeCodedError('Invalid file change reply', 'EINVAL');
          reply(result);
        } catch (error) {
          if (
            command.type === 'register' &&
            (typeof error !== 'object' || error === null || !this.remoteErrors.has(error))
          ) {
            this.closeRelayedChangeChannel(key);
            reply(
              undefined,
              makeCodedError(
                'The file change registration outcome is unknown. Reconnect to use this volume.',
                ATTACHMENT_LOST_CODE,
              ),
            );
          } else reply(undefined, error);
        }
      });
    this.relayedChangeControls.set(key, task);
    void task.finally(() => {
      this.relayedChangeOptionBytes -= snapshot.charge;
      if (this.relayedChangeControls.get(key) === task) this.relayedChangeControls.delete(key);
      const remaining = (this.relayedChangeControlCounts.get(changeClientId) ?? 1) - 1;
      if (remaining > 0) this.relayedChangeControlCounts.set(changeClientId, remaining);
      else this.relayedChangeControlCounts.delete(changeClientId);
    });
  }

  private closeRelayedChangeChannel(key: string) {
    const channel = this.relayedChangeChannels.get(key);
    if (!channel) return;
    this.relayedChangeChannels.delete(key);
    this.relayedChangeControls.delete(key);
    const registerPrefix = JSON.stringify([channel.clientId, channel.channelId]).slice(0, -1);
    for (const registerKey of this.pendingRelayedRegisters.keys()) {
      if (registerKey.startsWith(registerPrefix)) this.pendingRelayedRegisters.delete(registerKey);
    }
    if (
      ![...this.relayedChangeChannels.values()].some((other) => other.clientId === channel.clientId) &&
      ![...this.pendingRelayedChangeOpens.keys()].some((opening) =>
        opening.startsWith(changeKeyPrefix(channel.clientId)),
      )
    ) {
      this.relayedChangeLanes.get(channel.clientId)?.close();
      this.relayedChangeLanes.delete(channel.clientId);
    }
    void Promise.resolve()
      .then(() =>
        this.requestWorker('FILE_CHANGES_CLOSE', {
          version: 1,
          generation: this.generation,
          clientId: channel.clientId,
          channelId: channel.channelId,
          route: 'follower-relay',
        }),
      )
      .catch(() => {});
  }

  private closeRelayedChangeChannels(clientId?: string) {
    for (const [key, channel] of this.relayedChangeChannels) {
      if (clientId === undefined || channel.clientId === clientId) this.closeRelayedChangeChannel(key);
    }
  }

  private closeRelayedLaneIfUnused(clientId: string) {
    if (
      [...this.relayedChangeChannels.values()].some((channel) => channel.clientId === clientId) ||
      [...this.pendingRelayedChangeOpens.keys()].some((opening) => opening.startsWith(changeKeyPrefix(clientId)))
    )
      return;
    this.relayedChangeLanes.get(clientId)?.close();
    this.relayedChangeLanes.delete(clientId);
  }

  private interruptRelayedChangeChannels() {
    for (const channel of this.relayedChangeChannels.values()) {
      this.relayedChangeLanes.get(channel.clientId)?.postMessage({
        type: 'CHANGE_INTERRUPTED',
        version: 1,
        generation: this.generation,
        clientId: channel.clientId,
        channelId: channel.channelId,
        code: 'SUBSCRIPTION_INTERRUPTED',
      });
    }
  }

  private handleWorkerChangeMessage(type: string, payload: unknown) {
    if (
      !isObject(payload) ||
      payload.version !== 1 ||
      payload.generation !== this.generation ||
      !isChangeId(payload.clientId) ||
      !isChangeId(payload.channelId)
    )
      return;
    const clientId = payload.clientId as string;
    const channelId = payload.channelId as string;
    const { route } = payload;
    if (route !== 'local' && route !== 'follower-relay') return;
    const fields =
      type === 'FILE_CHANGES_FRAME'
        ? ['version', 'generation', 'clientId', 'channelId', 'route', 'frame']
        : type === 'FILE_CHANGES_INTERRUPTED'
          ? ['version', 'generation', 'clientId', 'channelId', 'route', 'code']
          : type === 'FILE_CHANGES_CLOSED'
            ? ['version', 'generation', 'clientId', 'channelId', 'route']
            : [];
    if (
      fields.length === 0 ||
      Reflect.ownKeys(payload).length !== fields.length ||
      Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !fields.includes(key))
    )
      return;
    const key = changeKey(clientId, channelId);
    if (route === 'follower-relay') {
      const relay = this.relayedChangeChannels.get(key);
      const lane = this.relayedChangeLanes.get(clientId);
      if (!relay || !lane || !this.isLeader || this.resourcesDisposed) return;
      if (type === 'FILE_CHANGES_FRAME' && 'frame' in payload)
        lane.postMessage({
          type: 'CHANGE_FRAME',
          version: 1,
          generation: this.generation,
          clientId,
          channelId,
          frame: payload.frame,
        });
      else if (
        type === 'FILE_CHANGES_INTERRUPTED' &&
        (payload.code === 'SUBSCRIPTION_INTERRUPTED' || payload.code === 'SUBSCRIPTION_RESYNC_REQUIRED')
      ) {
        lane.postMessage({
          type: 'CHANGE_INTERRUPTED',
          version: 1,
          generation: this.generation,
          clientId,
          channelId,
          code: payload.code,
        });
        this.relayedChangeChannels.delete(key);
        this.closeRelayedLaneIfUnused(clientId);
      } else if (type === 'FILE_CHANGES_CLOSED') {
        lane.postMessage({ type: 'CHANGE_CLOSED', version: 1, generation: this.generation, clientId, channelId });
        this.relayedChangeChannels.delete(key);
        this.closeRelayedLaneIfUnused(clientId);
      }
      return;
    }
    const local = this.changeChannels.get(channelId);
    if (!local || local.closedState || clientId !== this.attachmentId || !this.isLeader) return;
    const frame = type === 'FILE_CHANGES_FRAME' ? snapshotChangeFrame(payload.frame, local.generation) : undefined;
    if (type === 'FILE_CHANGES_FRAME' && frame) {
      this.markLocalTerminal(channelId, frame);
      this.deliverChange(local, 'frame', frame);
    } else if (
      type === 'FILE_CHANGES_INTERRUPTED' &&
      (payload.code === 'SUBSCRIPTION_INTERRUPTED' || payload.code === 'SUBSCRIPTION_RESYNC_REQUIRED')
    ) {
      local.closedState = true;
      this.changeChannels.delete(channelId);
      this.releaseLocalChangeSubscriptions(channelId);
      this.notifyChange(local, 'interrupted', payload.code);
    } else if (type === 'FILE_CHANGES_CLOSED') {
      local.closedState = true;
      this.changeChannels.delete(channelId);
      this.releaseLocalChangeSubscriptions(channelId);
      this.notifyChange(local, 'closed');
    }
  }

  private deliverChange(channel: ChangeCallbacks, kind: 'frame' | 'interrupted' | 'closed', value?: unknown) {
    queueMicrotask(() => {
      if (channel.closedState) return;
      try {
        if (kind === 'frame') channel.receive(value as ChangeFrame);
        else if (kind === 'interrupted')
          channel.interrupted(value as 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED');
        else channel.closed();
      } catch {
        // Subscription callbacks never run in transport dispatch.
      }
    });
  }

  private notifyChange(channel: ChangeCallbacks, kind: 'interrupted' | 'closed', value?: unknown) {
    queueMicrotask(() => {
      if (channel.clientClosed) return;
      try {
        if (kind === 'interrupted')
          channel.interrupted(value as 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED');
        else channel.closed();
      } catch {
        // Lifecycle notifications are isolated from transport dispatch.
      }
    });
  }

  private async handleObserverCommand(message: unknown) {
    if (
      !isObject(message) ||
      typeof message.id !== 'number' ||
      typeof message.tabId !== 'string' ||
      typeof message.generation !== 'string' ||
      !isObject(message.payload) ||
      typeof message.payload.type !== 'string' ||
      !isObject(message.payload.payload)
    )
      return;
    const { id, tabId, generation } = message;
    const { type, payload } = message.payload;
    try {
      await this.ready;
      await this.workerReady;
      if (!this.isLeader || !this.leaderReady || this.isShuttingDown || generation !== this.generation) {
        throw makeCodedError('The inspected owner is no longer available. Reconnect explicitly.', ATTACHMENT_LOST_CODE);
      }
      if (!OBSERVER_COMMANDS.has(type)) throw makeCodedError('Command is unavailable to passive attachments', 'EPERM');
      const result = await this.requestWorker(
        type,
        payload,
        message.data instanceof Uint8Array ? message.data : undefined,
      );
      if (!this.resourcesDisposed)
        this.channel.postMessage({ id, tabId, generation, type: 'OBSERVER_RESPONSE', result });
    } catch (error) {
      if (!this.resourcesDisposed)
        this.channel.postMessage({
          id,
          tabId,
          generation,
          type: 'OBSERVER_RESPONSE_ERROR',
          result: serializeRemoteError(error),
        });
    }
  }

  private async sendToWorker<T = unknown>(
    type: string,
    payload: WorkerCommandPayload,
    data?: Uint8Array,
    generation?: string,
    dispatch?: DispatchRecord,
  ): Promise<T> {
    this.checkAvailable(type);
    await this.ready;
    this.checkAvailable(type);
    // Role-aware: a follower compares the caller's captured owner token, not its own unused generation.
    if (
      generation !== undefined &&
      generation !== (this.isLeader ? this.generation : (this.attachTo ?? this.leaderGeneration))
    )
      throw makeCodedError('The leader changed. Reconnect to use this volume.', ATTACHMENT_LOST_CODE);
    if (!this.isLeader) {
      this.checkDescriptorGeneration(payload, generation);
      return this.sendToLeader(type, payload, data, generation, dispatch);
    }
    await (this.leaderReady ? this.workerReady : Promise.race([this.workerReady, this.closedSignal]));
    this.checkAvailable(type);
    if (generation !== undefined && generation !== this.generation)
      throw makeCodedError('The leader changed. Reconnect to use this volume.', ATTACHMENT_LOST_CODE);
    this.checkDescriptorGeneration(payload, generation);
    const result = await this.requestWorker<T>(type, payload, data, undefined, dispatch);
    if (type === 'OPEN' && generation === undefined && typeof result === 'number') this.relayedFds.delete(result);
    return result;
  }

  private checkDescriptorGeneration(payload: WorkerCommandPayload, generation?: string) {
    if (generation !== undefined || typeof payload.fd !== 'number') return;
    const issued = this.relayedFds.get(payload.fd);
    const current = this.isLeader ? this.generation : this.leaderGeneration;
    if (issued !== undefined && issued !== current) {
      throw makeCodedError('The descriptor belongs to the previous leader. Reopen the file.', ATTACHMENT_LOST_CODE);
    }
  }

  private invalidateRouting(reason = 'The owner changed.') {
    const error = makeCodedError(
      `${reason} Pending operation results are unknown; do not retry automatically.`,
      ATTACHMENT_LOST_CODE,
    );
    this.closeLocalChangeChannels('SUBSCRIPTION_INTERRUPTED');
    this.localChangeSubscriptions.clear();
    this.localChangeTerminalIds.clear();
    this.closeRelayedChangeChannels();
    for (const pending of this.pendingChangeRequests.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingChangeRequests.clear();
    // Drop the value but keep the generation's sequence and revision floor: a renegotiation with the same
    // owner (resume) must still reject frames from before it, and a new generation replaces the record.
    if (this.ownerPersistence) this.ownerPersistence = { ...this.ownerPersistence, value: null };
    this.persistenceFollowers = false;
    this.pendingFollowerFrame = undefined;
    this.persistenceResync = 0;
    this.leaderGeneration = undefined;
    for (const [id, pending] of this.pendingRequests) {
      this.channel.postMessage({ type: 'CANCEL', id, clientId: this.attachmentId });
      pending.reject(error);
    }
    this.refreshStatus();
  }

  /** Local close has started: stop public admission synchronously. */
  private beginClosing() {
    if (this.closing) return;
    this.closing = true;
    if (!this.resourcesDisposed) this.publishStatus('closing', this.status.role, this.status.ownerGeneration, null);
    const error = makeCodedError('Shared VFS is shutting down', VFS_SHUTTING_DOWN_CODE);
    this.rejectReady?.(error);
    this.onInitFailure?.(error);
  }

  private checkAvailable(type: string, closePath = false) {
    if (this.workerFailure) throw this.workerFailure;
    if (this.resourcesDisposed || (!closePath && (this.closing || this.isShuttingDown))) {
      throw makeCodedError('Shared VFS is shutting down', VFS_SHUTTING_DOWN_CODE);
    }
    if (this.attachTo !== undefined && !OBSERVER_COMMANDS.has(type)) {
      throw makeCodedError('Command is unavailable to passive attachments', 'EPERM');
    }
  }

  private requestWorker<T = unknown>(
    type: string,
    payload: WorkerCommandPayload,
    data?: Uint8Array,
    // Durability barriers and full listings scale with the volume.
    timeoutMs = commandTimeout(type),
    dispatch?: DispatchRecord,
  ): Promise<T> {
    if (!this.worker) {
      throw makeCodedError('Shared VFS worker is unavailable');
    }
    const worker = this.worker;

    return new Promise<T>((resolve, reject) => {
      const id = ++this.messageId;
      const timeout = setTimeout(() => {
        this.failWorker(`VFS worker ${type} timed out after ${timeoutMs}ms`, new Error(`No response to ${type}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
      };
      this.pendingRequests.set(id, {
        dispatch,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      try {
        // Only transfer (and thus detach) the caller's buffer when the view owns
        // its entire backing ArrayBuffer. A subarray view into a larger buffer
        // (e.g. an Emscripten/app heap) would otherwise detach unrelated data, so
        // we copy those into a fresh buffer and transfer the copy instead.
        // SharedArrayBuffer is not transferable, so it is always copied.
        const ownsFullBuffer =
          data !== undefined &&
          data.buffer instanceof ArrayBuffer &&
          data.byteOffset === 0 &&
          data.byteLength === data.buffer.byteLength;
        const outData = data === undefined ? undefined : ownsFullBuffer ? data : data.slice();
        // outData is either the caller's full-owner view or a fresh slice; both
        // fully own a plain ArrayBuffer, so it is always safe to transfer.
        worker.postMessage({ id, type, payload, data: outData }, outData ? [outData.buffer] : []);
        if (dispatch) dispatch.sent = true;
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private beginLeaderShutdown(interruptLocalChanges = false) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.isShuttingDown = true;
    if (!this.resourcesDisposed) this.publishStatus('closing', this.status.role, this.status.ownerGeneration, null);
    if (this.standardWorker) this.channel.postMessage({ type: 'OBSERVER_GONE', generation: this.generation });
    this.shutdownPromise = this.releaseLeaderResources(interruptLocalChanges);
    return this.shutdownPromise;
  }

  private async releaseLeaderResources(interruptLocalChanges = false) {
    let releaseError: unknown;
    try {
      this.interruptRelayedChangeChannels();
      if (interruptLocalChanges) this.closeLocalChangeChannels('SUBSCRIPTION_INTERRUPTED');
      const worker = this.worker;
      if (worker && this.initSent) {
        // Before INIT, nothing is mounted, so terminate directly.
        // Wait for initialization itself, never public readiness. A failed start disposes itself.
        const mounted = await this.workerReady!.then(
          () => true,
          () => false,
        );
        if (mounted && this.worker === worker) await this.requestWorker('CLOSE_VFS', {});
      }
    } catch (error) {
      releaseError = error;
    }

    this.worker?.terminate();
    this.worker = null;
    this.isLeader = false;
    this.leaderReady = false;

    if (releaseError) throw releaseError;
  }

  private failWorker(message: string, cause: unknown) {
    this.workerFailure ??= Object.assign(new Error(message, { cause }), { code: 'VFS_WORKER_FAILED' });
    this.disposeLocalResources(this.workerFailure);
  }

  private disposeLocalResources(disposalError?: unknown) {
    if (this.resourcesDisposed) return;
    const error = disposalError ?? new Error('VFS worker disposed');
    this.trace('terminal-dispose', disposalError === undefined ? 'closed' : 'failed');
    if (this.standardWorker && this.isLeader) {
      this.channel.postMessage({ type: 'OBSERVER_GONE', generation: this.generation });
    }
    this.resourcesDisposed = true;
    this.ownerPersistence = undefined;
    this.persistenceFollowers = false;
    this.pendingFollowerFrame = undefined;
    this.persistenceResync = 0;
    const closeError = this.closing ? (disposalError ?? this.closeFailure) : undefined;
    const failed = !this.closing && disposalError !== undefined;
    this.publishStatus(
      failed ? 'failed' : 'closed',
      null,
      null,
      failed
        ? toRemoteErrorDetails(disposalError)
        : closeError !== undefined
          ? toRemoteErrorDetails(closeError)
          : this.closeFailed
            ? toRemoteErrorDetails(this.closeFailure)
            : null,
    );
    this.rejectReady?.(error);
    this.closeLocalChangeChannels('SUBSCRIPTION_INTERRUPTED');
    this.followerChangeLane?.lane.close();
    this.followerChangeLane = undefined;
    this.localChangeSubscriptions.clear();
    this.localChangeTerminalIds.clear();
    this.closeRelayedChangeChannels();
    for (const pending of this.pendingChangeRequests.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingChangeRequests.clear();
    this.isShuttingDown = true;
    this.leaderReady = false;
    this.leaderGeneration = undefined;
    this.pluginRequests = [];
    this.onInitFailure?.(error);
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    // The endpoint finalizer closes the SharedWorker before releasing the
    // coordinator lock. The volume's exclusive storage lock fences a brief
    // teardown race; ordinary command errors never reach this path.
    if (this.sharedHost && this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (!this.abortController.signal.aborted) this.abortController.abort();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isLeader = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('resume', this.resumePersistence);
      globalThis.removeEventListener('pageshow', this.onPageShow);
      if (this.debugLifecycleListeners) {
        document.removeEventListener('visibilitychange', this.debugLifecycleListeners.visibilitychange);
        globalThis.removeEventListener('pagehide', this.debugLifecycleListeners.pagehide);
        document.removeEventListener('freeze', this.debugLifecycleListeners.freeze);
        this.debugLifecycleListeners = undefined;
      }
    }
    this.channel.close();
    this.transportClose?.();
  }

  private relayTimeout(type: string) {
    return this.attachTo !== undefined && !LONG_COMMANDS.has(type) ? OBSERVER_COMMAND_TIMEOUT_MS : commandTimeout(type);
  }

  private async sendToLeader<T = unknown>(
    type: string,
    payload: WorkerCommandPayload,
    data?: Uint8Array,
    generation?: string,
    dispatch?: DispatchRecord,
    closePath = false,
  ): Promise<T> {
    this.checkAvailable(type, closePath);
    if (this.attachTo === undefined && generation === undefined && !this.leaderGeneration) {
      this.channel.postMessage({ type: 'LEADER_PING' });
      throw makeCodedError('Owner profile has not been negotiated', LEADER_NOT_READY_CODE);
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++this.messageId;
      const tabId = this.attachmentId;
      const expectedGeneration = this.attachTo ?? generation ?? this.leaderGeneration;

      const timeout = setTimeout(() => {
        const error = makeCodedError(
          `Timeout waiting for leader response for ${type}. The operation result is unknown; do not retry automatically.`,
          LEADER_RESPONSE_TIMEOUT_CODE,
        );
        if (this.attachTo !== undefined) this.disposeLocalResources(error);
        else {
          this.channel.postMessage({ type: 'CANCEL', id, clientId: this.attachmentId });
          pending.reject(error);
        }
      }, this.relayTimeout(type));
      const cleanup = () => {
        clearTimeout(timeout);
        this.channel.removeEventListener('message', listener);
        this.pendingRequests.delete(id);
      };
      const pending: PendingRequest = {
        dispatch,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.pendingRequests.set(id, pending);

      const listener = (event: MessageEvent<LeaderResponseMessage>) => {
        const { id: respId, type: respType, result, tabId: respTabId, data: respData, generation } = event.data;
        if (respId === id && respTabId === tabId) {
          const observer = this.attachTo !== undefined;
          if (
            observer &&
            (generation !== this.attachTo || !['OBSERVER_RESPONSE', 'OBSERVER_RESPONSE_ERROR'].includes(respType))
          )
            return;
          if (!observer && !['RESPONSE', 'RESPONSE_ERROR'].includes(respType)) return;
          if (!observer && (typeof generation !== 'string' || generation !== expectedGeneration)) {
            this.channel.postMessage({ type: 'CANCEL', id, clientId: this.attachmentId });
            pending.reject(
              makeCodedError(
                'The leader response belongs to a different generation. The operation result is unknown; do not retry automatically.',
                ATTACHMENT_LOST_CODE,
              ),
            );
            this.invalidateRouting();
            this.channel.postMessage({ type: 'LEADER_PING' });
            return;
          }
          if (respType === 'RESPONSE_ERROR' || respType === 'OBSERVER_RESPONSE_ERROR') {
            const error = this.makeRemoteError(result);
            if (this.remoteErrors.has(error) && dispatch) dispatch.replied = true;
            if (observer && error.code === ATTACHMENT_LOST_CODE) this.disposeLocalResources(error);
            else pending.reject(error);
          } else {
            if (!observer && type === 'OPEN' && typeof result === 'number')
              this.relayedFds.set(result, expectedGeneration!);
            if (!observer && type === 'CLOSE' && typeof payload.fd === 'number') this.relayedFds.delete(payload.fd);
            pending.resolve(withOptionalBuffer(result, respData));
          }
        }
      };

      this.channel.addEventListener('message', listener);
      try {
        this.channel.postMessage({
          id,
          type: this.attachTo === undefined ? 'COMMAND' : 'OBSERVER_COMMAND',
          generation: expectedGeneration,
          clientId: this.attachmentId,
          payload: { type, payload },
          tabId,
          data,
        });
        if (dispatch) dispatch.sent = true;
      } catch (error) {
        pending.reject(error);
      }
    });
  }

  // Synchronous API (SAB)
  /**
   * SAB-6: gate every synchronous call on leadership. Only the leader runs a
   * listen() loop on the shared SAB, so a follower's call would otherwise block
   * for the entire 30s timeout. We also require the worker to exist (the leader
   * has finished spawning) so a sync call issued before `ready` resolves fails
   * with a clear LEADER_NOT_READY instead of a confusing protocol error.
   */
  private syncCall<T = unknown>(
    type: string,
    payload: WorkerCommandPayload,
    data?: Uint8Array,
    opts?: { dataSink?: Uint8Array },
  ): T {
    this.checkAvailable(type);
    if (!this.isLeader) {
      throw makeCodedError(
        `Synchronous VFS call (${type}) is only available on the leader tab; this instance is a follower. Use the async API or elect this tab as leader.`,
        NOT_LEADER_CODE,
      );
    }
    if (!this.worker || !this.leaderReady) {
      throw makeCodedError(
        `Synchronous VFS call (${type}) issued before the leader worker was ready.`,
        LEADER_NOT_READY_CODE,
      );
    }
    this.checkDescriptorGeneration(payload);
    const messenger = this.messenger;
    if (!messenger)
      throw makeCodedError(`Synchronous VFS call (${type}) is unavailable in a SharedWorker host.`, 'VFS_UNSUPPORTED');
    return messenger.call<T>(type, payload, data, opts);
  }

  private syncMessenger(): SyncMessenger {
    if (!this.messenger)
      throw makeCodedError('Synchronous VFS calls are unavailable in a SharedWorker host.', 'VFS_UNSUPPORTED');
    return this.messenger;
  }

  // SAB-5 follow-up: fds this proxy opened with O_APPEND. The core IGNORES
  // explicit offsets on append fds (every write targets EOF and advances the
  // cursor there), so the chunked-write path must not snapshot/restore the
  // cursor for them — it would drag the cursor away from EOF. Tracked here
  // because the worker-side fd table has no flags-query API.
  private appendFds = new Set<number>();

  mkdirSync(path: string, modeOrOptions?: number | MkdirOptions) {
    return this.syncCall<void>('MKDIR', { path, ...this.normalizeMkdirArgs(modeOrOptions) });
  }
  openSync(path: string, flags: number | boolean = 0, mode?: number): number {
    const normalizedFlags = this.normalizeOpenFlags(flags);
    const fd = this.syncCall<number>('OPEN', { path, flags: normalizedFlags, mode });
    this.relayedFds.delete(fd);
    if ((normalizedFlags & OpenFlags.O_APPEND) !== 0) this.appendFds.add(fd);
    else this.appendFds.delete(fd); // fd numbers can be reused after close
    return fd;
  }
  /**
   * SAB-5: a single SAB frame is capped at ~payloadCapacity bytes (see
   * {@link SyncMessenger.maxDataBytesPerCall}). Writes larger than that are
   * transparently split into capacity-sized pwrite chunks at explicit offsets,
   * so chunk N+1 never depends on cursor state left by chunk N. When the caller
   * used the implicit cursor (`offset === undefined`) we snapshot the cursor via
   * SEEK_CUR, issue explicit-offset pwrites, then SEEK_SET the cursor to the end
   * to preserve sequential-write semantics. O_APPEND fds are chunked as
   * implicit-cursor writes instead: the core targets EOF and advances the cursor
   * for every append write (explicit offsets are ignored there), so each chunk
   * appends in order and the cursor lands at EOF with no snapshot/restore.
   * NOTE: a chunked write is no longer atomic — a crash or a
   * concurrent writer to the same fd can interleave between chunks. This is an
   * accepted limitation for transfers above the per-message cap; we do not lock.
   */
  writeSync(fd: number, data: Uint8Array, offset?: number): number {
    const max = this.syncMessenger().maxDataBytesPerCall;
    if (data.length <= max || max <= 0) {
      return this.syncCall<number>('WRITE', { fd, offset }, data);
    }
    if (this.appendFds.has(fd)) {
      // O_APPEND: implicit-cursor chunks. The core appends each one at EOF and
      // leaves the cursor there; a forced SEEK_SET to base+written would be
      // wrong whenever the file had prior content.
      let written = 0;
      while (written < data.length) {
        const chunk = data.subarray(written, written + max);
        const n = this.syncCall<number>('WRITE', { fd }, chunk);
        if (n <= 0) break;
        written += n;
        if (n < chunk.length) break; // short write: stop and report what landed
      }
      return written;
    }
    // Determine the base offset to write at. For an explicit offset (pwrite) we
    // chunk from there. For the implicit cursor we read it first, then restore.
    const usingCursor = offset === undefined;
    const base = usingCursor ? this.seekSync(fd, 0, 1) : offset;
    let written = 0;
    while (written < data.length) {
      const chunk = data.subarray(written, written + max);
      const n = this.syncCall<number>('WRITE', { fd, offset: base + written }, chunk);
      if (n <= 0) break;
      written += n;
      if (n < chunk.length) break; // short write: stop and report what landed
    }
    if (usingCursor) {
      // Restore sequential semantics: advance the implicit cursor past the data.
      this.seekSync(fd, base + written, 0);
    }
    return written;
  }
  /**
   * SAB-5: reads larger than the per-message cap loop in capacity-sized chunks
   * at explicit offsets and reassemble into one buffer. As with writes, chunked
   * reads are not atomic with respect to a concurrent writer.
   */
  readSync(fd: number, size: number, offset?: number): { buffer: Uint8Array; read: number } {
    const max = this.syncMessenger().maxDataBytesPerCall;
    if (size <= max || max <= 0) {
      const res = this.syncCall<{ data?: Uint8Array; read?: number }>('READ', { fd, size, offset });
      return { buffer: res.data ?? new Uint8Array(0), read: res.read ?? 0 };
    }
    const out = new Uint8Array(size);
    const read = this.readIntoChunked(fd, out, offset, size);
    return { buffer: out.subarray(0, read), read };
  }
  /**
   * PERF-11 + SAB-5: proxy `readInto` copies straight from the SAB payload
   * region into the caller-provided view, restoring the adapter's zero-copy
   * fast path (adapter prefers `vfs.readInto` when present). Reads larger than
   * the per-message cap are chunked into successive subviews of `target`.
   */
  readInto(fd: number, target: Uint8Array, position?: number): number {
    return this.readIntoChunked(fd, target, position, target.length);
  }
  private readIntoChunked(fd: number, target: Uint8Array, offset: number | undefined, size: number): number {
    const max = this.syncMessenger().maxDataBytesPerCall;
    const limit = Math.min(size, target.length);
    // Single-shot fast path when the request fits in one frame. The dataSink
    // copies SAB -> target directly (PERF-11), no intermediate allocation.
    if (limit <= max || max <= 0) {
      const res = this.syncCall<{ read?: number }>('READ', { fd, size: limit, offset }, undefined, {
        dataSink: target.subarray(0, limit),
      });
      return res.read ?? 0;
    }
    // Chunked: explicit offsets so chunk N+1 is independent of cursor state.
    const usingCursor = offset === undefined;
    const base = usingCursor ? this.seekSync(fd, 0, 1) : offset;
    let done = 0;
    while (done < limit) {
      const want = Math.min(max, limit - done);
      const res = this.syncCall<{ read?: number }>('READ', { fd, size: want, offset: base + done }, undefined, {
        dataSink: target.subarray(done, done + want),
      });
      const read = res.read ?? 0;
      if (read <= 0) break;
      done += read;
      if (read < want) break; // hit EOF
    }
    if (usingCursor) this.seekSync(fd, base + done, 0);
    return done;
  }
  seekSync(fd: number, offset: number, whence: number): number {
    return this.syncCall<number>('SEEK', { fd, offset, whence });
  }
  closeSync(fd: number) {
    this.syncCall<void>('CLOSE', { fd });
    this.appendFds.delete(fd);
  }
  fstatSync(fd: number): VfsStat {
    return this.syncCall<VfsStat>('FSTAT', { fd });
  }
  fsyncSync(fd: number) {
    this.syncCall<void>('FSYNC', { fd });
  }
  ftruncateSync(fd: number, size: number) {
    this.syncCall<void>('FTRUNCATE', { fd, size });
  }
  chmodSync(path: string, mode: number) {
    this.syncCall<void>('CHMOD', { path, mode });
  }
  utimesSync(path: string, atimeMs: number, mtimeMs: number) {
    this.syncCall<void>('UTIMES', { path, atimeMs, mtimeMs });
  }
  symlinkSync(target: string, path: string, mode?: number) {
    this.syncCall<void>('SYMLINK', { target, path, mode });
  }
  linkSync(existingPath: string, newPath: string) {
    this.syncCall<void>('LINK', { existingPath, newPath });
  }
  readlinkSync(path: string): string {
    return this.syncCall<string>('READLINK', { path });
  }
  realpathSync(path: string): string {
    return this.syncCall<string>('REALPATH', { path });
  }
  unlinkSync(path: string) {
    this.syncCall<void>('UNLINK', { path });
  }
  rmdirSync(path: string) {
    this.syncCall<void>('RMDIR', { path });
  }
  removeSync(path: string) {
    this.syncCall<void>('REMOVE', { path });
  }
  renameSync(oldPath: string, newPath: string) {
    return this.syncCall<void>('RENAME', { oldPath, newPath });
  }
  truncateSync(path: string, size: number) {
    return this.syncCall<void>('TRUNCATE', { path, size });
  }
  existsSync(path: string): boolean {
    return this.syncCall<boolean>('EXISTS', { path });
  }
  statSync(path: string): VfsStat {
    return this.syncCall<VfsStat>('STAT', { path });
  }
  lstatSync(path: string): VfsStat {
    return this.syncCall<VfsStat>('LSTAT', { path });
  }
  readdirSync(path: string): string[] {
    return this.syncCall<string[]>('READDIR', { path });
  }
  readdirNamesSync(path: string): string[] {
    return this.syncCall<string[]>('READDIR_NAMES', { path });
  }
  readdirEntriesSync(path: string): VfsDirEntry[] {
    return this.syncCall<VfsDirEntry[]>('READDIR_ENTRIES', { path });
  }
  listPathsSync(): string[] {
    return this.syncCall<string[]>('LIST_PATHS', {});
  }
  syncSync() {
    this.syncCall<void>('SYNC', {});
  }

  async flushVfs() {
    await this.sendToWorker('FLUSH', {});
  }

  closeVfs(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const close = this.closeWorker();
    this.closePromise = close;
    const clear = () => {
      if (this.closePromise === close) this.closePromise = null;
    };
    void close.then(clear, clear);
    return close;
  }

  private async closeWorker() {
    const owner = !this.isLeader && this.opened ? (this.leaderGeneration ?? null) : undefined;
    this.beginClosing();
    if (this.attachTo !== undefined || this.resourcesDisposed || (this.isShuttingDown && this.worker === null)) {
      this.disposeLocalResources();
      // closeVfs settles only after its election and attachment locks are released.
      await Promise.allSettled(this.lockRequests);
      return;
    }
    let closeError: unknown;
    try {
      if (this.isLeader) {
        await this.beginLeaderShutdown();
      } else if (typeof owner === 'string') {
        await this.sendToLeader('FLUSH', {}, undefined, owner, undefined, true);
      } else if (owner === null) {
        throw makeCodedError('The owner changed before close. Its flush result is unknown.', ATTACHMENT_LOST_CODE);
      }
    } catch (error) {
      closeError = error;
      this.recordCloseFailure(error);
    } finally {
      this.disposeLocalResources();
      // closeVfs settles only after its election and attachment locks are released.
      await Promise.allSettled(this.lockRequests);
    }
    if (closeError) throw closeError;
  }

  async shutdownSharedVfs() {
    if (this.followerOnly && this.shutdownPromise) return this.shutdownPromise;
    this.checkAvailable('SHUTDOWN_LEADER');
    if (this.followerOnly) {
      if (this.shutdownPromise) return this.shutdownPromise;
      const generation = this.leaderGeneration;
      if (this.status.state !== 'ready' || generation !== this.followerOnly.generation)
        throw makeCodedError('The SharedWorker owner is not ready. Reconnect explicitly.', LEADER_NOT_READY_CODE);
      this.beginClosing();
      const shutdown = (this.shutdownPromise ??= (async () => {
        let closeError: unknown;
        try {
          await this.sendToLeader<void>('SHUTDOWN_LEADER', {}, undefined, generation, undefined, true);
        } catch (error) {
          closeError = error;
          this.recordCloseFailure(error);
        } finally {
          this.disposeLocalResources(closeError);
          await Promise.allSettled(this.lockRequests);
        }
        if (closeError) throw closeError;
      })());
      try {
        await shutdown;
      } finally {
        if (this.shutdownPromise === shutdown) this.shutdownPromise = null;
      }
      return;
    }
    await this.ready;
    if (this.isLeader) {
      try {
        await this.beginLeaderShutdown();
      } catch (error) {
        this.recordCloseFailure(error);
        throw error;
      } finally {
        this.disposeLocalResources();
      }
      return;
    }

    const shutdown = (this.shutdownPromise ??= this.sendToLeader<void>('SHUTDOWN_LEADER', {}).then(() => {
      this.disposeLocalResources();
    }));
    try {
      await shutdown;
    } catch (error) {
      this.recordCloseFailure(error);
      throw error;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = null;
    }
  }

  dispose() {
    this.disposeLocalResources();
  }

  async openFileChangeChannel(
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    closed: () => void,
  ): Promise<FileChangeChannel> {
    if (typeof receive !== 'function' || typeof interrupted !== 'function' || typeof closed !== 'function')
      throw makeCodedError('Invalid file change channel callbacks', 'EINVAL');
    if (this.attachTo !== undefined) throw makeCodedError('Passive attachments cannot use file changes', 'EPERM');
    if (this.changeChannels.size + this.openingChangeChannels >= 32)
      throw makeCodedError('Too many file change channels', 'ENOSPC');
    let lane: BroadcastChannel | undefined;
    let generation!: string;
    let clientId!: string;
    let channelId!: string;
    let openingWorker: VfsWorkerEndpoint | null = null;
    let openingLeader = false;
    let closeIssued = false;
    let ownerRejectedOpen = false;
    this.openingChangeChannels++;
    try {
      await this.ready;
      this.checkAvailable('FILE_CHANGES_OPEN');
      const currentGeneration = this.isLeader ? this.generation : this.leaderGeneration;
      if (!currentGeneration) throw makeCodedError('Owner profile has not been negotiated', LEADER_NOT_READY_CODE);
      generation = currentGeneration;
      openingWorker = this.worker;
      openingLeader = this.isLeader;
      clientId = this.attachmentId;
      channelId = crypto.randomUUID();
      if (!this.isLeader) {
        const current = this.followerChangeLane;
        if (current?.generation === generation) lane = current.lane;
        else {
          current?.lane.close();
          lane = new BroadcastChannel(changeLaneName(this.fileName, generation, clientId));
          this.followerChangeLane = { generation, lane };
        }
      }
      let result: { generation: string };
      try {
        result = openingLeader
          ? await this.requestWorker<{ generation: string }>('FILE_CHANGES_OPEN', {
              version: 1,
              generation,
              clientId,
              channelId,
              route: 'local',
            })
          : await this.requestChange<{ generation: string }>('CHANGE_OPEN', generation, clientId, channelId);
      } catch (error) {
        ownerRejectedOpen =
          openingLeader || (typeof error === 'object' && error !== null && this.remoteErrors.has(error));
        throw error;
      }
      if (!isObject(result) || Reflect.ownKeys(result).length !== 1 || result.generation !== generation) {
        if (openingLeader)
          void this.requestWorker('FILE_CHANGES_CLOSE', {
            version: 1,
            generation,
            clientId,
            channelId,
            route: 'local',
          }).catch(() => {});
        else void this.requestChange('CHANGE_CLOSE', generation, clientId, channelId).catch(() => {});
        closeIssued = true;
        throw makeCodedError('Invalid file change channel response', 'EINVAL');
      }
      if (
        this.resourcesDisposed ||
        this.closing ||
        this.isShuttingDown ||
        openingLeader !== this.isLeader ||
        (openingLeader && this.worker !== openingWorker) ||
        generation !== (openingLeader ? this.generation : this.leaderGeneration)
      ) {
        if (openingLeader && this.worker === openingWorker)
          void this.requestWorker('FILE_CHANGES_CLOSE', {
            version: 1,
            generation,
            clientId,
            channelId,
            route: 'local',
          }).catch(() => {});
        else void this.requestChange('CHANGE_CLOSE', generation, clientId, channelId).catch(() => {});
        closeIssued = true;
        throw makeCodedError('The owner changed. Reconnect to use this volume.', ATTACHMENT_LOST_CODE);
      }
      const state: ChangeCallbacks = {
        receive,
        interrupted,
        closed,
        generation,
        closedState: false,
        clientClosed: false,
      };
      if (!this.isLeader) {
        lane ??= this.followerChangeLane?.lane;
        if (!lane) throw makeCodedError('File change lane unavailable', 'EINVAL');
        state.lane = lane;
        lane.onmessage ??= (event) => {
          const message = event.data;
          if (!isObject(message) || !isChangeId(message.channelId)) return;
          const laneChannelId = message.channelId as string;
          const target = this.changeChannels.get(laneChannelId);
          if (target) this.handleChangeLane(target, message, generation, clientId, laneChannelId);
        };
      }
      this.changeChannels.set(channelId, state);
      return {
        generation,
        request: async (command) => {
          if (state.closedState) throw makeCodedError('File change channel is closed', 'EBADF');
          const snapshot = snapshotChangeCommand(command, 16 * 1024 * 1024 - this.localChangeOptionBytes);
          if (this.closing) throw makeCodedError('Shared VFS is shutting down', VFS_SHUTTING_DOWN_CODE);
          const subscriptionKey = JSON.stringify([channelId, snapshot.command.subscriptionId]);
          if (this.localChangeControlCount >= 64) {
            if (snapshot.command.type !== 'register') {
              this.closeLocalChangeChannel(channelId, clientId, state);
              this.notifyChange(state, 'interrupted', 'SUBSCRIPTION_INTERRUPTED');
            }
            throw makeCodedError('File change control queue is full', 'ENOSPC');
          }
          let admitted = false;
          if (snapshot.command.type === 'register' && this.localChangeSubscriptions.has(subscriptionKey))
            throw makeCodedError('Duplicate file change subscription', 'EEXIST');
          if (snapshot.command.type === 'register') {
            if (this.localChangeSubscriptions.size >= 32)
              throw makeCodedError('Too many file change subscriptions', 'ENOSPC');
            this.localChangeSubscriptions.add(subscriptionKey);
            admitted = true;
          }
          this.localChangeOptionBytes += snapshot.charge;
          this.localChangeControlCount++;
          let replyValidated = false;
          try {
            const result = this.isLeader
              ? await this.requestWorker<ChangeReply>('FILE_CHANGES_COMMAND', {
                  version: 1,
                  generation,
                  clientId,
                  channelId,
                  route: 'local',
                  command: snapshot.command,
                })
              : await this.requestChange<ChangeReply>(
                  'CHANGE_COMMAND',
                  generation,
                  clientId,
                  channelId,
                  snapshot.command,
                );
            if (!isChangeReply(snapshot.command, result)) throw makeCodedError('Invalid file change reply', 'EINVAL');
            replyValidated = true;
            if (snapshot.command.type === 'terminal-ack' && this.localChangeTerminalIds.delete(subscriptionKey))
              this.localChangeSubscriptions.delete(subscriptionKey);
            return result;
          } catch (error) {
            const code = (error as { code?: unknown })?.code;
            if (
              admitted &&
              (replyValidated || (typeof error === 'object' && error !== null && this.remoteErrors.has(error))) &&
              code !== LEADER_RESPONSE_TIMEOUT_CODE &&
              code !== ATTACHMENT_LOST_CODE
            ) {
              this.localChangeSubscriptions.delete(subscriptionKey);
            } else if (admitted) {
              // Keep the ID reserved until the owner conclusively acknowledges CLOSE.
              if (!state.closedState) {
                state.closedState = true;
                this.changeChannels.delete(channelId);
                this.notifyChange(state, 'interrupted', 'SUBSCRIPTION_INTERRUPTED');
              }
              const close = this.isLeader
                ? this.requestWorker('FILE_CHANGES_CLOSE', {
                    version: 1,
                    generation,
                    clientId,
                    channelId,
                    route: 'local',
                  })
                : this.requestChange('CHANGE_CLOSE', generation, clientId, channelId);
              void close.then(() => this.releaseLocalChangeSubscriptions(channelId)).catch(() => {});
            }
            throw error;
          } finally {
            this.localChangeOptionBytes -= snapshot.charge;
            this.localChangeControlCount--;
          }
        },
        close: () => {
          state.clientClosed = true;
          this.closeLocalChangeChannel(channelId, clientId, state);
        },
      };
    } catch (error) {
      if (!ownerRejectedOpen && !closeIssued && generation && clientId && channelId && !this.resourcesDisposed) {
        const close = openingLeader
          ? this.isLeader && this.worker === openingWorker && this.generation === generation
            ? this.requestWorker('FILE_CHANGES_CLOSE', {
                version: 1,
                generation,
                clientId,
                channelId,
                route: 'local',
              })
            : undefined
          : // A resume or owner change may have cleared the route while the owner opened this channel.
            this.requestChange('CHANGE_CLOSE', generation, clientId, channelId);
        void close?.catch(() => {});
      }
      if (
        lane &&
        this.changeChannels.size === 0 &&
        this.openingChangeChannels <= 1 &&
        this.followerChangeLane?.lane === lane
      ) {
        lane.close();
        this.followerChangeLane = undefined;
      }
      throw error;
    } finally {
      this.openingChangeChannels--;
    }
  }

  private handleChangeLane(
    state: ChangeCallbacks,
    message: unknown,
    generation: string,
    clientId: string,
    channelId: string,
  ) {
    if (
      !isObject(message) ||
      message.version !== 1 ||
      message.generation !== generation ||
      message.clientId !== clientId ||
      message.channelId !== channelId
    )
      return;
    const fields =
      message.type === 'CHANGE_FRAME'
        ? ['type', 'version', 'generation', 'clientId', 'channelId', 'frame']
        : message.type === 'CHANGE_INTERRUPTED'
          ? ['type', 'version', 'generation', 'clientId', 'channelId', 'code']
          : message.type === 'CHANGE_CLOSED'
            ? ['type', 'version', 'generation', 'clientId', 'channelId']
            : [];
    if (
      Reflect.ownKeys(message).length !== fields.length ||
      Reflect.ownKeys(message).some((key) => typeof key !== 'string' || !fields.includes(key))
    )
      return;
    const frame = message.type === 'CHANGE_FRAME' ? snapshotChangeFrame(message.frame, generation) : undefined;
    if (message.type === 'CHANGE_FRAME' && frame) {
      this.markLocalTerminal(channelId, frame);
      this.deliverChange(state, 'frame', frame);
    } else if (
      message.type === 'CHANGE_INTERRUPTED' &&
      (message.code === 'SUBSCRIPTION_INTERRUPTED' || message.code === 'SUBSCRIPTION_RESYNC_REQUIRED')
    ) {
      if (!state.closedState) {
        this.closeLocalChangeChannel(channelId, clientId, state);
        this.notifyChange(state, 'interrupted', message.code);
      }
    } else if (message.type === 'CHANGE_CLOSED' && !state.closedState) {
      state.closedState = true;
      this.changeChannels.delete(channelId);
      this.releaseLocalChangeSubscriptions(channelId);
      this.notifyChange(state, 'closed');
    }
  }

  private closeLocalChangeChannel(channelId: string, clientId: string, state: ChangeCallbacks) {
    if (state.closedState) return;
    state.closedState = true;
    this.changeChannels.delete(channelId);
    if (
      ![...this.changeChannels.values()].some((other) => other !== state && other.lane === state.lane) &&
      !(state.lane && this.followerChangeLane?.lane === state.lane && this.openingChangeChannels > 0)
    ) {
      state.lane?.close();
      if (this.followerChangeLane?.lane === state.lane) this.followerChangeLane = undefined;
    }
    // CLOSE_VFS releases all worker channels; follower relays close on disposal.
    if (this.resourcesDisposed || this.closing) return;
    if (this.isLeader)
      void Promise.resolve()
        .then(() =>
          this.requestWorker('FILE_CHANGES_CLOSE', {
            version: 1,
            generation: state.generation,
            clientId,
            channelId,
            route: 'local',
          }),
        )
        .then(() => this.releaseLocalChangeSubscriptions(channelId))
        .catch(() => {});
    else
      void this.requestChange('CHANGE_CLOSE', state.generation, clientId, channelId)
        .then(() => this.releaseLocalChangeSubscriptions(channelId))
        .catch(() => {});
  }

  private closeLocalChangeChannels(code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') {
    for (const [channelId, state] of [...this.changeChannels]) {
      const clientId = this.attachmentId;
      this.closeLocalChangeChannel(channelId, clientId, state);
      this.notifyChange(state, 'interrupted', code);
    }
  }

  private markLocalTerminal(channelId: string, frame: ChangeFrame) {
    if (frame.type === 'terminal' || frame.type === 'closed') {
      const key = JSON.stringify([channelId, frame.subscriptionId]);
      if (this.localChangeSubscriptions.has(key)) this.localChangeTerminalIds.add(key);
    }
  }

  private releaseLocalChangeSubscriptions(channelId: string) {
    const prefix = JSON.stringify([channelId]).slice(0, -1);
    for (const key of [...this.localChangeSubscriptions]) {
      if (key.startsWith(prefix)) {
        this.localChangeSubscriptions.delete(key);
        this.localChangeTerminalIds.delete(key);
      }
    }
  }

  private requestChange<T>(
    type: string,
    generation: string,
    clientId: string,
    channelId: string,
    command?: ChangeCommand,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.messageId;
      const finish = () => {
        clearTimeout(timer);
        this.channel.removeEventListener('message', listener);
        this.pendingChangeRequests.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        reject(makeCodedError('File change control timed out', LEADER_RESPONSE_TIMEOUT_CODE));
      }, DEFAULT_COMMAND_TIMEOUT_MS);
      const listener = (event: MessageEvent) => {
        const data = event.data;
        if (
          !isObject(data) ||
          data.version !== 1 ||
          data.id !== id ||
          data.tabId !== this.attachmentId ||
          data.clientId !== clientId ||
          data.channelId !== channelId
        )
          return;
        if (data.generation !== generation || (data.type !== 'CHANGE_RESPONSE' && data.type !== 'CHANGE_ERROR')) return;
        const fields = ['type', 'version', 'id', 'tabId', 'generation', 'clientId', 'channelId', 'result'];
        if (
          Reflect.ownKeys(data).length !== fields.length ||
          Reflect.ownKeys(data).some((key) => typeof key !== 'string' || !fields.includes(key))
        )
          return;
        if (
          data.type === 'CHANGE_RESPONSE' &&
          ((type === 'CHANGE_OPEN' &&
            (!isObject(data.result) ||
              Reflect.ownKeys(data.result).length !== 1 ||
              data.result.generation !== generation)) ||
            (type === 'CHANGE_COMMAND' && (!command || !isChangeReply(command, data.result))) ||
            (type === 'CHANGE_CLOSE' &&
              (!isObject(data.result) || Reflect.ownKeys(data.result).length !== 1 || data.result.type !== 'ok')))
        )
          return;
        if (data.type === 'CHANGE_ERROR' && parseRemoteError(data.result) === null) return;
        finish();
        if (data.type === 'CHANGE_ERROR') reject(this.makeRemoteError(data.result));
        else resolve(data.result as T);
      };
      this.pendingChangeRequests.set(id, { cleanup: finish, reject });
      this.channel.addEventListener('message', listener);
      this.channel.postMessage({
        type,
        version: 1,
        id,
        tabId: this.attachmentId,
        generation,
        clientId,
        channelId,
        ...(command ? { command } : {}),
      });
    });
  }

  /**
   * Path commands pinned to one owner generation (from `getStatus().ownerGeneration`). Every call is refused
   * before dispatch once the owner changed, rejects with {@link VfsCommandError}, and is never retried.
   */
  forGeneration(ownerGeneration: string): GenerationClient {
    if (typeof ownerGeneration !== 'string' || ownerGeneration.length === 0 || ownerGeneration.length > 128) {
      throw makeCodedError('Invalid owner generation', 'EINVAL');
    }
    const facade = {} as Record<GenerationMethod, (...args: unknown[]) => Promise<unknown>>;
    for (const name of GENERATION_METHODS) {
      facade[name] = async (...args) => {
        const record: DispatchRecord = { sent: false, replied: false };
        // Reuse the public method body, replacing only its dispatch target.
        const context = Object.create(this, {
          sendToWorker: {
            value: (type: string, payload: WorkerCommandPayload, data?: Uint8Array) =>
              this.sendToWorker(type, payload, data, ownerGeneration, record),
          },
        });
        try {
          return await (OpfsVfsWorkerClient.prototype[name] as (...methodArgs: unknown[]) => Promise<unknown>).apply(
            context,
            args,
          );
        } catch (error) {
          throw new VfsCommandError(error, !record.sent ? 'refused' : record.replied ? 'replied' : 'sent');
        }
      };
    }
    return Object.freeze(facade) as GenerationClient;
  }

  // Asynchronous API
  /** Read a file in one worker turn. The server enforces a maximum of 16 MiB. */
  async readFileBuffer(path: string, limit = 16 * 1024 * 1024): Promise<Uint8Array> {
    const result = await this.sendToWorker<{ buffer: Uint8Array }>('READ_FILE_BUFFER', { path, limit });
    return result.buffer;
  }
  /** Bounded whole-file write; expected-content comparison and exclusive creation run in the worker. */
  async writeFileBuffer(path: string, bytes: Uint8Array, options: WriteFileBufferOptions = {}): Promise<void> {
    // Preserve caller-owned buffers, including editor drafts and clipboard snapshots.
    await this.sendToWorker('WRITE_FILE_BUFFER', { path, ...options }, Uint8Array.from(bytes));
  }
  async renameNoReplace(oldPath: string, newPath: string): Promise<void> {
    await this.sendToWorker('RENAME_NO_REPLACE', { oldPath, newPath });
  }
  async mkdir(path: string, modeOrOptions?: number | MkdirOptions) {
    return this.sendToWorker<void>('MKDIR', { path, ...this.normalizeMkdirArgs(modeOrOptions) });
  }
  async open(path: string, flags: number | boolean = 0, mode?: number): Promise<number> {
    return this.sendToWorker<number>('OPEN', { path, flags: this.normalizeOpenFlags(flags), mode });
  }
  /**
   * Write `data` to the file referenced by `fd`.
   *
   * Buffer ownership: when `data` is a view that covers its entire backing
   * `ArrayBuffer` (`byteOffset === 0` and `byteLength === buffer.byteLength`),
   * that buffer is transferred to the worker and detached — the caller must not
   * reuse it afterwards. Subarray views into a larger buffer (and
   * `SharedArrayBuffer`-backed views) are copied instead, so the caller's
   * backing buffer is left intact.
   */
  async write(fd: number, data: Uint8Array, offset?: number): Promise<number> {
    return this.sendToWorker<number>('WRITE', { fd, offset }, data);
  }
  async read(fd: number, size: number, offset?: number): Promise<{ buffer: Uint8Array; read: number }> {
    return this.sendToWorker<{ buffer: Uint8Array; read: number }>('READ', { fd, size, offset });
  }
  async seek(fd: number, offset: number, whence: number): Promise<number> {
    return this.sendToWorker<number>('SEEK', { fd, offset, whence });
  }
  async close(fd: number): Promise<void> {
    return this.sendToWorker<void>('CLOSE', { fd });
  }
  async fstat(fd: number): Promise<VfsStat> {
    return this.sendToWorker<VfsStat>('FSTAT', { fd });
  }
  async fsync(fd: number): Promise<void> {
    return this.sendToWorker<void>('FSYNC', { fd });
  }
  async ftruncate(fd: number, size: number): Promise<void> {
    return this.sendToWorker<void>('FTRUNCATE', { fd, size });
  }
  async chmod(path: string, mode: number): Promise<void> {
    return this.sendToWorker<void>('CHMOD', { path, mode });
  }
  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    return this.sendToWorker<void>('UTIMES', { path, atimeMs, mtimeMs });
  }
  async symlink(target: string, path: string, mode?: number): Promise<void> {
    return this.sendToWorker<void>('SYMLINK', { target, path, mode });
  }
  async link(existingPath: string, newPath: string): Promise<void> {
    return this.sendToWorker<void>('LINK', { existingPath, newPath });
  }
  async readlink(path: string): Promise<string> {
    return this.sendToWorker<string>('READLINK', { path });
  }
  async realpath(path: string): Promise<string> {
    return this.sendToWorker<string>('REALPATH', { path });
  }
  async unlink(path: string): Promise<void> {
    return this.sendToWorker<void>('UNLINK', { path });
  }
  async rmdir(path: string): Promise<void> {
    return this.sendToWorker<void>('RMDIR', { path });
  }
  async remove(path: string): Promise<void> {
    return this.sendToWorker<void>('REMOVE', { path });
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.sendToWorker<void>('RENAME', { oldPath, newPath });
  }
  async truncate(path: string, size: number): Promise<void> {
    return this.sendToWorker<void>('TRUNCATE', { path, size });
  }
  async exists(path: string): Promise<boolean> {
    return this.sendToWorker<boolean>('EXISTS', { path });
  }
  async stat(path: string): Promise<VfsStat> {
    return this.sendToWorker<VfsStat>('STAT', { path });
  }
  async lstat(path: string): Promise<VfsStat> {
    return this.sendToWorker<VfsStat>('LSTAT', { path });
  }
  async readdir(path: string): Promise<string[]> {
    return this.sendToWorker<string[]>('READDIR', { path });
  }
  async readdirNames(path: string): Promise<string[]> {
    return this.sendToWorker<string[]>('READDIR_NAMES', { path });
  }
  async readdirEntries(path: string): Promise<VfsDirEntry[]> {
    return this.sendToWorker<VfsDirEntry[]>('READDIR_ENTRIES', { path });
  }
  async listPaths(): Promise<string[]> {
    return this.sendToWorker<string[]>('LIST_PATHS', {});
  }
  async sync(): Promise<void> {
    return this.sendToWorker<void>('SYNC', {});
  }
  async flush(): Promise<void> {
    return this.sendToWorker<void>('FLUSH', {});
  }

  private normalizeMkdirArgs(modeOrOptions?: number | MkdirOptions): { mode?: number; recursive?: boolean } {
    if (typeof modeOrOptions === 'number' || modeOrOptions === undefined) {
      return { mode: modeOrOptions };
    }
    return {
      mode: modeOrOptions.mode,
      recursive: modeOrOptions.recursive,
    };
  }
}

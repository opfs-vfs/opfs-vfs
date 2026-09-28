import type { GenerationClient, OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import type { VfsDirEntry } from '@opfs-vfs/opfs-vfs';
import { subscribe, type FileChange, type Subscription } from '@opfs-vfs/plugin-subscriptions/client';
import { toVolumeError, type VolumeError } from './errors';

export type FileInfo = Readonly<{
  ino: number;
  size: number;
  mode: number;
  mtimeMs: number | undefined;
  is_file: boolean;
  is_dir: boolean;
}>;

export type ResourceResult<T> =
  | Readonly<{
      status: 'idle' | 'pending';
      data: undefined;
      error: null;
      isRefreshing: false;
      isStale: false;
      refresh: () => Promise<void>;
    }>
  | Readonly<{
      status: 'success';
      data: T;
      error: null;
      isRefreshing: boolean;
      isStale: boolean;
      refresh: () => Promise<void>;
    }>
  | Readonly<{
      status: 'error';
      data: T | undefined;
      error: VolumeError;
      isRefreshing: boolean;
      isStale: boolean;
      refresh: () => Promise<void>;
    }>;

export type FolderEntry = Readonly<VfsDirEntry>;
export type FolderResult = ResourceResult<readonly FolderEntry[]>;
export type FileResult = ResourceResult<FileInfo | null>;
export type FileContentResult<T> = ResourceResult<T | null>;

let nextStoreId = 0;
const stores = new WeakMap<OpfsVfsWorkerClient, ClientStore>();
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export type ResourceKind = 'folder' | 'file' | 'content-bytes' | 'content-text';
export type ResourceValue = readonly FolderEntry[] | FileInfo | Uint8Array | string | null;
type RecordEntry = {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly path: string;
  readonly limit: number;
  readonly generation: string;
  readonly ownerGeneration: string;
  readonly listeners: Set<() => void>;
  snapshot: ResourceResult<ResourceValue>;
  users: number;
  queued: boolean;
  inFlight: boolean;
  dirty: boolean;
  epoch: number;
  attempts: { target: number; resolve: () => void }[];
  completed: number;
  failureRevision: number;
  readonly reporters: Map<object, { revision: number; users: number; report: (error: VolumeError) => void }>;
  resolvedPath: string | null;
  dependencyEpoch: number;
};
type RootWatch = {
  generation: string;
  handle: Subscription;
  session: number;
  retiring: boolean;
  confirmedClosed: boolean;
  terminal: { cause: unknown } | null;
  finalized: boolean;
};
type Recovery = { generation: string; cause: unknown; timer: ReturnType<typeof setTimeout> | null; session: number };
type OpeningWatch = {
  generation: string;
  session: number;
  terminal: { cause: unknown } | null;
  root: RootWatch | null;
};
export type ResourceEntry<T extends ResourceValue = ResourceValue> = RecordEntry & { snapshot: ResourceResult<T> };

const idle = <T>(refresh: () => Promise<void>): ResourceResult<T> =>
  Object.freeze({ status: 'idle', data: undefined, error: null, isRefreshing: false, isStale: false, refresh });
const pending = <T>(refresh: () => Promise<void>): ResourceResult<T> =>
  Object.freeze({ status: 'pending', data: undefined, error: null, isRefreshing: false, isStale: false, refresh });

export class ClientStore {
  readonly client: OpfsVfsWorkerClient;
  readonly #id = ++nextStoreId;
  #ownerGeneration: string | null = null;
  #facade: GenerationClient | null = null;
  #resources = new Map<string, RecordEntry>();
  #queue: RecordEntry[] = [];
  #reading = false;
  #drainQueued = false;
  #root: RootWatch | null = null;
  #confirmedRoot: RootWatch | null = null;
  #rootOpening: Promise<void> | null = null;
  #openingWatch: OpeningWatch | null = null;
  #rootRetiring: Promise<void> | null = null;
  #blockedGeneration: string | null = null;
  #registrationFailure: { generation: string; cause: unknown } | null = null;
  #recovery: Recovery | null = null;
  #recoveryStep = 0;
  #healthySince = 0;
  #watchSession = 0;
  #readyGeneration: string | null = null;
  #lastNonNullGeneration: string | null = null;
  #stopStatus: (() => void) | null = null;

  constructor(client: OpfsVfsWorkerClient) {
    this.client = client;
  }

  /** Opaque SDK generation token: this client's lifetime plus the core owner generation. */
  generation(ownerGeneration: string): string {
    return `${this.#id}:${ownerGeneration}`;
  }

  /** One core generation-pinned facade per owner generation. */
  facade(ownerGeneration: string): GenerationClient {
    if (this.#ownerGeneration !== ownerGeneration) {
      this.#ownerGeneration = ownerGeneration;
      this.#facade = this.client.forGeneration(ownerGeneration);
    }
    return this.#facade!;
  }

  acquire<T extends ResourceValue>(
    ownerGeneration: string,
    kind: ResourceKind,
    path: string,
    limit = MAX_CONTENT_BYTES,
  ): ResourceEntry<T> {
    if (!path.startsWith('/')) throw new Error('Resource path must be absolute');
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CONTENT_BYTES)
      throw new Error('Invalid content limit');
    const generation = this.generation(ownerGeneration);
    const key = `${generation}\0${kind}\0${path}\0${limit}`;
    this.#observeStatus();
    let entry = this.#resources.get(key);
    if (!entry) {
      const refresh = () => this.refresh(entry!);
      entry = {
        key,
        kind,
        path,
        limit,
        generation,
        ownerGeneration,
        listeners: new Set(),
        snapshot: idle<T>(refresh) as ResourceResult<ResourceValue>,
        users: 0,
        queued: false,
        inFlight: false,
        dirty: true,
        epoch: 0,
        attempts: [],
        completed: 0,
        failureRevision: 0,
        reporters: new Map(),
        resolvedPath: null,
        dependencyEpoch: 0,
      };
      this.#resources.set(key, entry);
    }
    entry.users++;
    this.#enqueue(entry);
    return entry as ResourceEntry<T>;
  }

  release(entry: ResourceEntry) {
    if (entry.users === 0 || --entry.users > 0) return;
    if (this.#resources.get(entry.key) === entry) this.#resources.delete(entry.key);
    entry.queued = false;
    entry.dirty = false;
    entry.epoch++;
    this.#queue = this.#queue.filter((candidate) => candidate !== entry);
    for (const waiter of entry.attempts.splice(0)) waiter.resolve();
    entry.snapshot = idle(entry.snapshot.refresh);
    entry.listeners.clear();
    entry.reporters.clear();
    if (!this.#hasResources()) {
      if (this.#confirmedRoot) this.#confirmedRoot.finalized = true;
      this.#confirmedRoot = null;
      this.#cancelRecovery(true);
      this.#stopStatus?.();
      this.#stopStatus = null;
      this.#readyGeneration = null;
      this.#ownerGeneration = null;
      this.#facade = null;
      void this.#retireRoot();
    }
  }

  subscribe(entry: ResourceEntry, listener: () => void) {
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /** Report future failures once to this committed provider binding. */
  reportFailures(entry: ResourceEntry, binding: object, report: (error: VolumeError) => void) {
    const previous = entry.reporters.get(binding);
    if (previous) previous.users++;
    else entry.reporters.set(binding, { revision: entry.failureRevision, users: 1, report });
    return () => {
      const current = entry.reporters.get(binding);
      if (!current || --current.users) return;
      entry.reporters.delete(binding);
    };
  }

  refresh(entry: ResourceEntry) {
    if (this.#resources.get(entry.key) !== entry || entry.users === 0) return Promise.resolve();
    if (this.#recovery?.generation === entry.ownerGeneration) {
      const target = entry.completed + 1;
      entry.dirty = true;
      return new Promise<void>((resolve) => entry.attempts.push({ target, resolve }));
    }
    if (this.#registrationFailure?.generation === entry.ownerGeneration) {
      this.#registrationFailure = null;
      for (const candidate of this.#resources.values()) {
        if (candidate.ownerGeneration !== entry.ownerGeneration) continue;
        candidate.dirty = true;
        this.#enqueue(candidate);
      }
    }
    const target = entry.completed + (entry.inFlight ? 2 : 1);
    entry.dirty = true;
    if (entry.inFlight && entry.snapshot.data !== undefined)
      this.#publish(entry, Object.freeze({ ...entry.snapshot, isStale: true }));
    this.#enqueue(entry);
    return new Promise<void>((resolve) => entry.attempts.push({ target, resolve }));
  }

  #enqueue(entry: RecordEntry) {
    if (!entry.users || entry.queued || entry.inFlight) return;
    entry.queued = true;
    this.#queue.push(entry);
    this.#scheduleDrain();
  }

  #scheduleDrain() {
    if (this.#drainQueued) return;
    this.#drainQueued = true;
    queueMicrotask(() => {
      this.#drainQueued = false;
      void this.#drain();
    });
  }

  async #drain() {
    if (this.#reading) return;
    this.#reading = true;
    try {
      for (;;) {
        const entry = this.#queue.shift();
        if (!entry) break;
        entry.queued = false;
        if (!entry.users || !entry.dirty) continue;
        entry.dirty = false;
        entry.inFlight = true;
        const epoch = entry.epoch;
        let session = this.#watchSession;
        const dependencyEpoch = entry.dependencyEpoch;
        this.#publish(
          entry,
          entry.snapshot.data === undefined
            ? pending(entry.snapshot.refresh)
            : (Object.freeze({
                ...entry.snapshot,
                isRefreshing: true,
                isStale: true,
              }) as ResourceResult<ResourceValue>),
        );
        try {
          await this.#ensureRoot(entry.ownerGeneration);
          session = this.#watchSession;
          if (!this.#live(entry, epoch, session)) continue;
          const read = await this.#read(entry, () => this.#live(entry, epoch, session));
          if (this.#live(entry, epoch, session)) {
            if (entry.dependencyEpoch === dependencyEpoch) entry.resolvedPath = read.resolvedPath;
            const data = sameValue(entry.snapshot.data, read.value)
              ? (entry.snapshot.data as ResourceValue)
              : read.value;
            this.#publish(
              entry,
              Object.freeze({
                status: 'success',
                data,
                error: null,
                isRefreshing: false,
                isStale: entry.dirty,
                refresh: entry.snapshot.refresh,
              }),
            );
          }
        } catch (cause) {
          if (this.#live(entry, epoch, session)) {
            const error = toVolumeError(cause, {
              operation: entry.kind === 'folder' ? 'readdirEntries' : entry.kind === 'file' ? 'stat' : 'readFileBuffer',
              volume: this.client.getStatus().fileName,
              path: entry.path,
              mutation: false,
            });
            this.#publish(
              entry,
              Object.freeze({
                status: 'error',
                data: entry.snapshot.data,
                error,
                isRefreshing: false,
                isStale: entry.snapshot.data !== undefined,
                refresh: entry.snapshot.refresh,
              }),
              !isRecoverable(cause),
            );
          }
        } finally {
          entry.inFlight = false;
          entry.completed++;
          const settled = entry.attempts.filter((waiter) => waiter.target <= entry.completed);
          entry.attempts = entry.attempts.filter((waiter) => waiter.target > entry.completed);
          for (const waiter of settled) waiter.resolve();
          if (entry.dirty) this.#enqueue(entry);
          this.#markHealthy(entry.ownerGeneration);
        }
      }
    } finally {
      this.#reading = false;
      if (this.#queue.length) this.#scheduleDrain();
    }
  }

  async #read(entry: RecordEntry, live: () => boolean): Promise<{ value: ResourceValue; resolvedPath: string | null }> {
    const facade = this.facade(entry.ownerGeneration);
    const resolvedPath = await facade.realpath(entry.path).catch(() => null);
    if (!live()) throw Object.assign(new Error('Read superseded'), { code: 'VFS_READ_SUPERSEDED' });
    if (entry.kind === 'folder')
      return {
        value: Object.freeze((await facade.readdirEntries(entry.path)).map((value) => Object.freeze({ ...value }))),
        resolvedPath,
      };
    if (entry.kind === 'file') {
      try {
        const value = await facade.stat(entry.path);
        if (value.is_dir) throw Object.assign(new Error('Path is a directory'), { code: 'EISDIR' });
        return {
          value: Object.freeze({
            ino: value.ino,
            size: value.size,
            mode: value.mode,
            mtimeMs: value.mtimeMs,
            is_file: value.is_file,
            is_dir: value.is_dir,
          }),
          resolvedPath,
        };
      } catch (cause) {
        if (isMissing(cause)) return { value: null, resolvedPath: null };
        throw cause;
      }
    }
    try {
      const bytes = await facade.readFileBuffer(entry.path, entry.limit);
      return { value: entry.kind === 'content-text' ? new TextDecoder().decode(bytes) : bytes, resolvedPath };
    } catch (cause) {
      if (isMissing(cause)) return { value: null, resolvedPath: null };
      throw cause;
    }
  }

  #publish(entry: RecordEntry, snapshot: ResourceResult<ResourceValue>, reportFailure = true) {
    if (sameSnapshot(entry.snapshot, snapshot)) return;
    const previous = entry.snapshot;
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener();
    if (reportFailure && snapshot.status === 'error' && snapshot.error !== previous.error) {
      const revision = ++entry.failureRevision;
      queueMicrotask(() => {
        if (this.#resources.get(entry.key) !== entry || !entry.users) return;
        for (const reporter of entry.reporters.values()) {
          if (reporter.revision >= revision) continue;
          reporter.revision = revision;
          reporter.report(snapshot.error);
        }
      });
    }
  }

  #live(entry: RecordEntry, epoch: number, session: number) {
    const status = this.client.getStatus();
    return (
      this.#resources.get(entry.key) === entry &&
      entry.users > 0 &&
      entry.epoch === epoch &&
      session === this.#watchSession &&
      status.state === 'ready' &&
      status.ownerGeneration === entry.ownerGeneration
    );
  }

  #hasResources() {
    for (const entry of this.#resources.values()) if (entry.users > 0) return true;
    return false;
  }

  #reconcileStatus() {
    const status = this.client.getStatus();
    const generation = status.state === 'ready' ? status.ownerGeneration : null;
    if (generation === this.#readyGeneration) return;
    const previous = this.#readyGeneration;
    this.#readyGeneration = generation;
    this.#ownerGeneration = null;
    this.#facade = null;
    if (generation === null) {
      if (this.#confirmedRoot) this.#confirmedRoot.finalized = true;
      this.#confirmedRoot = null;
      if (previous !== null) {
        this.#cancelRecovery();
        this.#watchSession++;
        for (const entry of this.#resources.values()) {
          if (entry.ownerGeneration !== previous) continue;
          entry.queued = false;
          entry.dirty = true;
          entry.epoch++;
          entry.resolvedPath = null;
          entry.dependencyEpoch++;
          for (const waiter of entry.attempts.splice(0)) waiter.resolve();
          this.#publish(entry, idle(entry.snapshot.refresh));
        }
        this.#queue = this.#queue.filter((entry) => entry.ownerGeneration !== previous);
      }
      void this.#retireRoot();
      return;
    }
    if (generation !== this.#lastNonNullGeneration) {
      if (this.#confirmedRoot) this.#confirmedRoot.finalized = true;
      this.#confirmedRoot = null;
      this.#cancelRecovery(true);
      this.#watchSession++;
      this.#lastNonNullGeneration = generation;
      this.#blockedGeneration = null;
      this.#registrationFailure = null;
      for (const entry of [...this.#resources.values()]) {
        this.#resources.delete(entry.key);
        entry.queued = false;
        entry.dirty = false;
        entry.epoch++;
        entry.resolvedPath = null;
        entry.dependencyEpoch++;
        for (const waiter of entry.attempts.splice(0)) waiter.resolve();
        this.#publish(entry, idle(entry.snapshot.refresh));
      }
      this.#queue = [];
      void this.#retireRoot();
      return;
    }
    for (const entry of this.#resources.values()) {
      if (entry.ownerGeneration !== generation) continue;
      entry.dirty = true;
      this.#enqueue(entry);
    }
  }

  #observeStatus() {
    if (this.#stopStatus) return;
    this.#stopStatus = this.client.subscribeStatus(() => this.#reconcileStatus());
    this.#reconcileStatus();
  }

  async #ensureRoot(generation: string): Promise<void> {
    if (this.#blockedGeneration === generation)
      throw Object.assign(new Error('Subscription retirement is unknown'), { code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN' });
    if (this.#recovery?.generation === generation) throw this.#recovery.cause;
    if (this.#registrationFailure?.generation === generation) throw this.#registrationFailure.cause;
    if (this.#root?.generation === generation) return;
    if (this.#rootOpening) {
      await this.#rootOpening;
      if (this.#root?.generation === generation) return;
      return this.#ensureRoot(generation);
    }
    const status = this.client.getStatus();
    if (status.state !== 'ready' || status.ownerGeneration !== generation)
      throw Object.assign(new Error('Owner generation changed'), { code: 'VFS_GENERATION_CHANGED' });
    this.#rootOpening = (async () => {
      await this.#retireRoot();
      if (this.#confirmedRoot?.generation === generation) {
        this.#confirmedRoot.finalized = true;
        this.#confirmedRoot = null;
      }
      if (this.#blockedGeneration === generation)
        throw Object.assign(new Error('Subscription retirement is unknown'), {
          code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN',
        });
      if (this.#recovery?.generation === generation) throw this.#recovery.cause;
      const current = this.client.getStatus();
      if (!this.#hasResources() || current.state !== 'ready' || current.ownerGeneration !== generation) return;
      const opening: OpeningWatch = { generation, session: this.#watchSession, terminal: null, root: null };
      this.#openingWatch = opening;
      const handle = await subscribe(
        this.client,
        {
          path: '/',
          scope: 'directory',
          recursive: true,
          content: false,
          onError: (cause) => this.#terminalWatch(opening, cause),
        },
        (change) => this.#invalidate(change, generation),
      );
      if (
        !this.#hasResources() ||
        this.#readyGeneration !== generation ||
        this.#watchSession !== opening.session ||
        opening.terminal
      ) {
        handle.unsubscribe();
        const retirement = await handle.closed;
        if (retirement.status === 'unknown') {
          this.#blockedGeneration = generation;
          this.#clearDependencies(generation);
          this.#failEntries(generation, retirement.error);
        }
        throw (
          opening.terminal?.cause ??
          Object.assign(new Error('Owner generation changed'), { code: 'VFS_GENERATION_CHANGED' })
        );
      }
      const root: RootWatch = {
        generation,
        handle,
        session: ++this.#watchSession,
        retiring: false,
        confirmedClosed: false,
        terminal: null,
        finalized: false,
      };
      opening.root = root;
      this.#root = root;
      void handle.closed.then((retirement) => this.#closedRoot(root, retirement));
    })();
    try {
      await this.#rootOpening;
    } catch (cause: any) {
      if (cause?.code === 'SUBSCRIPTION_RETIREMENT_UNKNOWN') this.#blockedGeneration = generation;
      else if (isRecoverable(cause)) this.#startRecovery(generation, cause);
      else this.#registrationFailure = { generation, cause };
      throw cause;
    } finally {
      this.#rootOpening = null;
      this.#openingWatch = null;
    }
  }

  async #retireRoot(): Promise<void> {
    if (this.#rootRetiring) return this.#rootRetiring;
    const root = this.#root;
    if (!root) return;
    this.#root = null;
    root.retiring = true;
    this.#watchSession++;
    root.handle.unsubscribe();
    this.#rootRetiring = root.handle.closed
      .then(() => {})
      .finally(() => {
        this.#rootRetiring = null;
      });
    return this.#rootRetiring;
  }

  #terminalWatch(opening: OpeningWatch, cause: unknown) {
    if (opening.root) return this.#terminalRoot(opening.root, cause);
    if (this.#openingWatch !== opening || opening.terminal || this.#watchSession !== opening.session) return;
    opening.terminal = { cause };
    this.#watchSession++;
  }

  #terminalRoot(root: RootWatch, cause: unknown) {
    if (root.retiring || root.finalized || root.terminal) return;
    if (root.confirmedClosed && (this.#confirmedRoot !== root || this.#readyGeneration !== root.generation)) return;
    root.terminal = { cause };
    if (this.#root === root) {
      this.#root = null;
      this.#watchSession++;
      this.#clearDependencies(root.generation);
    }
    queueMicrotask(() => this.#failEntries(root.generation, cause, !isRecoverable(cause)));
    if (root.confirmedClosed) this.#finishTerminal(root, cause);
    if (!this.#rootRetiring)
      this.#rootRetiring = root.handle.closed
        .then(() => {})
        .finally(() => {
          this.#rootRetiring = null;
        });
  }

  #closedRoot(root: RootWatch, retirement: Awaited<Subscription['closed']>) {
    if (retirement.status === 'unknown') {
      root.finalized = true;
      if (this.#confirmedRoot === root) this.#confirmedRoot = null;
      this.#blockedGeneration = root.generation;
      if (this.#root === root) this.#root = null;
      this.#watchSession++;
      this.#clearDependencies(root.generation);
      this.#failEntries(root.generation, retirement.error);
      return;
    }
    if (root.retiring) return;
    const terminal = root.terminal;
    if (terminal !== null) return this.#finishTerminal(root, terminal.cause);
    root.confirmedClosed = true;
    this.#confirmedRoot = root;
    if (this.#root === root) this.#root = null;
    this.#watchSession++;
    this.#clearDependencies(root.generation);
    if (this.#rootRetiring) return;
    this.#rootRetiring = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => {
        if (root.terminal !== null) this.#finishTerminal(root, root.terminal.cause);
        else this.#markGenerationStale(root.generation);
      })
      .finally(() => {
        this.#rootRetiring = null;
      });
  }

  #finishTerminal(root: RootWatch, cause: unknown) {
    if (root.finalized) return;
    root.finalized = true;
    if (this.#confirmedRoot === root) this.#confirmedRoot = null;
    if (isRecoverable(cause)) this.#startRecovery(root.generation, cause);
    else this.#registrationFailure = { generation: root.generation, cause };
  }

  #failEntries(generation: string, cause: unknown, report = true) {
    this.#queue = this.#queue.filter((entry) => entry.ownerGeneration !== generation);
    for (const entry of this.#resources.values()) {
      if (entry.ownerGeneration !== generation) continue;
      entry.queued = false;
      entry.dirty = false;
      entry.epoch++;
      const error = toVolumeError(cause, {
        operation: 'subscribe',
        volume: this.client.getStatus().fileName,
        path: entry.path,
        mutation: false,
      });
      this.#publish(
        entry,
        Object.freeze({
          status: 'error',
          data: entry.snapshot.data,
          error,
          isRefreshing: false,
          isStale: entry.snapshot.data !== undefined,
          refresh: entry.snapshot.refresh,
        }),
        report,
      );
      entry.completed++;
      for (const waiter of entry.attempts.splice(0)) waiter.resolve();
    }
  }

  #startRecovery(generation: string, cause: unknown) {
    if (this.#recovery?.generation === generation || !this.#hasResources()) return;
    if (this.#healthySince && Date.now() - this.#healthySince >= 60_000) this.#recoveryStep = 0;
    this.#healthySince = 0;
    const delay = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000][Math.min(this.#recoveryStep++, 5)]!;
    const recovery: Recovery = { generation, cause, timer: null, session: this.#watchSession };
    this.#recovery = recovery;
    recovery.timer = setTimeout(() => {
      if (this.#recovery !== recovery) return;
      this.#recovery = null;
      const status = this.client.getStatus();
      if (
        !this.#hasResources() ||
        recovery.session !== this.#watchSession ||
        status.state !== 'ready' ||
        status.ownerGeneration !== generation ||
        this.#blockedGeneration === generation
      )
        return;
      for (const entry of this.#resources.values()) {
        if (entry.ownerGeneration !== generation) continue;
        entry.dirty = true;
        this.#enqueue(entry);
      }
    }, delay);
  }

  #cancelRecovery(reset = false) {
    if (this.#recovery?.timer) clearTimeout(this.#recovery.timer);
    this.#recovery = null;
    this.#healthySince = 0;
    if (reset) this.#recoveryStep = 0;
  }

  #markHealthy(generation: string) {
    if (this.#recovery || this.#readyGeneration !== generation || !this.#root || this.#root.generation !== generation)
      return;
    for (const entry of this.#resources.values()) {
      if (entry.ownerGeneration === generation && (entry.inFlight || entry.queued || entry.dirty)) return;
    }
    this.#healthySince ||= Date.now();
  }

  #clearDependencies(generation: string) {
    for (const entry of this.#resources.values()) {
      if (entry.ownerGeneration !== generation) continue;
      entry.resolvedPath = null;
      entry.dependencyEpoch++;
    }
  }

  #invalidate(change: FileChange, generation: string) {
    if (this.#readyGeneration !== generation) return;
    const targeted = change.type === 'update' && change.kind === 'file';
    for (const entry of this.#resources.values()) {
      if (entry.ownerGeneration !== generation) continue;
      const matches =
        !targeted ||
        entry.resolvedPath === null ||
        (entry.kind === 'folder' ? entry.resolvedPath === parentPath(change.path) : entry.resolvedPath === change.path);
      if (!matches) continue;
      if (!targeted) {
        entry.resolvedPath = null;
        entry.dependencyEpoch++;
      }
      entry.dirty = true;
      this.#enqueue(entry);
    }
  }

  #markGenerationStale(generation: string) {
    for (const entry of this.#resources.values()) {
      if (entry.ownerGeneration !== generation) continue;
      entry.resolvedPath = null;
      entry.dependencyEpoch++;
      entry.dirty = true;
      if (entry.snapshot.data !== undefined) this.#publish(entry, Object.freeze({ ...entry.snapshot, isStale: true }));
    }
  }
}

function parentPath(path: string) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function isRecoverable(cause: unknown) {
  const code =
    (cause as { code?: unknown; details?: { code?: unknown } } | null)?.code ??
    (cause as { details?: { code?: unknown } } | null)?.details?.code;
  return code === 'SUBSCRIPTION_OVERFLOW' || code === 'SUBSCRIPTION_RESYNC_REQUIRED';
}

function isMissing(cause: unknown) {
  let current = cause as { code?: unknown; details?: { code?: unknown }; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 8; depth++, current = current.cause as typeof current) {
    if (current.code === 'ENOENT' || current.details?.code === 'ENOENT') return true;
  }
  return (
    toVolumeError(cause, { operation: 'readFileBuffer', volume: null, mutation: false }).details?.code === 'ENOENT'
  );
}

function sameValue(previous: ResourceValue | undefined, next: ResourceValue): boolean {
  if (previous === next) return true;
  if (previous === undefined || previous === null || next === null) return false;
  if (typeof previous === 'string' || typeof next === 'string') return false;
  if (previous instanceof Uint8Array && next instanceof Uint8Array) return sameBytes(previous, next);
  if (Array.isArray(previous) && Array.isArray(next))
    return (
      previous.length === next.length &&
      previous.every((value, index) => {
        const other = next[index];
        return (
          value.name === other.name &&
          value.mode === other.mode &&
          value.is_dir === other.is_dir &&
          value.is_file === other.is_file
        );
      })
    );
  if (Array.isArray(previous) || Array.isArray(next) || previous instanceof Uint8Array || next instanceof Uint8Array)
    return false;
  const prior = previous as FileInfo;
  const later = next as FileInfo;
  return (
    prior.ino === later.ino &&
    prior.size === later.size &&
    prior.mode === later.mode &&
    prior.mtimeMs === later.mtimeMs &&
    prior.is_file === later.is_file &&
    prior.is_dir === later.is_dir
  );
}

function sameSnapshot(left: ResourceResult<ResourceValue>, right: ResourceResult<ResourceValue>) {
  return (
    left.status === right.status &&
    left.data === right.data &&
    left.error === right.error &&
    left.isRefreshing === right.isRefreshing &&
    left.isStale === right.isStale
  );
}

export function clientStore(client: OpfsVfsWorkerClient): ClientStore {
  let store = stores.get(client);
  if (!store) {
    store = new ClientStore(client);
    stores.set(client, store);
  }
  return store;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let index = 0;
  if (left.byteOffset % 4 === 0 && right.byteOffset % 4 === 0) {
    const words = left.length >>> 2;
    const a = new Uint32Array(left.buffer, left.byteOffset, words);
    const b = new Uint32Array(right.buffer, right.byteOffset, words);
    for (; index < words; index++) if (a[index] !== b[index]) return false;
    index = words << 2;
  }
  for (; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

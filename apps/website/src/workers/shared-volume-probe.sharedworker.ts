/// <reference lib="webworker" />

import { deleteVolume, OpenFlags, OpfsVfs } from '@opfs-vfs/opfs-vfs';

type State = 'starting' | 'ready' | 'closing' | 'cleaned' | 'unsupported' | 'failed';
type Reason =
  | 'missing-opfs'
  | 'missing-sync-access-handle'
  | 'mount-timeout'
  | 'opfs-storage-error'
  | 'volume-ebusy'
  | 'volume-eexist'
  | 'mount-failed'
  | 'command-failed'
  | 'close-failed'
  | 'cleanup-failed';
type Command = 'start' | 'write-sync-read' | 'close-reopen-verify' | 'cleanup';
type Request = { readonly type: Command; readonly requestId: string; readonly session?: string };
type Reply = {
  readonly type: 'result';
  readonly requestId: string;
  readonly operation: Command;
  readonly state: State;
  readonly reason: Reason | null;
  readonly outcome: 'known' | 'unknown';
  readonly ownerId: string | null;
  readonly marker: string | null;
  readonly scratchVolume: string | null;
};

const scope = self as unknown as SharedWorkerGlobalScope;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const filePath = '/shared-volume-probe.txt';
let state: State = 'starting';
let reason: Reason | null = null;
let ownerId: string | null = null;
let scratchVolume: string | null = null;
let marker: string | null = null;
let vfs: OpfsVfs | undefined;
let session: string | undefined;
let boot: Promise<void> | undefined;
let closing = false;
let sequence = 0;
let operations = Promise.resolve();

function validSession(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{8,64}$/i.test(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{8,64}$/i.test(value);
}

function reply(port: MessagePort, requestId: string, operation: Command) {
  port.postMessage({
    type: 'result',
    requestId,
    operation,
    state,
    reason,
    outcome: reason === 'mount-timeout' ? 'unknown' : 'known',
    ownerId,
    marker,
    scratchVolume,
  } satisfies Reply);
}

function errorReason(error: unknown): Reason {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'EBUSY') return 'volume-ebusy';
  if (code === 'EEXIST') return 'volume-eexist';
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'UnknownError')
    return 'opfs-storage-error';
  return 'mount-failed';
}

async function bounded<T>(promise: Promise<T>, timeoutReason: Reason): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutReason)), 7_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function readMarker(fs: OpfsVfs): string {
  const fd = fs.openSync(filePath, OpenFlags.O_RDONLY);
  try {
    const size = fs.fstatSync(fd).size;
    const result = fs.readSync(fd, size, 0);
    if (result.read !== size) throw new Error('incomplete-read');
    return decoder.decode(result.buffer);
  } finally {
    fs.closeSync(fd);
  }
}

async function closeMounted(): Promise<void> {
  const current = vfs;
  if (!current) return;
  await current.closeVfs();
  vfs = undefined;
}

async function mount(mode: 'create-new' | 'open-existing') {
  if (typeof navigator.storage?.getDirectory !== 'function') throw new Error('missing-opfs');
  if (
    typeof FileSystemFileHandle === 'undefined' ||
    typeof FileSystemFileHandle.prototype.createSyncAccessHandle !== 'function'
  )
    throw new Error('missing-sync-access-handle');
  const next = new OpfsVfs(scratchVolume!, { openMode: mode });
  vfs = next;
  try {
    await bounded(next.ready, 'mount-timeout');
  } catch (error) {
    if (error instanceof Error && error.message === 'mount-timeout') {
      void next.ready.then(() => next.closeVfs()).catch(() => {});
    }
    vfs = undefined;
    throw error;
  }
}

function start(nextSession: string) {
  if (boot) return boot;
  session = nextSession;
  scratchVolume = `opfs-vfs-shared-volume-probe-${session}.bin`;
  boot = (async () => {
    try {
      await mount('create-new');
      ownerId = crypto.randomUUID();
      state = 'ready';
    } catch (error) {
      reason =
        error instanceof Error && (error.message === 'missing-opfs' || error.message === 'missing-sync-access-handle')
          ? error.message
          : errorReason(error);
      if (error instanceof Error && error.message === 'mount-timeout') reason = 'mount-timeout';
      state = reason === 'missing-opfs' || reason === 'missing-sync-access-handle' ? 'unsupported' : 'failed';
    }
  })();
  return boot;
}

async function writeSyncRead() {
  if (!vfs) throw new Error('no-mounted-volume');
  const next = `shared-volume-marker-${++sequence}`;
  vfs.writeFileBufferSync(filePath, encoder.encode(next));
  vfs.syncSync();
  if (readMarker(vfs) !== next) throw new Error('marker-mismatch');
  marker = next;
}

async function closeReopenVerify() {
  if (!vfs || !marker) throw new Error('no-marker');
  closing = true;
  state = 'closing';
  await closeMounted();
  await mount('open-existing');
  if (!vfs || readMarker(vfs) !== marker) throw new Error('marker-mismatch');
  closing = false;
  state = 'ready';
}

async function cleanup() {
  if (!vfs || !scratchVolume) throw new Error('no-mounted-volume');
  closing = true;
  state = 'closing';
  await closeMounted();
  await deleteVolume(scratchVolume);
  state = 'cleaned';
  ownerId = null;
  marker = null;
}

function enqueue(
  port: MessagePort,
  requestId: string,
  operation: Exclude<Command, 'start'>,
  task: () => Promise<void>,
  failureReason: Reason,
) {
  const run = async () => {
    if (closing || state !== 'ready') return;
    try {
      await task();
    } catch {
      state = 'failed';
      reason = failureReason;
      closing = true;
    }
  };
  operations = operations.then(run, run).then(
    () => undefined,
    () => undefined,
  );
  void operations.then(() => reply(port, requestId, operation));
}

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]!;
  port.start();
  port.onmessage = (event: MessageEvent<Request>) => {
    const message = event.data;
    if (!message || !validRequestId(message.requestId)) return;
    if (message.type === 'start') {
      if (!validSession(message.session) || (session && session !== message.session)) return;
      void start(message.session).then(() => reply(port, message.requestId, 'start'));
      return;
    }
    if (message.type === 'write-sync-read')
      return enqueue(port, message.requestId, 'write-sync-read', writeSyncRead, 'command-failed');
    if (message.type === 'close-reopen-verify')
      return enqueue(port, message.requestId, 'close-reopen-verify', closeReopenVerify, 'close-failed');
    if (message.type === 'cleanup') return enqueue(port, message.requestId, 'cleanup', cleanup, 'cleanup-failed');
  };
};

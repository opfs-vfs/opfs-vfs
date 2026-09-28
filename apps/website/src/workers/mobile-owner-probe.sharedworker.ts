/// <reference lib="webworker" />

type State = 'starting' | 'native-ready' | 'unsupported';
type Reason =
  | 'nested-worker-unavailable'
  | 'nested-worker-failed'
  | 'shared-array-buffer-unavailable'
  | 'opfs-sync-handle-failed'
  | 'native-cleanup-failed';
type StartMessage = { readonly type: 'start'; readonly session: string };
type Reply = { readonly type: 'state'; readonly state: State; readonly reason: Reason | null };

const scope = self as unknown as SharedWorkerGlobalScope;
const ports = new Set<MessagePort>();
let started: Promise<void> | undefined;
let state: State = 'starting';
let reason: Reason | null = null;

function validSession(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{8,64}$/i.test(value);
}

function publish(next: State, nextReason: Reason | null = null) {
  state = next;
  reason = nextReason;
  for (const port of ports) port.postMessage({ type: 'state', state, reason } satisfies Reply);
}

async function probeNative(session: string) {
  if (typeof Worker !== 'function') throw new Error('nested-worker-unavailable');
  if (typeof SharedArrayBuffer !== 'function') throw new Error('shared-array-buffer-unavailable');
  if (typeof navigator.storage?.getDirectory !== 'function') throw new Error('opfs-sync-handle-failed');
  const fileName = `opfs-vfs-ios-owner-probe-${session}.native`;
  const nested = new Worker(new URL('./mobile-owner-probe-nested.worker.ts', import.meta.url), { type: 'module' });
  let outcome: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('nested-worker-failed')), 5_000);
      nested.onmessage = (event: MessageEvent<{ readonly type: string }>) => {
        clearTimeout(timeout);
        if (event.data.type === 'native-ready') resolve();
        else reject(new Error('opfs-sync-handle-failed'));
      };
      nested.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('nested-worker-failed'));
      };
      nested.postMessage({ type: 'probe', fileName });
    });
  } catch (error) {
    outcome = error;
  } finally {
    nested.terminate();
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw new Error('native-cleanup-failed');
  }
  if (outcome !== undefined) throw outcome;
}

function start(session: string) {
  if (started) return started;
  started = probeNative(session).then(
    () => publish('native-ready'),
    (error) => {
      const nextReason: Reason =
        error instanceof Error &&
        (error.message === 'nested-worker-unavailable' ||
          error.message === 'nested-worker-failed' ||
          error.message === 'shared-array-buffer-unavailable' ||
          error.message === 'opfs-sync-handle-failed' ||
          error.message === 'native-cleanup-failed')
          ? error.message
          : 'nested-worker-failed';
      publish('unsupported', nextReason);
    },
  );
  return started;
}

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]!;
  ports.add(port);
  port.start();
  port.onmessage = (message: MessageEvent<StartMessage>) => {
    if (message.data?.type !== 'start' || !validSession(message.data.session)) return;
    void start(message.data.session);
    port.postMessage({ type: 'state', state, reason } satisfies Reply);
  };
  port.onmessageerror = () => ports.delete(port);
};

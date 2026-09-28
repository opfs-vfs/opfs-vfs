type Result = {
  readonly type: 'result';
  readonly requestId: string;
  readonly operation: 'start' | 'write-sync-read' | 'close-reopen-verify' | 'cleanup';
  readonly state: string;
  readonly reason: string | null;
  readonly outcome: 'known' | 'unknown';
  readonly ownerId: string | null;
  readonly marker: string | null;
  readonly scratchVolume: string | null;
};
type Operation = Result['operation'];

const root = document.querySelector<HTMLElement>('[data-shared-volume-probe]');
if (!root) throw new Error('Shared volume probe root is missing');

const state = root.querySelector<HTMLElement>('[data-state]')!;
const report = root.querySelector<HTMLOutputElement>('[data-report]')!;
const link = root.querySelector<HTMLAnchorElement>('[data-same-session]')!;
const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
const requestedSession = new URLSearchParams(location.search).get('session');
const session =
  requestedSession && /^[a-z0-9-]{8,64}$/i.test(requestedSession) ? requestedSession : crypto.randomUUID();
const nextUrl = `${location.pathname}?session=${encodeURIComponent(session)}`;
const scratchVolume = `opfs-vfs-shared-volume-probe-${session}.bin`;
let port: MessagePort | undefined;
let worker: SharedWorker | undefined;
let terminal = false;
let activeOperation: Operation | undefined;

function show(result: Omit<Result, 'type' | 'requestId'>) {
  if (terminal) return;
  state.textContent =
    result.state === 'indeterminate'
      ? `indeterminate: ${result.reason ?? 'unknown'} (operation may have completed)`
      : result.reason
        ? `${result.state}: ${result.reason}`
        : result.state;
  report.value = JSON.stringify({ session, ...result, scratchVolume: result.scratchVolume ?? scratchVolume });
  terminal ||= ['unsupported', 'failed', 'cleaned', 'indeterminate'].includes(result.state);
  for (const button of buttons)
    button.disabled = terminal || result.state !== 'ready' || (button.hasAttribute('data-reopen') && !result.marker);
}

function request(type: 'start' | 'write-sync-read' | 'close-reopen-verify' | 'cleanup'): Promise<Result> {
  const sharedPort = port;
  if (!sharedPort) return Promise.reject(new Error('shared-worker-unavailable'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      sharedPort.removeEventListener('message', receive);
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('probe-timeout'));
    }, 8_000);
    const receive = (event: MessageEvent<Result>) => {
      if (event.data?.type !== 'result' || event.data.requestId !== requestId) return;
      finish();
      resolve(event.data);
    };
    sharedPort.addEventListener('message', receive);
    try {
      sharedPort.postMessage(type === 'start' ? { type, requestId, session } : { type, requestId });
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

function requestFailure(operation: Operation, error: unknown) {
  const timedOut = error instanceof Error && error.message === 'probe-timeout';
  show({
    state: timedOut ? 'indeterminate' : 'failed',
    reason: timedOut ? 'page-timeout' : 'shared-worker-unavailable',
    outcome: timedOut ? 'unknown' : 'known',
    operation,
    ownerId: null,
    marker: null,
    scratchVolume: null,
  });
}

function transportFailure(reason: string) {
  const operation = activeOperation;
  show({
    state: operation ? 'indeterminate' : 'failed',
    reason,
    outcome: operation ? 'unknown' : 'known',
    operation: operation ?? 'start',
    ownerId: null,
    marker: null,
    scratchVolume: null,
  });
}

async function run(type: Exclude<Operation, 'start'>) {
  for (const button of buttons) button.disabled = true;
  activeOperation = type;
  try {
    show(await request(type));
  } catch (error) {
    requestFailure(type, error);
  } finally {
    activeOperation = undefined;
  }
}

link.href = nextUrl;
link.textContent = new URL(nextUrl, location.href).href;
for (const button of buttons) button.disabled = true;
root.querySelector<HTMLButtonElement>('[data-write]')!.onclick = () => void run('write-sync-read');
root.querySelector<HTMLButtonElement>('[data-reopen]')!.onclick = () => void run('close-reopen-verify');
root.querySelector<HTMLButtonElement>('[data-cleanup]')!.onclick = () => void run('cleanup');

try {
  if (typeof SharedWorker !== 'function') throw new Error('shared-worker-unavailable');
  worker = new SharedWorker(new URL('../workers/shared-volume-probe.sharedworker.ts', import.meta.url), {
    type: 'module',
    name: `opfs-vfs-shared-volume-probe-${session}`,
  });
  worker.onerror = () => transportFailure('shared-worker-failed');
  worker.port.onmessageerror = () => transportFailure('shared-worker-message-error');
  port = worker.port;
  port.start();
  activeOperation = 'start';
  try {
    show(await request('start'));
  } catch (error) {
    requestFailure('start', error);
  } finally {
    activeOperation = undefined;
  }
} catch (error) {
  show({
    state: 'unsupported',
    reason:
      error instanceof Error && error.message === 'shared-worker-unavailable'
        ? 'shared-worker-unavailable'
        : 'shared-worker-failed',
    outcome: 'known',
    operation: 'start',
    ownerId: null,
    marker: null,
    scratchVolume: null,
  });
}

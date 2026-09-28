type Report = {
  readonly role: 'owner' | 'challenge';
  readonly session: string;
  readonly state: string;
  readonly lock: string | null;
  readonly ownerId: string | null;
  readonly responseMs: number | null;
};

const root = document.querySelector<HTMLElement>('[data-dedicated-owner-probe]');
if (!root) throw new Error('Dedicated owner probe root is missing');

const params = new URLSearchParams(location.search);
const requestedSession = params.get('session');
const session =
  requestedSession && /^[a-z0-9-]{8,64}$/i.test(requestedSession) ? requestedSession : crypto.randomUUID();
const role = params.get('role') === 'challenge' ? 'challenge' : 'owner';
const report = root.querySelector<HTMLOutputElement>('[data-report]')!;
const state = root.querySelector<HTMLElement>('[data-state]')!;
const challenge = root.querySelector<HTMLButtonElement>('[data-challenge]');
const close = root.querySelector<HTMLButtonElement>('[data-close]');
const link = root.querySelector<HTMLAnchorElement>('[data-same-session]')!;
const lockName = `opfs-vfs:dedicated-owner-probe:${session}`;
const channelName = `opfs-vfs:dedicated-owner-probe:${session}:nonce`;
let worker: Worker | undefined;

function show(next: Omit<Report, 'role' | 'session'>) {
  report.value = JSON.stringify({ role, session, ...next });
  state.textContent = next.state;
}

link.href = `${location.pathname}?session=${encodeURIComponent(session)}&role=challenge`;
link.textContent = location.href.replace(location.search, link.href.slice(link.href.indexOf('?')));

async function challengeOwner() {
  challenge!.disabled = true;
  try {
    let ignoreLateLockQuery = false;
    let lockQueryDeadline: ReturnType<typeof setTimeout> | undefined;
    const lockQuery = navigator.locks.request(lockName, { ifAvailable: true }, (held) => {
      if (ignoreLateLockQuery) return 'late-lock-query-ignored';
      return held ? 'available' : 'held-by-owner';
    });
    void lockQuery.catch(() => {});
    const lock = await Promise.race([
      lockQuery,
      new Promise<never>((_resolve, reject) => {
        lockQueryDeadline = setTimeout(() => {
          ignoreLateLockQuery = true;
          reject(new Error('lock-query-timeout'));
        }, 3_000);
      }),
    ]).finally(() => clearTimeout(lockQueryDeadline));
    const nonce = crypto.randomUUID();
    const channel = new BroadcastChannel(channelName);
    const began = performance.now();
    const response = await new Promise<{ ownerId: string | null; responseMs: number | null }>((resolve) => {
      const deadline = setTimeout(() => {
        channel.close();
        resolve({ ownerId: null, responseMs: null });
      }, 3_000);
      channel.onmessage = ({
        data,
      }: MessageEvent<{ readonly type?: unknown; readonly nonce?: unknown; readonly ownerId?: unknown }>) => {
        if (data?.type !== 'response' || data.nonce !== nonce || typeof data.ownerId !== 'string') return;
        clearTimeout(deadline);
        channel.close();
        resolve({ ownerId: data.ownerId, responseMs: Math.round(performance.now() - began) });
      };
      channel.postMessage({ type: 'challenge', nonce });
    });
    show({
      state: lock === 'held-by-owner' && response.ownerId ? 'owner-responsive' : 'owner-no-response',
      lock,
      ...response,
    });
  } catch (error) {
    show({
      state:
        error instanceof Error && error.message === 'lock-query-timeout' ? 'lock-query-timeout' : 'challenge-failed',
      lock: null,
      ownerId: null,
      responseMs: null,
    });
  } finally {
    challenge!.disabled = false;
  }
}

if (role === 'owner') {
  try {
    worker = new Worker(new URL('../workers/dedicated-owner-probe.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    show({ state: 'owner-worker-failed', lock: null, ownerId: null, responseMs: null });
  }
  if (worker) {
    const deadline = setTimeout(() => {
      worker?.terminate();
      show({ state: 'owner-ready-timeout', lock: null, ownerId: null, responseMs: null });
    }, 5_000);
    worker.onmessage = ({
      data,
    }: MessageEvent<{ readonly type: string; readonly ownerId?: string; readonly reason?: string }>) => {
      clearTimeout(deadline);
      if (data.type === 'ready')
        show({ state: 'owner-ready', lock: 'held', ownerId: data.ownerId ?? null, responseMs: null });
      if (data.type === 'failed')
        show({ state: data.reason ?? 'owner-failed', lock: null, ownerId: null, responseMs: null });
      if (data.type === 'closed') show({ state: 'owner-closed', lock: null, ownerId: null, responseMs: null });
    };
    worker.onerror = () => {
      clearTimeout(deadline);
      show({ state: 'owner-worker-failed', lock: null, ownerId: null, responseMs: null });
    };
    worker.postMessage({ type: 'start', session });
  }
  close!.onclick = () => worker?.postMessage({ type: 'close' });
} else {
  close!.hidden = true;
  show({ state: 'challenge-ready', lock: null, ownerId: null, responseMs: null });
}

challenge!.onclick = () => void challengeOwner();

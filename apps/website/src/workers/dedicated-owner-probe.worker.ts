/// <reference lib="webworker" />

type Message = { readonly type: 'start'; readonly session: string } | { readonly type: 'close' };
type Challenge = { readonly type: 'challenge'; readonly nonce: string };

const scope = self as DedicatedWorkerGlobalScope;
let release: (() => void) | undefined;
let channel: BroadcastChannel | undefined;

function lockName(session: string) {
  return `opfs-vfs:dedicated-owner-probe:${session}`;
}

function channelName(session: string) {
  return `opfs-vfs:dedicated-owner-probe:${session}:nonce`;
}

async function start(session: string) {
  const ownerId = crypto.randomUUID();
  try {
    channel = new BroadcastChannel(channelName(session));
    const held = await navigator.locks.request(lockName(session), { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      channel!.onmessage = ({ data }: MessageEvent<Challenge>) => {
        if (data?.type === 'challenge' && typeof data.nonce === 'string')
          channel?.postMessage({ type: 'response', nonce: data.nonce, ownerId });
      };
      scope.postMessage({ type: 'ready', ownerId });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    });
    channel?.close();
    scope.postMessage(held ? { type: 'closed' } : { type: 'failed', reason: 'lock-unavailable' });
  } catch {
    channel?.close();
    scope.postMessage({ type: 'failed', reason: 'lock-request-failed' });
  }
}

scope.onmessage = ({ data }: MessageEvent<Message>) => {
  if (data?.type === 'start') void start(data.session);
  if (data?.type === 'close') release?.();
};

import { useEffect, useMemo, useState } from 'react';
import './mobile-owner-probe.css';

type State = 'starting' | 'native-ready' | 'unsupported';
type Reason =
  | 'shared-worker-unavailable'
  | 'shared-worker-failed'
  | 'nested-worker-unavailable'
  | 'nested-worker-failed'
  | 'shared-array-buffer-unavailable'
  | 'opfs-sync-handle-failed'
  | 'native-cleanup-failed';
type Reply = {
  readonly type: 'state';
  readonly state: State;
  readonly reason: Exclude<Reason, 'shared-worker-unavailable' | 'shared-worker-failed'> | null;
};

function sessionFromLocation() {
  const value = new URLSearchParams(window.location.search).get('probe');
  return value && /^[a-z0-9-]{8,64}$/i.test(value) ? value : crypto.randomUUID();
}

export default function MobileOwnerProbe() {
  const session = useMemo(sessionFromLocation, []);
  const [state, setState] = useState<State | 'unsupported'>('starting');
  const [reason, setReason] = useState<Reason | null>(null);
  const [terminal, setTerminal] = useState(false);

  useEffect(() => {
    if (typeof SharedWorker !== 'function') {
      setState('unsupported');
      setReason('shared-worker-unavailable');
      setTerminal(true);
      return;
    }
    let worker: SharedWorker;
    try {
      worker = new SharedWorker(new URL('../workers/mobile-owner-probe.sharedworker.ts', import.meta.url), {
        type: 'module',
        name: `opfs-vfs-ios-owner-probe-${session}`,
      });
    } catch {
      setState('unsupported');
      setReason('shared-worker-failed');
      setTerminal(true);
      return;
    }
    const port = worker.port;
    let settled = false;
    const deadline = setTimeout(() => {
      settled = true;
      setState('unsupported');
      setReason('shared-worker-failed');
      setTerminal(true);
    }, 7_000);
    port.start();
    port.onmessage = (event: MessageEvent<Reply>) => {
      if (settled || event.data.type !== 'state') return;
      setState(event.data.state);
      setReason(event.data.reason);
      if (event.data.state !== 'starting') {
        settled = true;
        clearTimeout(deadline);
        setTerminal(true);
      }
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      setState('unsupported');
      setReason('shared-worker-failed');
      setTerminal(true);
    };
    port.postMessage({ type: 'start', session });
    return () => {
      clearTimeout(deadline);
      port.close();
    };
  }, [session]);

  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set('probe', session);
  const copyReport = async () => {
    await navigator.clipboard?.writeText(JSON.stringify({ state, reason, userAgent: navigator.userAgent }));
  };

  return (
    <section className="mobile-owner-probe" aria-label="Mobile ownership coordinator probe">
      <p className="mobile-owner-probe__state">Native coordinator gate: {state}</p>
      <p className="mobile-owner-probe__result" role="status">
        {state === 'starting'
          ? 'Checking SharedWorker, nested dedicated worker, and disposable OPFS sync-handle support.'
          : state === 'native-ready'
            ? 'Native capability passed. Coordinator integration remains disabled because the cross-browser topology is rejected.'
            : `Unsupported: ${reason ?? 'capability failed'}. No page-owned fallback was started.`}
      </p>
      <p className="mobile-owner-probe__session">
        Run this same disposable session in another tab: <a href={shareUrl.toString()}>{shareUrl.toString()}</a>
      </p>
      <div className="mobile-owner-probe__actions">
        <button type="button" onClick={() => void copyReport()} disabled={!terminal}>
          Copy fixed-field report
        </button>
      </div>
    </section>
  );
}

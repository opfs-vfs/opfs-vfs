import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectField } from './ui/select-field';
import {
  collectionEnvironment,
  collectionOmitsAhp,
  type CollectionBrowser,
  collectionEligible,
  collectionJobs,
  collectionSchedule,
  type CollectionEntry,
} from '../lib/benchmark-collection';
import type { BenchmarkWorkerEvent } from '../lib/benchmark';
import type { FilesystemEvent } from '../lib/filesystem-benchmark';
import { SPEED_TEST_REVISION, SPEED_TEST_SOURCE } from '../lib/pglite-speedtest';
import './BenchmarkRunner.css';

const machines = [
  { id: 'm5-pro', label: 'MacBook Pro 16-inch · M5 Pro · 64 GB', macOS: '26.6.2' },
  { id: 'm1-max', label: 'Mac Studio 2022 · M1 Max · 64 GB', macOS: '26.5.2' },
];
type Collection = {
  schemaVersion: 1;
  kind: 'opfs-vfs-benchmark-collection';
  protocol: 'browser-collection-v2';
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'cancelled' | 'failed';
  interrupted: boolean;
  eligibleForReview: boolean;
  error?: string;
  environment: {
    machine: string;
    macOS?: string;
    os: string;
    osVersion: string;
    browser: string;
    browserVersion: string;
    userAgent: string;
    profile: 'regular-extensions-off';
    notes: string;
    hardwareConcurrency: number;
    crossOriginIsolated: boolean;
  };
  versions: { sourceCommit: string; opfsVfs: string; pglite: string };
  workloads: { speedtest: string; source: string; transactions: string; filesystem: string; payloadBytes: number };
  skipped: { backend: string; reason: string }[];
  jobs: ReturnType<typeof collectionJobs>;
  entries: CollectionEntry[];
};

export default function BenchmarkCollection() {
  const [detected] = useState(() =>
    collectionEnvironment(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
  );
  const [machine, setMachine] = useState('');
  const [os, setOs] = useState(detected.os);
  const [osVersion, setOsVersion] = useState('');
  const [browser, setBrowser] = useState<CollectionBrowser | null>(detected.browser);
  const [browserVersion, setBrowserVersion] = useState(detected.browserVersion);
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<Collection | null>(null);
  const [progress, setProgress] = useState('Ready');
  const [error, setError] = useState('');
  const control = useRef<{ cancel: () => void } | null>(null);
  const omitAhp = collectionOmitsAhp(browser, os, detected.mobileApple);
  const running = report?.status === 'running';
  useEffect(() => () => control.current?.cancel(), []);

  const run = async () => {
    if (!browser || control.current) return;
    setError('');
    if (
      !crossOriginIsolated ||
      typeof SharedArrayBuffer === 'undefined' ||
      !navigator.locks ||
      !navigator.storage?.getDirectory
    ) {
      setError(
        'OPFS, Web Locks and cross-origin isolation are required. Open the deployed HTTPS page or local production preview in a regular browser profile.',
      );
      return;
    }
    const result: Collection = {
      schemaVersion: 1,
      kind: 'opfs-vfs-benchmark-collection',
      protocol: 'browser-collection-v2',
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      status: 'running',
      interrupted: document.hidden,
      eligibleForReview: false,
      environment: {
        machine: machine.trim(),
        os: os.trim(),
        osVersion: osVersion.trim(),
        ...(os === 'macOS' ? { macOS: osVersion.trim() } : {}),
        browser,
        browserVersion,
        userAgent: navigator.userAgent,
        profile: 'regular-extensions-off',
        notes,
        hardwareConcurrency: navigator.hardwareConcurrency,
        crossOriginIsolated,
      },
      versions: {
        sourceCommit: import.meta.env.PUBLIC_SOURCE_COMMIT,
        opfsVfs: import.meta.env.PUBLIC_OPFS_VFS_VERSION,
        pglite: import.meta.env.PUBLIC_PGLITE_VERSION,
      },
      workloads: {
        speedtest: SPEED_TEST_REVISION,
        source: SPEED_TEST_SOURCE,
        transactions: 'pglite-sql-v2',
        filesystem: 'small-files-v1',
        payloadBytes: 1024,
      },
      skipped: omitAhp
        ? [{ backend: 'opfs-ahp', reason: 'Omitted on Safari and iOS/iPadOS by collection protocol.' }]
        : [],
      jobs: collectionJobs(browser, omitAhp),
      entries: [],
    };
    const publish = () => setReport({ ...result, entries: [...result.entries] });
    let cancelled = false;
    let cancelWorker: (() => void) | undefined;
    control.current = {
      cancel: () => {
        cancelled = true;
        result.interrupted = true;
        setProgress('Cancelling and waiting for cleanup…');
        cancelWorker?.();
      },
    };
    const hidden = () => {
      if (document.hidden) {
        result.interrupted = true;
        publish();
      }
    };
    const unloading = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('beforeunload', unloading);
    publish();
    try {
      await navigator.storage.getDirectory();
      const schedule = collectionSchedule(result.jobs);
      for (const [index, { job, round, warmup }] of schedule.entries()) {
        if (cancelled) break;
        const label = `${index + 1}/${schedule.length} · ${warmup ? 'Warm-up' : `Round ${round}/5`} · ${job.id}`;
        setProgress(label);
        const entry: CollectionEntry = {
          jobId: job.id,
          round,
          warmup,
          startedAt: new Date().toISOString(),
          samples: [],
        };
        result.entries.push(entry);
        await new Promise<void>((resolve, reject) => {
          const worker =
            job.suite === 'sql'
              ? new Worker(new URL('../workers/benchmark.worker.ts', import.meta.url), { type: 'module' })
              : new Worker(new URL('../workers/filesystem-benchmark.worker.ts', import.meta.url), { type: 'module' });
          const cancellation = new Int32Array(new SharedArrayBuffer(4));
          let grace: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          let settled = false;
          const finish = (failure?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(grace);
            cancelWorker = undefined;
            worker.terminate();
            entry.finishedAt = new Date().toISOString();
            if (failure) {
              entry.error = failure;
              reject(new Error(failure));
            } else resolve();
          };
          cancelWorker = () => {
            if (grace) return;
            if (job.suite === 'sql') worker.postMessage({ type: 'cancel' });
            Atomics.store(cancellation, 0, 1);
            grace = setTimeout(
              () =>
                finish(
                  'Worker did not stop within 30 seconds. Cleanup is unconfirmed; clear this benchmark origin’s data before retrying.',
                ),
              30_000,
            );
          };
          const timeout = setTimeout(() => {
            timedOut = true;
            cancelWorker?.();
          }, 600_000);
          worker.onmessage = ({ data }: MessageEvent<BenchmarkWorkerEvent | FilesystemEvent>) => {
            if (data.type === 'sample') {
              entry.samples.push(data.sample);
              publish();
            }
            if (data.type === 'prepared') entry.preparationMs = data.preparationMs;
            if (data.type === 'progress' && !cancelled) setProgress(`${label}${data.stage ? ` · ${data.stage}` : ''}`);
            if (data.type === 'fatal')
              finish(`${data.error} Cleanup is unconfirmed; clear this benchmark origin’s data before retrying.`);
            if (data.type === 'done')
              finish(
                entry.samples.some((sample) => sample.error?.includes('Cleanup failed:'))
                  ? 'Cleanup failed. Clear this benchmark origin’s data before retrying.'
                  : timedOut
                    ? 'Sample exceeded the ten-minute limit.'
                    : undefined,
              );
          };
          worker.onerror = (event) =>
            finish(`${event.message} Cleanup is unconfirmed; clear this benchmark origin’s data before retrying.`);
          worker.postMessage(
            job.suite === 'sql'
              ? { type: 'run', config: job.config }
              : { config: job.config, cancellation: cancellation.buffer },
          );
        });
        publish();
      }
      result.status = cancelled ? 'cancelled' : 'complete';
    } catch (caught) {
      result.status = 'failed';
      result.error = caught instanceof Error ? caught.message : String(caught);
      setError(result.error);
    } finally {
      result.finishedAt = new Date().toISOString();
      result.eligibleForReview =
        result.status === 'complete' && collectionEligible(result.jobs, result.entries, result.interrupted);
      control.current = null;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('beforeunload', unloading);
      setProgress(result.status === 'complete' ? 'Complete' : result.status === 'cancelled' ? 'Cancelled' : 'Failed');
      publish();
    }
  };
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `opfs-bench-${report.environment.browser}-${report.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="benchmark-runner" aria-busy={running}>
      <header>
        <div>
          <h2>Collect a full benchmark set</h2>
          <p>One excluded warm-up and five measured rounds. Download one JSON file per browser.</p>
        </div>
        <p role="status">{progress}</p>
      </header>
      <p className="note">
        Detected browser: {detected.browser ?? 'unknown'}. Review the browser and version below; detection can be
        incomplete. Device model and exact OS version must be entered manually. No serial number is needed.
      </p>
      <fieldset className="collection-environment" disabled={running}>
        <legend>Environment</legend>
        <label>
          Optional Mac preset
          <SelectField
            label="Optional Mac preset"
            disabled={running}
            value="custom"
            options={[
              { value: 'custom', label: 'Enter your device below' },
              ...machines.map((m) => ({ value: m.id, label: m.label })),
            ]}
            onValueChange={(id) => {
              const selected = machines.find((m) => m.id === id);
              if (selected) {
                setMachine(selected.label);
                setOs('macOS');
                setOsVersion(selected.macOS);
              }
            }}
          />
        </label>
        <label>
          Machine / device{' '}
          <Input
            placeholder="e.g. iPhone 16 Pro, or Mac model · chip · RAM"
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
          />
        </label>
        <label>
          Operating system{' '}
          <Input placeholder="macOS, iOS, iPadOS, Windows…" value={os} onChange={(e) => setOs(e.target.value)} />
        </label>
        <label>
          OS version{' '}
          <Input
            placeholder="Check your device settings"
            value={osVersion}
            onChange={(e) => setOsVersion(e.target.value)}
          />
        </label>
        <label>
          Browser
          <SelectField
            label="Browser"
            disabled={running}
            value={browser ?? 'unknown'}
            options={[
              { value: 'unknown', label: 'Select browser' },
              { value: 'chrome', label: 'Chrome' },
              { value: 'safari', label: 'Safari' },
              { value: 'firefox', label: 'Firefox' },
            ]}
            onValueChange={(value) => {
              setBrowser(value === 'unknown' ? null : (value as CollectionBrowser));
              setBrowserVersion('');
            }}
          />
        </label>
        <label>
          Browser version{' '}
          <Input
            aria-label="Browser version"
            placeholder="Copy full version from About / Settings"
            value={browserVersion}
            onChange={(e) => setBrowserVersion(e.target.value)}
          />
        </label>
        <label>
          Notes{' '}
          <Input
            placeholder="Power mode, free disk space, unusual conditions"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I am using a
          regular browsing, extensions off, plugged in, with other apps quiet. I followed the setup guide above.
        </label>
      </fieldset>
      <p>
        Runs the 16 PGlite SQL cases and a 10,000-row transaction batch on OPFS VFS with disk and memory buffers,
        IndexedDB, and a memory-only reference
        {omitAhp ? '. OPFS AHP is omitted on Safari and iOS/iPadOS.' : ', plus OPFS AHP.'} Also tests 1,000 files in
        both VFS buffer modes. All persistent VFS tests use balanced durability; PGlite waits for filesystem
        synchronization.
      </p>
      <p className="note">
        Keep this tab visible and the device awake. Each sample uses fresh storage and a fresh worker. Warm-ups prime
        browser caches, not a reused worker. Preparation, close and cleanup are outside the workload timers.
        Cancellation may wait for the current SQL case.
      </p>
      <div className="actions">
        <Button
          disabled={
            running ||
            !browser ||
            !confirmed ||
            !machine.trim() ||
            !os.trim() ||
            !osVersion.trim() ||
            !browserVersion.trim()
          }
          onClick={() => void run()}
        >
          Run collection
        </Button>
        <Button variant="outline" disabled={!running} onClick={() => control.current?.cancel()}>
          Cancel
        </Button>
        <Button variant="outline" disabled={!report || running} onClick={download}>
          Download JSON
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {report?.interrupted && (
        <p role="alert">
          This collection was interrupted or backgrounded. Retain it for diagnosis and rerun before publication.
        </p>
      )}
      {report && !running && (
        <p>
          {report.eligibleForReview
            ? 'All checks passed. Ready for review before publication.'
            : 'Incomplete or questionable collection. Download includes all results and errors.'}{' '}
          {report.entries.filter((e) => !e.warmup && e.samples[0]?.status === 'ok').length} successful measured samples.
        </p>
      )}
      {report?.entries
        .filter((e) => e.error || e.samples.some((s) => s.status !== 'ok'))
        .map((e, index) => (
          <p role="alert" key={index}>
            {e.jobId}, round {e.round}: {e.error ?? e.samples.map((s) => s.error ?? s.status).join('; ')}
          </p>
        ))}
    </section>
  );
}

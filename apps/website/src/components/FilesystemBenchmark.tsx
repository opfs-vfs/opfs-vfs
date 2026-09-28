import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectField } from './ui/select-field';
import { Download, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { median } from '../lib/benchmark';
import {
  phases,
  type FilesystemConfig,
  type FilesystemEvent,
  type FilesystemSample,
} from '../lib/filesystem-benchmark';
import './BenchmarkRunner.css';
type Report = {
  schemaVersion: 1;
  workloadRevision: 'small-files-v1';
  sourceCommit: string;
  opfsVfsVersion: string;
  createdAt: string;
  userAgent: string;
  crossOriginIsolated: boolean;
  hardware: string;
  interrupted: boolean;
  config: FilesystemConfig;
  payloadBytes: number;
  samples: FilesystemSample[];
};
export default function FilesystemBenchmark() {
  const [config, setConfig] = useState<FilesystemConfig>({
    files: 100,
    repetitions: 3,
    bufferMode: 'disk',
    durability: 'balanced',
  });
  const [report, setReport] = useState<Report | null>(null),
    [running, setRunning] = useState(false),
    [error, setError] = useState(''),
    [hardware, setHardware] = useState('');
  const cancellation = useRef<Int32Array | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (cancellation.current) Atomics.store(cancellation.current, 0, 1);
    };
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (running && document.hidden) setReport((old) => (old ? { ...old, interrupted: true } : old));
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [running]);
  const cancel = () => {
    if (cancellation.current) Atomics.store(cancellation.current, 0, 1);
    setReport((old) => (old ? { ...old, interrupted: true } : old));
  };
  const run = () => {
    setError('');
    if (
      !crossOriginIsolated ||
      !navigator.storage?.getDirectory ||
      !navigator.locks ||
      typeof SharedArrayBuffer === 'undefined'
    ) {
      setError('This benchmark needs OPFS, Web Locks, and cross-origin isolation.');
      return;
    }
    const worker = new Worker(new URL('../workers/filesystem-benchmark.worker.ts', import.meta.url), {
      type: 'module',
    });
    const signal = new SharedArrayBuffer(4);
    cancellation.current = new Int32Array(signal);
    setReport({
      schemaVersion: 1,
      workloadRevision: 'small-files-v1',
      sourceCommit: import.meta.env.PUBLIC_SOURCE_COMMIT ?? 'working-tree',
      opfsVfsVersion: import.meta.env.PUBLIC_OPFS_VFS_VERSION,
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      hardware,
      interrupted: document.hidden,
      config: structuredClone(config),
      payloadBytes: 1024,
      samples: [],
    });
    setRunning(true);
    worker.onmessage = ({ data }: MessageEvent<FilesystemEvent>) => {
      if (data.type === 'done') {
        worker.terminate();
        if (active.current) setRunning(false);
        return;
      }
      if (active.current) setReport((old) => (old ? { ...old, samples: [...old.samples, data.sample] } : old));
    };
    worker.onerror = (event) => {
      worker.terminate();
      if (active.current) {
        setError(event.message);
        setRunning(false);
      }
    };
    worker.postMessage({ config, cancellation: signal });
  };
  const exportResult = (csv = false) => {
    if (!report) return;
    const quote = (value: string | number | boolean | undefined) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const body = csv
      ? [
          [
            'createdAt',
            'browser',
            'crossOriginIsolated',
            'repetitions',
            'hardware',
            'sourceCommit',
            'version',
            'workload',
            'buffer',
            'durability',
            'files',
            'payloadBytes',
            'interrupted',
            'repetition',
            'status',
            'verifiedFiles',
            'mountMs',
            ...phases.map((phase) => `${phase}Ms`),
            'error',
          ].join(','),
          ...report.samples.map((sample) =>
            [
              report.createdAt,
              report.userAgent,
              report.crossOriginIsolated,
              report.config.repetitions,
              report.hardware,
              report.sourceCommit,
              report.opfsVfsVersion,
              report.workloadRevision,
              report.config.bufferMode,
              report.config.durability,
              report.config.files,
              report.payloadBytes,
              report.interrupted,
              sample.repetition,
              sample.status,
              sample.verifiedFiles,
              sample.mountMs,
              ...phases.map((phase) => sample.timings[phase]),
              sample.error,
            ]
              .map(quote)
              .join(','),
          ),
        ].join('\n')
      : JSON.stringify(report, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: csv ? 'text/csv' : 'application/json' })),
      link = document.createElement('a');
    link.href = url;
    link.download = `filesystem-benchmark.${csv ? 'csv' : 'json'}`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const ok = report?.samples.filter((sample) => sample.status === 'ok') ?? [];
  return (
    <section className="benchmark-runner" aria-busy={running}>
      <header>
        <div>
          <p className="eyebrow">Native filesystem suite</p>
          <h2>Configure the filesystem benchmark</h2>
          <p>
            Create, write, verify, rename, delete half, flush, and reopen a fresh OPFS VFS volume. Both buffering
            options persist to OPFS.
          </p>
        </div>
        <p role="status" tabIndex={0}>
          {running ? `Running · ${report?.samples.length ?? 0}/${config.repetitions}` : report ? 'Complete' : 'Ready'}
        </p>
      </header>
      <fieldset disabled={running}>
        <legend>Settings</legend>
        <label>
          Files{' '}
          <SelectField
            label="Files"
            value={String(config.files)}
            onValueChange={(value) => setConfig({ ...config, files: Number(value) })}
            options={[100, 1000].map((x) => ({ value: String(x), label: String(x) }))}
            className="w-full"
          />
        </label>
        <label>
          Runs{' '}
          <SelectField
            label="Runs"
            value={String(config.repetitions)}
            onValueChange={(value) => setConfig({ ...config, repetitions: Number(value) })}
            options={[1, 3, 5].map((x) => ({ value: String(x), label: String(x) }))}
            className="w-full"
          />
        </label>
        <label>
          Buffer{' '}
          <SelectField
            label="Buffer"
            value={String(config.bufferMode)}
            onValueChange={(value) => setConfig({ ...config, bufferMode: value as FilesystemConfig['bufferMode'] })}
            options={['disk', 'memory'].map((value) => ({ value, label: value }))}
            className="w-full"
          />
        </label>
        <label>
          Durability{' '}
          <SelectField
            label="Durability"
            value={String(config.durability)}
            onValueChange={(value) => setConfig({ ...config, durability: value as FilesystemConfig['durability'] })}
            options={['relaxed', 'balanced', 'strict'].map((value) => ({ value, label: value }))}
            className="w-full"
          />
        </label>
      </fieldset>
      <label>
        Hardware / OS notes (optional){' '}
        <Input
          disabled={running}
          value={hardware}
          maxLength={200}
          onChange={(e) => setHardware(e.target.value)}
          placeholder="e.g. MacBook Air M3, macOS"
        />
      </label>
      <div className="actions">
        <Button variant="default" size="default" disabled={running} onClick={run}>
          <Play aria-hidden="true" /> Run filesystem benchmark
        </Button>
        <Button variant="outline" size="default" disabled={!running} onClick={cancel}>
          <Square aria-hidden="true" /> Cancel
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={running || !report?.samples.length}
          onClick={() => exportResult()}
        >
          <Download aria-hidden="true" /> Export JSON
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={running || !report?.samples.length}
          onClick={() => exportResult(true)}
        >
          <Download aria-hidden="true" /> Export CSV
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {report?.interrupted && (
        <p role="alert">
          Questionable run: this tab was backgrounded or the run was interrupted. Rerun in the foreground before
          comparing results.
        </p>
      )}
      <div className="benchmark-table">
        <table>
          <caption>
            {ok.length} successful samples · milliseconds ·{' '}
            {report?.interrupted ? 'questionable measurements' : 'foreground measurements'}
          </caption>
          <thead>
            <tr>
              <th>Phase</th>
              <th>Median</th>
              <th>Min</th>
              <th>Max</th>
            </tr>
          </thead>
          <tbody>
            {['mount', ...phases].map((phase) => {
              const values = ok.flatMap((sample) => {
                const value = phase === 'mount' ? sample.mountMs : sample.timings[phase as (typeof phases)[number]];
                return value === undefined ? [] : [value];
              });
              return (
                <tr key={phase}>
                  <th>{phase}</th>
                  <td>{median(values)?.toFixed(2) ?? '—'}</td>
                  <td>{values.length ? Math.min(...values).toFixed(2) : '—'}</td>
                  <td>{values.length ? Math.max(...values).toFixed(2) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {report?.samples
        .filter((sample) => sample.status !== 'ok')
        .map((sample) => (
          <p key={sample.repetition} role="alert">
            Run {sample.repetition}: {sample.status} · {sample.error}
          </p>
        ))}
      <p className="note">
        Each file contains the same deterministic 1 KiB payload. Read time includes byte verification. Delete removes
        every other file. Reopen time measures the mount; all surviving files are then verified outside that timer.
        Module loading and final cleanup are excluded. Each repetition uses a new volume; browser and OS caches remain
        warm.
      </p>
    </section>
  );
}

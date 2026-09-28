import { Button } from './ui/button';
import { SelectField } from './ui/select-field';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Download, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  median,
  timingRank,
  reportCsv,
  REPETITION_OPTIONS,
  ROW_OPTIONS,
  type BenchmarkBackend,
  type BenchmarkConfig,
  type BenchmarkReport,
  type BenchmarkSample,
  type BenchmarkWorkerEvent,
} from '../lib/benchmark';
import { SPEED_TESTS, SPEED_TEST_REVISION, SPEED_TEST_SOURCE } from '../lib/pglite-speedtest';
import './BenchmarkRunner.css';
const LABELS: Record<BenchmarkBackend, string> = {
    'opfs-vfs': 'OPFS VFS',
    'opfs-ahp': 'PGlite OPFS AHP',
    idb: 'PGlite IndexedDB',
    memory: 'PGlite memory',
  },
  BACKENDS = Object.keys(LABELS) as BenchmarkBackend[];
const download = (name: string, body: string, type: string) => {
  const url = URL.createObjectURL(new Blob([body], { type })),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};
function TimingCell({ rank, children }: { rank: number | null; children: ReactNode }) {
  return (
    <td
      className={rank ? `benchmark-ranked${rank === 1 ? ' benchmark-fastest' : ''}` : undefined}
      data-rank={rank ?? undefined}
    >
      {children}
      {rank && <span className="benchmark-rank-label">{rank === 1 ? 'Fastest' : rank === 2 ? '2nd' : '3rd'}</span>}
    </td>
  );
}

export default function BenchmarkRunner() {
  const [config, setConfig] = useState<BenchmarkConfig>({
      backends: BACKENDS.filter((backend) => backend !== 'memory'),
      rows: 1_000,
      repetitions: 3,
      bufferMode: 'disk',
      durability: 'balanced',
      relaxedDurability: false,
      workload: 'insert-query',
    }),
    [samples, setSamples] = useState<BenchmarkSample[]>([]),
    [running, setRunning] = useState(false),
    [progress, setProgress] = useState('Ready'),
    [error, setError] = useState(''),
    [environmentNote, setEnvironmentNote] = useState('');
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const workerRef = useRef<Worker | null>(null);
  useEffect(
    () => () => {
      workerRef.current?.postMessage({ type: 'cancel' });
    },
    [],
  );
  useEffect(() => {
    if (!running) return;
    const markInterrupted = () => {
      if (document.visibilityState === 'hidden')
        setReport((old) => (old ? { ...old, metadata: { ...old.metadata, interrupted: true } } : old));
    };
    document.addEventListener('visibilitychange', markInterrupted);
    return () => document.removeEventListener('visibilitychange', markInterrupted);
  }, [running]);
  const summaries = BACKENDS.filter((x) => (report?.config ?? config).backends.includes(x)).map((backend) => {
    const ok = samples.filter((x) => x.backend === backend && x.status === 'ok');
    return {
      backend,
      count: ok.length,
      init: median(ok.map((x) => x.initMs)),
      work: median(ok.map((x) => x.workloadMs)),
      persist: median(ok.flatMap((x) => (x.persistenceMs === null ? [] : [x.persistenceMs]))),
      reopen: median(ok.flatMap((x) => (x.reopenMs === null ? [] : [x.reopenMs]))),
      workMin: ok.length ? Math.min(...ok.map((x) => x.workloadMs)) : null,
      workMax: ok.length ? Math.max(...ok.map((x) => x.workloadMs)) : null,
    };
  });
  const comparable =
    !running && progress === 'Complete' && !error && report && !report.metadata.interrupted
      ? summaries.filter((row) => row.count === report.config.repetitions)
      : [];
  const persistentOnly = !config.backends.includes('memory');
  const caseTimings = SPEED_TESTS.map((_, index) =>
    (report?.config.backends ?? []).map((backend) => ({
      backend,
      value: median(
        samples
          .filter((sample) => sample.backend === backend && sample.status === 'ok')
          .flatMap(
            (sample) => sample.stages?.filter((stage) => stage.id === index + 1).map((stage) => stage.durationMs) ?? [],
          ),
      ),
    })),
  );
  const run = () => {
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../workers/benchmark.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setSamples([]);
    const snapshot = structuredClone(config);
    setReport({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated,
      config: snapshot,
      samples: [],
      metadata: {
        workloadRevision: snapshot.workload === 'pglite-speedtest' ? SPEED_TEST_REVISION : 'pglite-sql-v2',
        workloadSource: snapshot.workload === 'pglite-speedtest' ? SPEED_TEST_SOURCE : null,
        sourceCommit: import.meta.env.PUBLIC_SOURCE_COMMIT ?? 'working-tree',
        opfsVfsVersion: import.meta.env.PUBLIC_OPFS_VFS_VERSION ?? 'unknown',
        pgliteVersion: import.meta.env.PUBLIC_PGLITE_VERSION ?? 'unknown',
        interrupted: false,
        environmentNote,
        preparationMs: null,
      },
    });
    setError('');
    setRunning(true);
    worker.onmessage = (event: MessageEvent<BenchmarkWorkerEvent>) => {
      const x = event.data;
      if (x.type === 'progress')
        setProgress(`${LABELS[x.backend]} · run ${x.current}/${x.total}${x.stage ? ` · ${x.stage}` : ''}`);
      if (x.type === 'sample') {
        setSamples((old) => [...old, x.sample]);
        setReport((old) => (old ? { ...old, samples: [...old.samples, x.sample] } : old));
      }
      if (x.type === 'prepared')
        setReport((old) => (old ? { ...old, metadata: { ...old.metadata, preparationMs: x.preparationMs } } : old));
      if (x.type === 'fatal') {
        setProgress('Failed');
        setError(x.error);
        setRunning(false);
        worker.terminate();
      }
      if (x.type === 'done') {
        setProgress(x.cancelled ? 'Cancelled' : 'Complete');
        setRunning(false);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      setProgress('Failed');
      setError(e.message);
      setRunning(false);
      worker.terminate();
    };
    worker.postMessage({ type: 'run', config: snapshot });
  };
  const toggle = (backend: BenchmarkBackend) =>
      setConfig((x) => ({
        ...x,
        backends: x.backends.includes(backend) ? x.backends.filter((y) => y !== backend) : [...x.backends, backend],
      })),
    ms = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)} ms`);
  return (
    <section className="benchmark-runner" aria-busy={running}>
      <header>
        <div>
          <p className="eyebrow">Measured on this device</p>
          <h2>Configure the PGlite benchmark</h2>
          <p>Each backend receives the same SQL and correctness check. Runs are sequential.</p>
        </div>
        <p role="status" tabIndex={0}>
          {progress}
        </p>
      </header>
      <div className="persistence-choice">
        <Button
          type="button"
          variant="outline"
          role="switch"
          aria-checked={persistentOnly}
          aria-describedby="persistence-help"
          disabled={running}
          className="persistence-switch"
          onClick={() =>
            setConfig((current) => {
              if (!current.backends.includes('memory'))
                return { ...current, backends: [...current.backends, 'memory'] };
              const persistent = current.backends.filter((backend) => backend !== 'memory');
              return {
                ...current,
                backends: persistent.length ? persistent : BACKENDS.filter((backend) => backend !== 'memory'),
              };
            })
          }
        >
          <span className="persistence-switch-track" aria-hidden="true">
            <span />
          </span>
          Persistent storage only
        </Button>
        <p id="persistence-help">
          Compare backends that can keep application data across reloads and future sessions. Turn off to include PGlite
          memory as a speed baseline. Memory-only data is lost on reload.{' '}
          <a href="/benchmarks/storage/">Understand storage and durability →</a>
        </p>
        <p className="note">
          This selects backends; durability is configured below. Crash recovery depends on the backend and durability
          settings. This benchmark checks a clean reopen, then deletes its temporary databases. Benchmark runs do not
          resume after reload.
        </p>
      </div>
      <fieldset disabled={running}>
        <legend>Backends</legend>
        {BACKENDS.map((x) => (
          <label key={x}>
            <Checkbox disabled={running} checked={config.backends.includes(x)} onCheckedChange={() => toggle(x)} />
            {LABELS[x]}
          </label>
        ))}
      </fieldset>
      <div className="options">
        <label>
          Hardware / OS note
          <Input
            value={environmentNote}
            disabled={running}
            placeholder="Optional, e.g. M5 Pro · macOS 26"
            onChange={(e) => setEnvironmentNote(e.target.value)}
          />
        </label>
        <label>
          Workload
          <SelectField
            label="Workload"
            value={String(config.workload)}
            onValueChange={(value) =>
              setConfig({
                ...config,
                workload: value as BenchmarkConfig['workload'],
                rows: value === 'pglite-speedtest' ? null : (config.rows ?? 1_000),
              })
            }
            options={[
              { value: 'insert-query', label: 'Insert + query' },
              { value: 'transactions', label: 'Transaction batch' },
              { value: 'pglite-speedtest', label: 'PGlite speed tests · 16 cases' },
            ]}
            disabled={running}
            className="w-full"
          />
        </label>
        <label>
          Rows
          <SelectField
            label="Rows"
            value={config.rows === null ? 'fixed' : String(config.rows)}
            onValueChange={(value) => setConfig({ ...config, rows: Number(value) })}
            options={
              config.rows === null
                ? [{ value: 'fixed', label: 'Fixed upstream dataset' }]
                : ROW_OPTIONS.map((x) => ({ value: String(x), label: String(x) }))
            }
            disabled={running || config.rows === null}
            className="w-full"
          />
        </label>
        <label>
          Runs
          <SelectField
            label="Runs"
            value={String(config.repetitions)}
            onValueChange={(value) => setConfig({ ...config, repetitions: Number(value) })}
            options={REPETITION_OPTIONS.map((x) => ({ value: String(x), label: String(x) }))}
            disabled={running}
            className="w-full"
          />
        </label>
        <label>
          PGlite durability · all backends
          <SelectField
            label="PGlite durability"
            value={config.relaxedDurability ? 'relaxed' : 'default'}
            onValueChange={(value) => setConfig({ ...config, relaxedDurability: value === 'relaxed' })}
            options={[
              { value: 'default', label: 'Default (sync writes)' },
              { value: 'relaxed', label: 'Relaxed' },
            ]}
            disabled={running}
            className="w-full"
          />
        </label>
        <label>
          VFS buffer
          <SelectField
            label="VFS buffer"
            value={String(config.bufferMode)}
            onValueChange={(value) => setConfig({ ...config, bufferMode: value as BenchmarkConfig['bufferMode'] })}
            options={['disk', 'memory'].map((value) => ({ value, label: value }))}
            disabled={running}
            className="w-full"
          />
        </label>
        <label>
          VFS durability
          <SelectField
            label="VFS durability"
            value={String(config.durability)}
            onValueChange={(value) => setConfig({ ...config, durability: value as BenchmarkConfig['durability'] })}
            options={['relaxed', 'balanced', 'strict'].map((value) => ({ value, label: value }))}
            disabled={running}
            className="w-full"
          />
        </label>
      </div>
      {config.workload === 'pglite-speedtest' && (
        <p className="note">
          The 16 published PGlite speed tests, with fixed SQL and datasets up to 25,000 initial rows. Each case runs
          once per backend per repetition. Allow a few minutes for a full comparison.{' '}
          <a href={SPEED_TEST_SOURCE}>Pinned SQL source</a> · <a href="/benchmarks/methodology/">Methodology</a>
        </p>
      )}
      <div className="actions">
        <Button variant="default" size="default" disabled={running || !config.backends.length} onClick={run}>
          <Play aria-hidden="true" /> Run benchmark
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={!running}
          onClick={() => {
            workerRef.current?.postMessage({ type: 'cancel' });
            setReport((old) => (old ? { ...old, metadata: { ...old.metadata, interrupted: true } } : old));
            setProgress('Cancelling after cleanup…');
          }}
        >
          <Square aria-hidden="true" /> Cancel
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={!report?.samples.length || running}
          onClick={() => report && download('benchmark.json', JSON.stringify(report, null, 2), 'application/json')}
        >
          <Download aria-hidden="true" /> Export JSON
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={!report?.samples.length || running}
          onClick={() => report && download('benchmark.csv', reportCsv(report), 'text/csv')}
        >
          <Download aria-hidden="true" /> Export CSV
        </Button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="benchmark-table">
        <table>
          <caption>
            {report?.metadata.interrupted
              ? 'Questionable run: the page was hidden or interrupted. Medians are shown for inspection only.'
              : 'Median timings from successful samples.'}
          </caption>
          <thead>
            <tr>
              <th>Backend</th>
              <th>Samples</th>
              <th>End-to-end init</th>
              <th>Workload median (range)</th>
              <th>Persistence</th>
              <th>Reopen</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((x) => (
              <tr key={x.backend}>
                <th>
                  {LABELS[x.backend]}
                  <span className="backend-storage">
                    {x.backend === 'memory' ? 'Memory only' : 'Persistent storage'}
                  </span>
                </th>
                <td>{x.count}</td>
                {(['init', 'work', 'persist', 'reopen'] as const).map((metric) => (
                  <TimingCell
                    key={metric}
                    rank={
                      comparable.includes(x)
                        ? timingRank(
                            x[metric],
                            comparable.map((row) => row[metric]),
                          )
                        : null
                    }
                  >
                    {ms(x[metric])}
                    {metric === 'work' && ` (${ms(x.workMin)}–${ms(x.workMax)})`}
                  </TimingCell>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report?.config.workload === 'pglite-speedtest' && (
        <div className="benchmark-table">
          <table>
            <caption>Per-case medians · complete successful runs only · milliseconds</caption>
            <thead>
              <tr>
                <th>SQL case</th>
                {report.config.backends.map((backend) => (
                  <th key={backend}>
                    {LABELS[backend]}
                    <span className="backend-storage">
                      {backend === 'memory' ? 'Memory only' : 'Persistent storage'}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SPEED_TESTS.map((label, index) => (
                <tr key={label}>
                  <th>
                    {index + 1}. {label}
                  </th>
                  {caseTimings[index]!.map(({ backend, value }) => (
                    <TimingCell
                      key={backend}
                      rank={
                        comparable.some((row) => row.backend === backend)
                          ? timingRank(
                              value,
                              caseTimings[index]!.filter((item) =>
                                comparable.some((row) => row.backend === item.backend),
                              ).map((item) => item.value),
                            )
                          : null
                      }
                    >
                      {ms(value)}
                    </TimingCell>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {comparable.length > 1 && (
        <p className="note">
          Cells mark the three fastest observed medians for each metric or SQL case among backends with all runs
          successful. Exact ties share a place (1st, 1st, 3rd). Small differences may be measurement noise.
        </p>
      )}
      {samples.some((x) => x.status !== 'ok') && (
        <details>
          <summary>Failed, unavailable, or cancelled samples</summary>
          <ul>
            {samples
              .filter((x) => x.status !== 'ok')
              .map((x) => (
                <li key={`${x.backend}-${x.repetition}`}>
                  {LABELS[x.backend]} run {x.repetition}: {x.status}
                  {x.error ? ` · ${x.error}` : ''}
                </li>
              ))}
          </ul>
        </details>
      )}
      {report && (
        <p className="note">
          Results: {report.config.backends.includes('memory') ? 'Memory baseline included' : 'Persistent storage only'}{' '}
          ·{' '}
          {report.config.workload === 'pglite-speedtest'
            ? 'PGlite speed tests · 16 cases'
            : report.config.workload === 'transactions'
              ? 'Transaction batch'
              : 'Insert + query'}{' '}
          · PGlite durability: {report.config.relaxedDurability ? 'relaxed' : 'default'} · VFS:{' '}
          {report.config.bufferMode}, {report.config.durability}.
        </p>
      )}
      {report?.config.workload === 'pglite-speedtest' && (
        <p className="note">
          The suite ends by dropping its tables. Reopen checks that the tables remain absent; retained-data persistence
          is checked by the two quick workloads. Verification is outside the per-case timings.
        </p>
      )}
      <p className="note">
        PGlite assets are prepared once before samples. Initialization includes the OPFS VFS mount. “Cold” means a new
        logical database; browser and OS caches are not cleared. Memory has no reopen measurement. Persistence timing is
        not measured in relaxed PGlite mode because sync can finish in the background.
      </p>
    </section>
  );
}

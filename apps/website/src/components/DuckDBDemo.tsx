import { useEffect, useRef, useState } from 'react';
import type { DuckDBRequest, DuckDBResponse, QueryResult } from '../workers/duckdb.worker';
import { GROUP_SQL, PREPARE_SQL, SUM_SQL } from '../lib/duckdb-demo';
import './DuckDBDemo.css';

const TABLES_SQL = "SELECT table_name FROM information_schema.tables\nWHERE table_schema = 'main' ORDER BY table_name;";

export default function DuckDBDemo() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sql, setSql] = useState(SUM_SQL);
  const [busy, setBusy] = useState(true);
  const [fatal, setFatal] = useState(false);
  const [status, setStatus] = useState('Checking browser support…');
  const [error, setError] = useState('');
  const [preparation, setPreparation] = useState<{ rows: string; elapsedMs: number } | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);

  function stop(message: string) {
    clearTimeout(timer.current);
    worker.current?.terminate();
    worker.current = null;
    pending.current = true;
    setBusy(false);
    setFatal(true);
    setStatus('Reload required.');
    setError(message);
  }
  function armTimeout(milliseconds: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () =>
        stop(
          'The operation timed out and its worker was stopped. Earlier statements may have committed. Reload and inspect your tables before retrying writes.',
        ),
      milliseconds,
    );
  }
  useEffect(() => {
    if (
      !isSecureContext ||
      !navigator.storage?.getDirectory ||
      !crossOriginIsolated ||
      typeof SharedArrayBuffer === 'undefined'
    ) {
      stop('This demo needs browser file storage and cross-origin isolation on HTTPS or localhost.');
      return;
    }
    let owner: Worker;
    try {
      owner = new Worker(new URL('../workers/duckdb.worker.ts', import.meta.url), { type: 'module' });
    } catch (cause) {
      stop(cause instanceof Error ? cause.message : 'Could not start the DuckDB worker.');
      return;
    }
    worker.current = owner;
    owner.onmessage = ({ data }: MessageEvent<DuckDBResponse>) => {
      if (data.type === 'status') {
        setStatus(data.message);
        return;
      }
      clearTimeout(timer.current);
      pending.current = false;
      setBusy(false);
      if (data.type === 'error') {
        if (data.fatal) stop(data.message);
        else {
          setError(data.message);
          setStatus('Operation failed. You can edit the SQL and try again.');
        }
      } else {
        setStatus(data.message);
        if (data.preparation) setPreparation(data.preparation);
        setResult(data.result ?? null);
      }
    };
    owner.onerror = (event) => {
      event.preventDefault();
      stop('DuckDB could not continue. Reload to reopen your saved database.');
    };
    owner.onmessageerror = () => stop('Could not read the DuckDB response. Reload to reopen the database.');
    armTimeout(90_000);
    owner.postMessage({ type: 'init' } satisfies DuckDBRequest);
    const teardown = () => {
      clearTimeout(timer.current);
      owner.terminate();
    };
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) stop('This page was restored after its database worker closed. Reload to reopen it.');
    };
    window.addEventListener('pagehide', teardown);
    window.addEventListener('pageshow', resume);
    return () => {
      window.removeEventListener('pagehide', teardown);
      window.removeEventListener('pageshow', resume);
      teardown();
      worker.current = null;
    };
  }, []);

  function request(message: DuckDBRequest) {
    if (pending.current || !worker.current || fatal) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    if (message.type === 'prepare') setPreparation(null);
    setStatus(
      message.type === 'query'
        ? 'Running SQL…'
        : message.type === 'prepare'
          ? 'Preparing example data…'
          : 'Saving and reopening…',
    );
    armTimeout(message.type === 'query' ? 15_000 : 90_000);
    try {
      worker.current.postMessage(message);
    } catch {
      stop('Could not reach DuckDB. Reload to reopen the database.');
    }
  }
  const disabled = busy || fatal;
  return (
    <section className="duckdb-demo" aria-label="DuckDB playground" aria-busy={busy}>
      <header>
        <div>
          <p className="kicker">Experimental / persistent SQL</p>
          <h2>Prepare data and run a query</h2>
        </div>
        <div className="duckdb-actions">
          <button
            className="button solid"
            disabled={disabled || !sql.trim()}
            onClick={() => request({ type: 'query', sql })}
          >
            Run SQL
          </button>
          <button className="button" disabled={disabled} onClick={() => request({ type: 'reopen' })}>
            Save &amp; reopen
          </button>
          {fatal && (
            <button className="button" onClick={() => location.reload()}>
              Reload database
            </button>
          )}
        </div>
      </header>
      <p className="duckdb-status" role="status">
        {status}
      </p>
      {error && (
        <p className="duckdb-error" role="alert">
          {error}
        </p>
      )}
      <section className="duckdb-dataset" aria-label="Example dataset">
        <div>
          <h3>1. Prepare the data</h3>
          <p>
            Create one million synthetic sales records with ten columns, entirely in this browser. Existing example data
            is reused without replacing your edits.
          </p>
          <button className="button solid" disabled={disabled} onClick={() => request({ type: 'prepare' })}>
            Prepare or reuse data
          </button>
          {preparation && (
            <p className="duckdb-preparation">
              {Number(preparation.rows).toLocaleString()} rows at preparation · {preparation.elapsedMs.toFixed(1)} ms to
              prepare or reuse, including checkpoint.
            </p>
          )}
          <details>
            <summary>How the data is generated</summary>
            <pre>{PREPARE_SQL}</pre>
          </details>
        </div>
        <div>
          <h3>2. Aggregate a column</h3>
          <p>
            The single-column example sums <code>revenue_cents</code>. The grouped example adds <code>region</code>.
            DuckDB can project those columns instead of materializing every field in every row.
          </p>
          <p>
            OPFS VFS keeps the database here for the next visit. Query timings exclude preparation and include result
            formatting. They depend on your device and caches; this is an interactive example, not a benchmark.
          </p>
        </div>
      </section>
      <div className="duckdb-workspace">
        <section className="duckdb-editor">
          <div className="duckdb-editor-heading">
            <label htmlFor="duckdb-sql">SQL</label>
            <div className="duckdb-actions">
              <button className="button" disabled={disabled} onClick={() => setSql(SUM_SQL)}>
                Sum one column
              </button>
              <button className="button" disabled={disabled} onClick={() => setSql(GROUP_SQL)}>
                Group by region
              </button>
              <button className="button" disabled={disabled} onClick={() => setSql(TABLES_SQL)}>
                Saved tables
              </button>
            </div>
          </div>
          <textarea
            id="duckdb-sql"
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            disabled={disabled}
            maxLength={65536}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby="duckdb-query-help"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                request({ type: 'query', sql });
              }
            }}
          />
          <p id="duckdb-query-help">
            Ctrl or ⌘ + Enter to run. Queries stop after 15 seconds. Results show the last statement.
          </p>
        </section>
        <section className="duckdb-results" aria-labelledby="duckdb-results-heading">
          <h3 id="duckdb-results-heading">Results</h3>
          {result ? (
            <>
              <p>
                {result.totalRows.toLocaleString()} result rows · {result.elapsedMs.toFixed(1)} ms for SQL + formatting
              </p>
              <div className="duckdb-table-scroll" tabIndex={0} aria-label="SQL result table">
                <table>
                  <caption className="sr-only">SQL results</caption>
                  <thead>
                    <tr>
                      {result.columns.map((name, i) => (
                        <th key={i} scope="col">
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{cell === null ? <span className="duckdb-null">NULL</span> : cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!result.totalRows && <p>The statement returned no rows.</p>}
              {result.truncated && (
                <p>
                  Preview limited to 200 rows, 32 columns, and 500 characters per cell. Narrow your query to see more
                  detail.
                </p>
              )}
            </>
          ) : (
            <p>Prepare the dataset, then run the single-column sum or group revenue by region.</p>
          )}
        </section>
      </div>
      <footer>
        <p>
          <strong>Saved in this browser.</strong> Committed tables survive reloads. Finish explicit transactions before
          using Save &amp; reopen.
        </p>
        <p>
          Dedicated demo volume · disk buffer · strict durability · compatible DuckDB-Wasm build. The demo limits
          logical file data to 64 MiB.
        </p>
      </footer>
    </section>
  );
}

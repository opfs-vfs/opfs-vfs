/// <reference lib="webworker" />
import { PREPARE_SQL } from '../lib/duckdb-demo';
import { isVfsError, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { createDuckDBRuntime } from '@opfs-vfs/opfs-vfs/duckdb';
import type { DuckDBBindings, DuckDBConnection } from '@duckdb/duckdb-wasm/blocking';

export type DuckDBRequest = { type: 'init' | 'reopen' | 'prepare' } | { type: 'query'; sql: string };
export type QueryResult = {
  columns: string[];
  rows: (string | null)[][];
  totalRows: number;
  truncated: boolean;
  elapsedMs: number;
};
export type DuckDBResponse =
  | { type: 'status'; message: string }
  | { type: 'ready'; message: string; result?: QueryResult; preparation?: { rows: string; elapsedMs: number } }
  | { type: 'error'; message: string; fatal: boolean };

const ROOT = '/vendor/duckdb/1.33.1-dev64.0-opfs-vfs.1';
let vfs: OpfsVfs | undefined;
let db: DuckDBBindings | undefined;
let connection: DuckDBConnection | undefined;
let busy = false;
let fatal = false;
let closing = false;
const send = (message: DuckDBResponse) => self.postMessage(message);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  fatal = true;
  send({
    type: 'error',
    message: `The DuckDB runtime stopped: ${describe(event.reason)}. Reload to reopen the database.`,
    fatal,
  });
});

async function open() {
  send({ type: 'status', message: 'Opening the demo volume…' });
  vfs = new OpfsVfs('opfs-vfs-website-duckdb.bin', {
    bufferMode: 'disk',
    localDurabilityMode: 'strict',
    noatime: true,
    maxFiles: 256,
    maxFileSize: 32 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
  });
  await vfs.ready;
  send({ type: 'status', message: 'Loading DuckDB. The first visit downloads about 24 MB…' });
  const sdkUrl = new URL(`${ROOT}/duckdb.js`, self.location.origin).href;
  const sdk: typeof import('../../public/vendor/duckdb/1.33.1-dev64.0-opfs-vfs.1/duckdb') = await import(
    /* @vite-ignore */ sdkUrl
  );
  db = new sdk.DuckDB(
    new sdk.VoidLogger(),
    createDuckDBRuntime(vfs),
    new URL(`${ROOT}/duckdb.wasm`, self.location.origin).href,
  );
  await db.instantiate(() => {});
  db.open({ path: '/analytics.db', accessMode: sdk.DuckDBAccessMode.READ_WRITE, useDirectIO: true });
  connection = db.connect();
  connection.query("SET memory_limit = '64MB'; SET threads = 1;");
}

function query(sql: string): QueryResult {
  if (!sql.trim() || sql.length > 64 * 1024) throw new Error('Enter SQL up to 64 KiB.');
  const start = performance.now();
  const table = connection!.query(sql);
  const columns = table.schema.fields.slice(0, 32).map((field) => field.name);
  let truncated = table.numRows > 200 || table.numCols > 32;
  const rows: (string | null)[][] = [];
  for (let row = 0; row < Math.min(table.numRows, 200); row++) {
    rows.push(
      columns.map((_, col) => {
        const value: unknown = table.getChildAt(col)?.get(row);
        if (value === null || value === undefined) return null;
        let text: string;
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'bigint' ||
          typeof value === 'boolean'
        ) {
          text = String(value);
        } else if (typeof value === 'object' && value.toString !== Object.prototype.toString) {
          text = (value as { toString(): string }).toString();
        } else {
          text = JSON.stringify(value, (_, item: unknown) => (typeof item === 'bigint' ? String(item) : item)) ?? '';
        }
        // Arrow decimals expose their unscaled integer, including DuckDB HUGEINT sums.
        const type = table.schema.fields[col]!.type;
        if ('scale' in type && typeof type.scale === 'number' && type.scale > 0 && /^-?\d+$/.test(text)) {
          const negative = text.startsWith('-');
          const digits = text.replace(/^-/, '').padStart(type.scale + 1, '0');
          text = `${negative ? '-' : ''}${digits.slice(0, -type.scale)}.${digits.slice(-type.scale)}`;
        }
        if (text.length > 500) truncated = true;
        return text.length > 500 ? `${text.slice(0, 500)}…` : text;
      }),
    );
  }
  return { columns, rows, totalRows: table.numRows, truncated, elapsedMs: performance.now() - start };
}

self.onmessage = async ({ data }: MessageEvent<DuckDBRequest>) => {
  if (busy || fatal) return;
  busy = true;
  try {
    if (data.type === 'init') {
      if (vfs) throw new Error('The demo has already started.');
      await open();
      send({ type: 'ready', message: 'Ready. Prepare the example data, or query your saved tables.' });
    } else if (!connection) {
      throw new Error('The database is not ready.');
    } else if (data.type === 'prepare') {
      const start = performance.now();
      connection.query(PREPARE_SQL);
      connection.query('CHECKPOINT');
      const count = query('SELECT count(*) AS rows FROM opfs_demo_sales_v1;');
      if (vfs?.getLocalPersistenceStatusSync().localPersistenceState === 'error')
        throw new Error('Storage synchronization failed.');
      send({
        type: 'ready',
        message: 'Example data ready. Run a column aggregation below.',
        preparation: { rows: count.rows[0]![0]!, elapsedMs: performance.now() - start },
      });
    } else if (data.type === 'query') {
      const result = query(data.sql);
      if (vfs?.getLocalPersistenceStatusSync().localPersistenceState === 'error')
        throw new Error('Storage synchronization failed.');
      send({ type: 'ready', message: 'Query finished.', result });
    } else {
      // A failed checkpoint, including an open transaction, must leave the connection available.
      connection.query('CHECKPOINT');
      closing = true;
      connection.close();
      connection = undefined;
      db!.reset();
      await vfs!.closeVfs();
      vfs = undefined;
      await open();
      closing = false;
      send({ type: 'ready', message: 'Database saved and reopened. Run a query to read your saved tables.' });
    }
  } catch (error) {
    fatal =
      data.type === 'init' ||
      closing ||
      error instanceof WebAssembly.RuntimeError ||
      vfs?.getLocalPersistenceStatusSync().localPersistenceState === 'error';
    let message = describe(error);
    if (
      (isVfsError(error) && error.code === 'EBUSY') ||
      (error instanceof DOMException && ['NoModificationAllowedError', 'InvalidStateError'].includes(error.name))
    ) {
      message = 'This demo database is open in another tab. Close that tab, then reload.';
    } else if (fatal) {
      message += ' Reload to reopen and inspect the database before retrying writes.';
    } else {
      message +=
        data.type === 'query' || data.type === 'prepare'
          ? ' Earlier statements may already have committed.'
          : ' The database was not reopened. Finish any open transaction and try again.';
    }
    send({ type: 'error', message, fatal });
  } finally {
    busy = false;
  }
};

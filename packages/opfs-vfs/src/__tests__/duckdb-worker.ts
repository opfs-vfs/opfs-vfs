// fallow-ignore-next-line unresolved-import -- supplied by the external engine build
import { DuckDB, VoidLogger, DuckDBAccessMode } from '../../.duckdb/duckdb.js';
// @ts-expect-error Vite asset URL import
// fallow-ignore-next-line unresolved-import -- supplied by the external engine build
import wasm from '../../.duckdb/duckdb.wasm?url';
import { OpfsVfs, OpenFlags } from '../opfs-vfs';
import { createDuckDBRuntime } from '../duckdb-adapter';

self.onmessage = async ({ data }: MessageEvent<{ name: string; phase: string }>) => {
  const vfs = new OpfsVfs(data.name, { bufferMode: 'disk', localDurabilityMode: 'strict' });
  const calls = { opens: 0, reads: 0, writes: 0, syncs: 0, removes: 0, moves: 0 };
  let injected = false;
  let armed = data.phase === 'failure-rename' || data.phase === 'failure-open';
  const fault = (operation: string) => {
    if (armed && !injected && data.phase === `failure-${operation}`) {
      injected = true;
      throw new Error(`Injected ${operation} failure`);
    }
  };
  const sync = vfs.fsyncSync.bind(vfs);
  vfs.fsyncSync = (fd) => {
    calls.syncs++;
    fault('sync');
    sync(fd);
  };
  const write = vfs.writeSync.bind(vfs);
  vfs.writeSync = (...args) => {
    calls.writes++;
    fault('write');
    return write(...args);
  };
  const unlink = vfs.unlinkSync.bind(vfs);
  vfs.unlinkSync = (path) => {
    calls.removes++;
    fault('unlink');
    unlink(path);
  };
  const rename = vfs.renameSync.bind(vfs);
  vfs.renameSync = (...args) => {
    calls.moves++;
    fault('rename');
    rename(...args);
  };
  const read = vfs.readInto.bind(vfs);
  vfs.readInto = (...args) => {
    calls.reads++;
    return read(...args);
  };
  const open = vfs.openSync.bind(vfs);
  vfs.openSync = (...args) => {
    calls.opens++;
    fault('open');
    return open(...args);
  };
  try {
    await vfs.ready;
    const runtime = createDuckDBRuntime(vfs);
    let db = new DuckDB(new VoidLogger(), runtime, wasm);
    if (data.phase === 'stock') {
      // @ts-expect-error Upstream ships this test reference without a browser export/declaration.
      const stock = await import('../../node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs');
      // @ts-expect-error Vite asset URL import
      const { default: stockWasm } = await import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url');
      db = await stock.createDuckDB(
        { mvp: { mainModule: stockWasm, mainWorker: '' }, eh: { mainModule: stockWasm, mainWorker: '' } },
        new VoidLogger(),
        runtime,
      );
    }
    await db.instantiate(() => {});
    db.open({
      path: '/analytics.db',
      accessMode: data.phase === 'readonly' ? DuckDBAccessMode.READ_ONLY : DuckDBAccessMode.READ_WRITE,
      useDirectIO: data.phase !== 'incompatible',
    });
    const connection = db.connect();
    if (data.phase === 'create') {
      connection.query(
        'CREATE TABLE sales AS SELECT i::INTEGER AS id, (i % 3)::INTEGER AS category, (i * 2)::INTEGER AS amount FROM range(1000) t(i)',
      );
      connection.query('BEGIN; UPDATE sales SET amount = 9999 WHERE id = 0; ROLLBACK;');
    } else if (data.phase === 'reopen' || data.phase === 'checkpoint') {
      connection.query('INSERT INTO sales VALUES (1000, 1, 2000)');
    }
    let exported: number[] | undefined;
    if (data.phase === 'paths') {
      connection.query("COPY (SELECT 42 AS value) TO '/report.csv' (FORMAT CSV, HEADER true)");
      connection.query("COPY (SELECT 84 AS value) TO '/report.csv.tmp' (FORMAT CSV, HEADER true)");
      exported = ['/report.csv', '/report.csv.tmp'].map(
        (path) =>
          connection.query(`SELECT value::INTEGER AS value FROM read_csv('${path}')`).toArray()[0].toJSON().value,
      );
    }
    let failure: string | undefined;
    if (data.phase.startsWith('failure-') || data.phase === 'readonly') {
      armed = true;
      try {
        connection.query(
          data.phase === 'failure-unlink' || data.phase === 'failure-rename'
            ? 'CHECKPOINT'
            : 'INSERT INTO sales VALUES (2000, 1, 4000)',
        );
      } catch (error) {
        failure = String(error);
      }
    }
    if (data.phase === 'checkpoint') connection.query('CHECKPOINT');
    // Never manually sync or unlink: successful SQL must cross the engine's barriers.
    const rows = data.phase.startsWith('failure-')
      ? []
      : connection
          .query(
            'SELECT category, count(*)::INTEGER AS count, sum(amount)::INTEGER AS total FROM sales GROUP BY category ORDER BY category',
          )
          .toArray()
          .map((row) => row.toJSON());
    const committed = data.phase.startsWith('failure-')
      ? undefined
      : connection.query('SELECT count(*)::INTEGER AS count FROM sales WHERE id < 1000').toArray()[0].toJSON().count;
    if (data.phase === 'checkpoint-interrupted') {
      connection.query("SET debug_checkpoint_abort = 'BEFORE_HEADER'");
      try {
        connection.query('CHECKPOINT');
      } catch (error) {
        failure = String(error);
      }
      // Crash fixture: a concurrent writer opened the checkpoint WAL but died
      // before writing its first entry. The single-thread build cannot race SQL.
      vfs.closeSync(vfs.openSync('/analytics.db.wal.checkpoint', OpenFlags.O_CREAT | OpenFlags.O_WRONLY));
      vfs.syncSync();
    }
    self.postMessage({
      rows,
      committed,
      exported,
      failure,
      injected,
      files: vfs.listPathsSync().map((path) => ({ path, size: vfs.statSync(path).size })),
      calls,
      version: db.getVersion(),
    });
    // The parent kills this worker while the database and VFS are still open.
  } catch (error) {
    self.postMessage(
      injected
        ? { failure: String(error), injected, calls }
        : { error: error instanceof Error ? error.stack : String(error) },
    );
  }
};

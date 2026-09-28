import { OpfsVfs } from '../../packages/opfs-vfs/dist/index.js';
import { createDuckDBRuntime } from '../../packages/opfs-vfs/dist/duckdb.js';
// fallow-ignore-next-line unresolved-import -- supplied by the external engine build
import { DuckDB, VoidLogger, DuckDBAccessMode } from '../../packages/opfs-vfs/.duckdb/duckdb.js';
// fallow-ignore-next-line unresolved-import -- supplied by the external engine build
import wasm from '../../packages/opfs-vfs/.duckdb/duckdb.wasm?url';

self.onmessage = async () => {
  const vfs = new OpfsVfs('duckdb-example.bin', { bufferMode: 'disk', localDurabilityMode: 'strict' });
  try {
    await vfs.ready;
    const db = new DuckDB(new VoidLogger(), createDuckDBRuntime(vfs), wasm);
    await db.instantiate(() => {});
    db.open({ path: '/visits.db', accessMode: DuckDBAccessMode.READ_WRITE, useDirectIO: true });
    const connection = db.connect();
    connection.query('CREATE TABLE IF NOT EXISTS visits (visited_at TIMESTAMP)');
    connection.query('INSERT INTO visits VALUES (current_timestamp)');
    const rows = connection
      .query('SELECT count(*)::INTEGER AS visits FROM visits')
      .toArray()
      .map((row) => row.toJSON());
    connection.query('CHECKPOINT');
    connection.close();
    db.reset();
    await vfs.closeVfs();
    self.postMessage(rows);
  } catch (error) {
    self.postMessage({ error: String(error) });
    await vfs.closeVfs();
  }
};

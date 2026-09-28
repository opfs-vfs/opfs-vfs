/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import { deleteBenchmarkIdb } from '../lib/benchmark-idb';
import { OpfsVfsPGliteAdapter } from '@opfs-vfs/opfs-vfs/pglite';
import { deleteVolume, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import {
  validateBenchmarkConfig,
  type BenchmarkBackend,
  type BenchmarkConfig,
  type BenchmarkSample,
  type BenchmarkWorkerEvent,
  type BenchmarkWorkerRequest,
} from '../lib/benchmark';
import { SPEED_TESTS, verifySpeedTestData, verifySpeedTestDrop, verifySpeedTestSelect } from '../lib/pglite-speedtest';

const scope = self as DedicatedWorkerGlobalScope;
let cancelled = false;
const post = (event: BenchmarkWorkerEvent) => scope.postMessage(event),
  message = (error: unknown) => (error instanceof Error ? error.message : String(error)),
  unavailable = (error: unknown) =>
    /not supported|unavailable|cross.origin|SharedArrayBuffer|createSyncAccessHandle/i.test(message(error));
scope.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  cancelled = true;
  post({ type: 'fatal', error: message(event.reason) });
});
async function removeOpfs(name: string) {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
}
async function runSample(
  backend: BenchmarkBackend,
  repetition: number,
  config: BenchmarkConfig,
  sql: string[],
  progress: (stage: string) => void,
): Promise<BenchmarkSample> {
  const suffix = `${Date.now()}-${crypto.randomUUID()}`,
    volume = `website-bench-${suffix}.bin`,
    store = `website-bench-${suffix}`;
  let pg: PGlite | null = null;
  const holder: { vfs: OpfsVfs | null } = { vfs: null };
  const result: BenchmarkSample = {
    backend,
    repetition,
    initMs: 0,
    workloadMs: 0,
    persistenceMs: null,
    reopenMs: null,
    expectedRows: config.workload === 'pglite-speedtest' ? 0 : config.rows!,
    actualRows: 0,
    status: 'failed',
  };
  const close = async () => {
    if (!pg) return;
    // PGlite 0.5.4 mounts IDBFS at /pglite/<name>, but closeFs looks up <name>.
    // Close this instance's cached connections after its final sync, including on reopen.
    const connections = backend === 'idb' ? Object.values<IDBDatabase>(pg.Module.FS.filesystems.IDBFS.dbs) : [];
    try {
      await pg.close();
    } finally {
      for (const connection of connections) connection.close();
      pg = null;
    }
  };
  const make = async () => {
    const options = { relaxedDurability: config.relaxedDurability };
    if (backend === 'memory') return PGlite.create(options);
    if (backend === 'idb') return PGlite.create({ ...options, dataDir: `idb://${store}` });
    if (backend === 'opfs-ahp') return PGlite.create({ ...options, dataDir: `opfs-ahp://${store}` });
    holder.vfs = new OpfsVfs(volume, { bufferMode: config.bufferMode, localDurabilityMode: config.durability });
    await holder.vfs.ready;
    return PGlite.create({
      ...options,
      fs: new OpfsVfsPGliteAdapter(holder.vfs, { relaxedDurability: config.relaxedDurability }),
    });
  };
  try {
    let start = performance.now();
    pg = await make();
    result.initMs = performance.now() - start;
    if (cancelled) throw new DOMException('Cancelled', 'AbortError');
    if (config.workload === 'pglite-speedtest') {
      result.stages = [];
      for (const [index, statement] of sql.entries()) {
        // PGlite can resolve in microtasks; let queued cancel messages run.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled) throw new DOMException('Cancelled', 'AbortError');
        progress(`${index + 1}/16 · ${SPEED_TESTS[index]}`);
        start = performance.now();
        const rows = await pg.exec(statement);
        const durationMs = performance.now() - start;
        result.stages.push({ id: index + 1, durationMs });
        result.workloadMs += durationMs;
        verifySpeedTestSelect(index + 1, rows);
        if (index === 14) await verifySpeedTestData(pg);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await verifySpeedTestDrop(pg);
    } else {
      start = performance.now();
      await pg.exec(
        config.workload === 'transactions'
          ? `CREATE TABLE bench(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);BEGIN;INSERT INTO bench SELECT n,'row-'||n FROM generate_series(1,${config.rows}) n;UPDATE bench SET payload=payload||'-checked' WHERE id%10=0;COMMIT;`
          : `CREATE TABLE bench(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);INSERT INTO bench SELECT n,'row-'||n FROM generate_series(1,${config.rows}) n;UPDATE bench SET payload=payload||'-checked' WHERE id%10=0;`,
      );
      const checked = await pg.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM bench WHERE payload LIKE $1',
        ['%-checked'],
      );
      if (Number(checked.rows[0]?.count) !== Math.floor(config.rows! / 10))
        throw new Error('Workload verification failed.');
      result.workloadMs = performance.now() - start;
    }
    if (cancelled) throw new DOMException('Cancelled', 'AbortError');
    if (backend !== 'memory' && !config.relaxedDurability) {
      start = performance.now();
      await pg.syncToFs();
      result.persistenceMs = performance.now() - start;
    }
    if (cancelled) throw new DOMException('Cancelled', 'AbortError');
    await close();
    if (holder.vfs) {
      await holder.vfs.closeVfs();
      holder.vfs = null;
    }
    if (backend !== 'memory') {
      start = performance.now();
      pg = await make();
      result.reopenMs = performance.now() - start;
      if (config.workload === 'pglite-speedtest') await verifySpeedTestDrop(pg);
      else {
        const count = await pg.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM bench');
        result.actualRows = Number(count.rows[0]?.count ?? 0);
      }
      if (cancelled) throw new DOMException('Cancelled', 'AbortError');
      if (result.actualRows !== result.expectedRows)
        throw new Error(`Reopen found ${result.actualRows} of ${result.expectedRows} rows.`);
    } else result.actualRows = result.expectedRows;
    result.status = 'ok';
    return result;
  } catch (error) {
    result.status =
      cancelled || (error instanceof DOMException && error.name === 'AbortError')
        ? 'cancelled'
        : unavailable(error)
          ? 'unavailable'
          : 'failed';
    result.error = message(error);
    return result;
  } finally {
    try {
      await close();
    } catch (error) {
      result.error = `${result.error ? `${result.error} ` : ''}Close failed: ${message(error)}`;
      if (result.status === 'ok') result.status = 'failed';
    }
    try {
      await holder.vfs?.closeVfs();
    } catch {}
    try {
      if (backend === 'opfs-vfs') await deleteVolume(volume);
      if (backend === 'idb') await deleteBenchmarkIdb(store);
      if (backend === 'opfs-ahp') await removeOpfs(store);
    } catch (error) {
      result.error = `${result.error ? `${result.error} ` : ''}Cleanup failed: ${message(error)}`;
      if (result.status === 'ok') result.status = 'failed';
    }
  }
}
scope.onmessage = async (event: MessageEvent<BenchmarkWorkerRequest>) => {
  if (event.data.type === 'cancel') {
    cancelled = true;
    return;
  }
  cancelled = false;
  try {
    validateBenchmarkConfig(event.data.config);
    const preparationStart = performance.now();
    const sql =
      event.data.config.workload === 'pglite-speedtest'
        ? await Promise.all(
            SPEED_TESTS.map(async (_, index) => {
              const response = await fetch(`/benchmarks/pglite/benchmark${index + 1}.sql`);
              if (!response.ok) throw new Error(`Could not load speed test ${index + 1}: ${response.status}`);
              return response.text();
            }),
          )
        : [];
    const warmup = await PGlite.create();
    await warmup.close();
    post({ type: 'prepared', preparationMs: performance.now() - preparationStart });
    if (cancelled) {
      post({ type: 'done', cancelled: true });
      return;
    }
    const total = event.data.config.backends.length * event.data.config.repetitions;
    let current = 0;
    for (const backend of event.data.config.backends)
      for (let repetition = 1; repetition <= event.data.config.repetitions; repetition++) {
        post({ type: 'progress', backend, current: ++current, total });
        post({
          type: 'sample',
          sample: await runSample(backend, repetition, event.data.config, sql, (stage) =>
            post({ type: 'progress', backend, current, total, stage }),
          ),
        });
        if (cancelled) {
          post({ type: 'done', cancelled: true });
          return;
        }
      }
    post({ type: 'done', cancelled: false });
  } catch (error) {
    post({ type: 'fatal', error: message(error) });
  }
};

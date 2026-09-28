import { PGliteWorker } from '@electric-sql/pglite/worker';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
export type DatabaseRecord = { name: string; createdAt: string };
const KEY = 'opfs-vfs:website:pglite-databases:v1',
  PATTERN = /^[a-z][a-z0-9-]{0,31}$/,
  LOCK = 'opfs-vfs:website:pglite-registry';
function databaseVolume(name: string) {
  if (!PATTERN.test(name)) throw new Error('Use 1–32 lowercase letters, numbers, or hyphens, starting with a letter.');
  return `website-pglite-${name}.bin`;
}
export function readDatabaseRegistry(): DatabaseRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]') as DatabaseRecord[];
    return Array.isArray(value) ? value.filter((x) => PATTERN.test(x.name) && typeof x.createdAt === 'string') : [];
  } catch {
    return [];
  }
}
function openWorker(name: string, id: string, loadDataDir?: Blob, createNew = false) {
  const volumeName = databaseVolume(name),
    webWorker = new Worker(new URL('../workers/pglite.worker.ts', import.meta.url), { type: 'module' });
  const pg = new PGliteWorker(webWorker, {
    id,
    meta: { volumeName, bufferMode: 'memory', durability: 'balanced', createNew },
    ...(loadDataDir ? { loadDataDir } : {}),
  });
  return waitForWorker(pg, webWorker);
}
export function openTemporaryDatabase() {
  const webWorker = new Worker(new URL('../workers/pglite.worker.ts', import.meta.url), { type: 'module' });
  const pg = new PGliteWorker(webWorker, {
    id: `opfs-vfs-website:memory:${crypto.randomUUID()}`,
    meta: { backend: 'memory' },
  });
  return waitForWorker(pg, webWorker);
}
async function waitForWorker(pg: PGliteWorker, webWorker: Worker) {
  let timer: ReturnType<typeof setTimeout>;
  let rejectFailure: (reason?: unknown) => void = () => undefined;
  const onError = (event: ErrorEvent) => {
    // This worker belongs to this client and its initialization failure is
    // surfaced through the rejected promise below.
    event.preventDefault();
    rejectFailure(event.error ?? new Error(event.message));
  };
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
    webWorker.addEventListener('error', onError);
    timer = setTimeout(() => reject(new Error('PGlite initialization timed out after 30 seconds.')), 30_000);
  });
  try {
    await Promise.race([pg.waitReady, failed]);
    return pg;
  } catch (error) {
    await pg.close().catch(() => undefined);
    webWorker.terminate();
    throw error;
  } finally {
    clearTimeout(timer!);
    webWorker.removeEventListener('error', onError);
  }
}
export function openDatabase(name: string) {
  const volume = databaseVolume(name);
  return openWorker(name, `opfs-vfs-website:${volume}`);
}
async function reserveDatabase(name: string, archive?: Blob) {
  try {
    const reservation = await openWorker(name, `opfs-vfs-website:reserve:${crypto.randomUUID()}`, archive, true);
    await reservation.close();
  } catch (error) {
    const details = error as { code?: unknown; name?: unknown; message?: unknown };
    const exists =
      details.code === 'EEXIST' ||
      details.name === 'EEXIST' ||
      /EEXIST|already exists/i.test(typeof details.message === 'string' ? details.message : String(error));
    if (!exists) await deleteVolume(databaseVolume(name)).catch(() => undefined);
    throw error;
  }
}

export async function validateDataArchive(file: File) {
  if (file.size > 256 * 1024 * 1024) throw new Error('Archive exceeds the 256 MB compressed-size limit.');
  if (!/\.(tar|tgz|tar\.gz)$/i.test(file.name)) throw new Error('Choose a PGlite .tar or .tgz data archive.');
  if (!/\.(tgz|tar\.gz)$/i.test(file.name)) return;
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let expanded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      expanded += value.byteLength;
      if (expanded > 512 * 1024 * 1024) throw new Error('Archive exceeds the 512 MB expanded-size limit.');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function createDatabase(name: string, archive?: Blob, recoverExisting = false) {
  return navigator.locks.request(LOCK, async () => {
    if (readDatabaseRegistry().some((x) => x.name === name)) throw new Error(`Database “${name}” already exists.`);
    let reserved = false;
    try {
      await reserveDatabase(name, archive);
      reserved = true;
    } catch (error) {
      const details = error as { code?: unknown; name?: unknown; message?: unknown };
      const exists =
        details.code === 'EEXIST' ||
        details.name === 'EEXIST' ||
        /EEXIST|already exists/i.test(typeof details.message === 'string' ? details.message : String(error));
      if (!recoverExisting || archive || !exists) throw error;
    }
    let pg: PGliteWorker | null = null;
    try {
      const records = [...readDatabaseRegistry(), { name, createdAt: new Date().toISOString() }];
      pg = await openDatabase(name);
      localStorage.setItem(KEY, JSON.stringify(records));
      return { pg, records };
    } catch (error) {
      await pg?.close().catch(() => undefined);
      if (reserved) await deleteVolume(databaseVolume(name)).catch(() => undefined);
      throw error;
    }
  });
}
export async function recreateDatabase(name: string) {
  return navigator.locks.request(LOCK, async () => {
    if (!readDatabaseRegistry().some((x) => x.name === name)) throw new Error(`Database “${name}” is not registered.`);
    await deleteVolume(databaseVolume(name));
    await reserveDatabase(name);
    return openDatabase(name);
  });
}
export async function resetDatabaseSchema(pg: PGliteWorker) {
  await pg.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pg.syncToFs();
}

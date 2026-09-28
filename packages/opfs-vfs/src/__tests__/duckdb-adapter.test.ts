import { expect, it } from 'vitest';
import { deleteVolume } from '../volume-files';

type Observation = {
  rows: { category: number; count: number; total: number }[];
  committed: number;
  exported?: number[];
  failure?: string;
  injected: boolean;
  files: { path: string; size: number }[];
  calls: { opens: number; reads: number; writes: number; syncs: number; removes: number; moves: number };
  version: string;
};

function run(name: string, phase: string): Promise<Observation> {
  const worker = new Worker(new URL('./duckdb-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Observation>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        worker.terminate();
        reject(new Error('DuckDB worker timed out'));
      },
      phase === 'stock' ? 10000 : 60000,
    );
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timeout);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ name, phase });
  }).finally(async () => {
    worker.terminate();
    // Native worker termination releases Web Locks asynchronously.
    await navigator.locks.request(`opfs-vfs-volume-${name}`, { signal: AbortSignal.timeout(10000) }, () => {});
  });
}

it('persists SQL commits across terminated workers and repeated WAL checkpoints', async () => {
  const name = `duckdb-${crypto.randomUUID()}.bin`;
  try {
    const phases = ['create', 'reopen', 'checkpoint', 'inspect', 'reopen', 'checkpoint', 'inspect'];
    const addedRows = [0, 1, 2, 2, 3, 4, 4];
    for (const [index, phase] of phases.entries()) {
      const result = await run(name, phase);
      expect(result.rows, JSON.stringify({ phase, index, result })).toEqual([
        { category: 0, count: 334, total: 333666 },
        { category: 1, count: 333 + addedRows[index], total: 332334 + addedRows[index] * 2000 },
        { category: 2, count: 333, total: 333000 },
      ]);
      expect(result.committed).toBe(1000);
      expect(result.files.find((file) => file.path === '/analytics.db')!.size).toBeGreaterThan(0);
      expect(result.calls.opens).toBeGreaterThan(0);
      if (index > 0) expect(result.calls.reads).toBeGreaterThan(0);
      if (phase !== 'inspect') {
        expect(result.calls.writes).toBeGreaterThan(0);
        expect(result.calls.syncs).toBeGreaterThan(0);
      }
      if (phase === 'checkpoint') {
        expect(result.calls.removes).toBeGreaterThan(0);
        expect(result.files.some((file) => file.path === '/analytics.db.wal')).toBe(false);
      }
    }
    const readonly = await run(name, 'readonly');
    expect(readonly.failure).toMatch(/read.only/i);
    expect(readonly.calls.writes).toBe(0);
  } finally {
    await deleteVolume(name);
  }
}, 180000);

for (const operation of ['open', 'write', 'sync', 'unlink']) {
  it(`reports ${operation} failure and recovers earlier committed data`, async () => {
    const name = `duckdb-failure-${crypto.randomUUID()}.bin`;
    try {
      await run(name, 'create');
      const failed = await run(name, `failure-${operation}`);
      expect(failed.injected).toBe(true);
      expect(failed.failure).toContain(`Injected ${operation} failure`);
      // A failed COMMIT can have an uncertain outcome. Earlier commits must survive.
      const recovered = await run(name, 'inspect');
      expect(recovered.committed).toBe(1000);
      const written = await run(name, 'checkpoint');
      expect(written.committed).toBe(1000);
      expect((await run(name, 'inspect')).rows).toEqual(written.rows);
    } finally {
      await deleteVolume(name);
    }
  }, 120000);
}

it('rejects buffering before creating a database', async () => {
  const name = `duckdb-incompatible-${crypto.randomUUID()}.bin`;
  try {
    await expect(run(name, 'incompatible')).rejects.toThrow('patched OPFS VFS build and useDirectIO: true');
  } finally {
    await deleteVolume(name);
  }
}, 60000);

for (const failRename of [false, true]) {
  it(`recovers checkpoint and recovery WAL files; rename failure=${failRename}`, async () => {
    const name = `duckdb-recovery-${crypto.randomUUID()}.bin`;
    try {
      await run(name, 'create');
      const interrupted = await run(name, 'checkpoint-interrupted');
      expect(interrupted.failure).toContain('Checkpoint aborted');
      expect(interrupted.files.some((file) => file.path === '/analytics.db.wal.checkpoint')).toBe(true);
      expect(interrupted.calls.syncs).toBeGreaterThan(0);
      if (failRename) {
        const failed = await run(name, 'failure-rename');
        expect(failed.injected).toBe(true);
        expect(failed.failure).toContain('Injected rename failure');
      }
      const recovered = await run(name, 'inspect');
      expect(recovered.rows).toEqual(interrupted.rows);
      expect(recovered.calls.moves).toBeGreaterThan(0);
      expect(recovered.calls.syncs).toBeGreaterThan(0);
      expect(recovered.files.some((file) => /\.(checkpoint|recovery)$/.test(file.path))).toBe(false);
      const written = await run(name, 'checkpoint');
      expect((await run(name, 'inspect')).rows).toEqual(written.rows);
    } finally {
      await deleteVolume(name);
    }
  }, 120000);
}

it('keeps literal temporary filenames distinct during SQL file output', async () => {
  const name = `duckdb-paths-${crypto.randomUUID()}.bin`;
  try {
    await run(name, 'create');
    const result = await run(name, 'paths');
    expect(result.exported).toEqual([42, 84]);
    expect(result.files.map((file) => file.path)).toContain('/report.csv.tmp');
  } finally {
    await deleteVolume(name);
  }
}, 60000);

it('rejects stock engine assets before opening any files', async () => {
  const name = `duckdb-stock-${crypto.randomUUID()}.bin`;
  try {
    await expect(run(name, 'stock')).rejects.toThrow('requires patched OPFS VFS build');
  } finally {
    await deleteVolume(name);
  }
}, 15000);

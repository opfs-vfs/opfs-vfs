import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  SPEED_TESTS,
  verifySpeedTestData,
  verifySpeedTestDrop,
  verifySpeedTestSelect,
} from '../src/lib/pglite-speedtest.ts';

void test(
  'pinned upstream SQL passes data checks and detects corrupt or missing results',
  { timeout: 90_000 },
  async () => {
    const folder = new URL('../public/benchmarks/pglite/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest-16.json', folder), 'utf8'));
    const pg = await PGlite.create();
    try {
      for (let i = 1; i <= SPEED_TESTS.length; i++) {
        const file = `benchmark${i}.sql`;
        const sql = await readFile(new URL(file, folder), 'utf8');
        const expectedHash = manifest.files[file];
        assert.equal(createHash('sha256').update(sql).digest('hex'), expectedHash, file);
        const result = await pg.exec(sql);
        verifySpeedTestSelect(i, result);
        if ([4, 5, 7].includes(i)) assert.throws(() => verifySpeedTestSelect(i, []), /SELECT verification/);
        if (i === 1) await assert.rejects(() => verifySpeedTestDrop(pg), /not dropped/);
        if (i === 15) {
          await verifySpeedTestData(pg);
          await pg.exec('UPDATE t1 SET b=b+1 WHERE a=1');
          await assert.rejects(() => verifySpeedTestData(pg), /verification failed/);
        }
      }
      await verifySpeedTestDrop(pg);
    } finally {
      await pg.close();
    }
  },
);

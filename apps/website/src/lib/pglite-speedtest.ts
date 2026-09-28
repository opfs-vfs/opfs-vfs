import type { PGlite } from '@electric-sql/pglite';

export const SPEED_TEST_SOURCE =
  'https://github.com/electric-sql/pglite/tree/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/benchmark/src';
export const SPEED_TEST_REVISION = 'pglite-speedtest16-ae182ff8-v1';
export const SPEED_TESTS = [
  '1,000 INSERTs',
  '25,000 INSERTs in a transaction',
  '25,000 INSERTs into an indexed table',
  '100 SELECTs without an index',
  '100 SELECTs with string comparisons',
  'Create indexes',
  '5,000 SELECTs with an index',
  '1,000 UPDATEs without an index',
  '25,000 UPDATEs with an index',
  '25,000 text UPDATEs with an index',
  'INSERT from SELECT',
  'DELETE without an index',
  'DELETE with an index',
  'Large INSERT after DELETE',
  'DELETE followed by 12,000 INSERTs',
  'DROP tables',
] as const;

// Derived independently from the pinned SQL with SQLite, then checked with PGlite.
const FINGERPRINTS = [
  { name: 't1', count: 12000, a: '72006000', b: '602435213', text: '481456' },
  { name: 't2', count: 34898, a: '1510179060', b: '814111793', text: '1398835' },
  { name: 't3', count: 25000, a: '312512500', b: '1253151317', text: '1002773' },
] as const;

export async function verifySpeedTestData(pg: PGlite) {
  for (const expected of FINGERPRINTS) {
    const { rows } = await pg.query<{ count: number; a: string; b: string; text: string }>(
      `SELECT count(*)::int AS count, sum(a)::text AS a, sum(b)::text AS b,
       sum(length(c))::text AS text FROM ${expected.name}`,
    );
    const row = rows[0];
    if (
      !row ||
      row.count !== expected.count ||
      row.a !== expected.a ||
      row.b !== expected.b ||
      row.text !== expected.text
    )
      throw new Error(`Speed-test data verification failed for ${expected.name}.`);
  }
}

export async function verifySpeedTestDrop(pg: PGlite) {
  const { rows } = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('t1','t2','t3')",
  );
  if (rows[0]?.count !== 0) throw new Error('Speed-test tables were not dropped.');
}

// Counts are independently calculated from the fixed inputs; query results are
// checked after timing so failed/empty SELECTs cannot masquerade as fast samples.
export function verifySpeedTestSelect(id: number, results: { rows: Record<string, unknown>[] }[]) {
  const expected = (
    { 4: [100, 24673, 266, 261], 5: [100, 154490, 6219, 2467], 7: [5000, 25000, 28, 0] } as Record<number, number[]>
  )[id];
  if (!expected) return;
  const rows = results.flatMap((result) => result.rows);
  const counts = rows.map((row) => Number(row.count));
  if (
    counts.length !== expected[0] ||
    counts.reduce((sum, count) => sum + count, 0) !== expected[1] ||
    counts[0] !== expected[2] ||
    counts.at(-1) !== expected[3]
  )
    throw new Error(`Speed-test SELECT verification failed for case ${id}.`);
}

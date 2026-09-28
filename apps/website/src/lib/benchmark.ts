export type BenchmarkBackend = 'opfs-vfs' | 'opfs-ahp' | 'idb' | 'memory';
export type BenchmarkConfig = {
  backends: BenchmarkBackend[];
  rows: number | null;
  repetitions: number;
  bufferMode: 'memory' | 'disk';
  durability: 'relaxed' | 'balanced' | 'strict';
  workload: 'insert-query' | 'transactions' | 'pglite-speedtest';
  relaxedDurability: boolean;
};
export type BenchmarkSample = {
  backend: BenchmarkBackend;
  repetition: number;
  initMs: number;
  workloadMs: number;
  persistenceMs: number | null;
  reopenMs: number | null;
  expectedRows: number;
  actualRows: number;
  status: 'ok' | 'failed' | 'unavailable' | 'cancelled';
  error?: string;
  stages?: { id: number; durationMs: number }[];
};
export type BenchmarkReport = {
  schemaVersion: 2;
  createdAt: string;
  userAgent: string;
  crossOriginIsolated: boolean;
  config: BenchmarkConfig;
  samples: BenchmarkSample[];
  metadata: {
    workloadRevision: string;
    workloadSource: string | null;
    sourceCommit: string;
    opfsVfsVersion: string;
    pgliteVersion: string;
    interrupted: boolean;
    environmentNote: string;
    preparationMs: number | null;
  };
};
export type BenchmarkWorkerRequest = { type: 'run'; config: BenchmarkConfig } | { type: 'cancel' };
export type BenchmarkWorkerEvent =
  | { type: 'progress'; backend: BenchmarkBackend; current: number; total: number; stage?: string }
  | { type: 'sample'; sample: BenchmarkSample }
  | { type: 'prepared'; preparationMs: number }
  | { type: 'done'; cancelled: boolean }
  | { type: 'fatal'; error: string };
export const ROW_OPTIONS = [100, 1_000, 10_000] as const;
export const REPETITION_OPTIONS = [1, 3, 5] as const;
export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
// Competition ranks: tied times share a place (1, 1, 3); a lone backend is not ranked.
export function timingRank(value: number | null, values: (number | null)[]) {
  const measured = values.filter((item): item is number => item !== null && Number.isFinite(item) && item >= 0);
  if (value === null || measured.length < 2 || !measured.includes(value)) return null;
  const rank = 1 + measured.filter((item) => item < value).length;
  return rank <= 3 ? rank : null;
}
export function reportCsv(report: BenchmarkReport) {
  const columns: Exclude<keyof BenchmarkSample, 'stages'>[] = [
    'backend',
    'repetition',
    'status',
    'initMs',
    'workloadMs',
    'persistenceMs',
    'reopenMs',
    'expectedRows',
    'actualRows',
    'error',
  ];
  const quote = (value: string | number | boolean | null | undefined) =>
    `"${String(value ?? '').replaceAll('"', '""')}"`;
  const metadata = [
    'createdAt',
    'userAgent',
    'crossOriginIsolated',
    'workload',
    'rows',
    'repetitions',
    'bufferMode',
    'durability',
    'relaxedDurability',
    'workloadRevision',
    'workloadSource',
    'sourceCommit',
    'opfsVfsVersion',
    'pgliteVersion',
    'interrupted',
    'environmentNote',
    'preparationMs',
  ];
  const heading = [...metadata, ...columns, ...Array.from({ length: 16 }, (_, i) => `speedTest${i + 1}Ms`)].join(',');
  return [
    heading,
    ...report.samples.map((row) =>
      [
        report.createdAt,
        report.userAgent,
        report.crossOriginIsolated,
        report.config.workload,
        report.config.rows,
        report.config.repetitions,
        report.config.bufferMode,
        report.config.durability,
        report.config.relaxedDurability,
        report.metadata.workloadRevision,
        report.metadata.workloadSource,
        report.metadata.sourceCommit,
        report.metadata.opfsVfsVersion,
        report.metadata.pgliteVersion,
        report.metadata.interrupted,
        report.metadata.environmentNote,
        report.metadata.preparationMs,
        ...columns.map((key) => row[key]),
        ...Array.from({ length: 16 }, (_, i) => row.stages?.find((stage) => stage.id === i + 1)?.durationMs),
      ]
        .map(quote)
        .join(','),
    ),
  ].join('\n');
}
export function validateBenchmarkConfig(config: BenchmarkConfig) {
  if (
    !Array.isArray(config.backends) ||
    !config.backends.length ||
    config.backends.some((backend) => !['opfs-vfs', 'opfs-ahp', 'idb', 'memory'].includes(backend))
  )
    throw new Error('Choose valid backends.');
  if (!['insert-query', 'transactions', 'pglite-speedtest'].includes(config.workload))
    throw new Error('Unsupported workload.');
  if (config.workload === 'pglite-speedtest' ? config.rows !== null : !ROW_OPTIONS.includes(config.rows as never))
    throw new Error('Unsupported row count.');
  if (
    !['disk', 'memory'].includes(config.bufferMode) ||
    !['relaxed', 'balanced', 'strict'].includes(config.durability) ||
    typeof config.relaxedDurability !== 'boolean'
  )
    throw new Error('Unsupported storage settings.');
  if (!REPETITION_OPTIONS.includes(config.repetitions as never)) throw new Error('Unsupported repetition count.');
}

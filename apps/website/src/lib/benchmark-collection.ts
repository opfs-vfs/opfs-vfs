import type { BenchmarkBackend, BenchmarkConfig, BenchmarkSample } from './benchmark';
import type { FilesystemConfig, FilesystemSample } from './filesystem-benchmark';

export type CollectionBrowser = 'chrome' | 'safari' | 'firefox';
export type CollectionJob = { id: string } & (
  | { suite: 'sql'; config: BenchmarkConfig }
  | { suite: 'filesystem'; config: FilesystemConfig }
);
export type CollectionEntry = {
  jobId: string;
  round: number;
  warmup: boolean;
  startedAt: string;
  finishedAt?: string;
  preparationMs?: number;
  samples: (BenchmarkSample | FilesystemSample)[];
  error?: string;
};
export function collectionJobs(browser: CollectionBrowser, omitAhp = browser === 'safari'): CollectionJob[] {
  const jobs: CollectionJob[] = [];
  const backends: BenchmarkBackend[] = ['opfs-vfs', 'opfs-ahp', 'idb', 'memory'];
  for (const workload of ['pglite-speedtest', 'transactions'] as const)
    for (const backend of backends) {
      if (omitAhp && backend === 'opfs-ahp') continue;
      for (const bufferMode of backend === 'opfs-vfs' ? (['disk', 'memory'] as const) : (['disk'] as const))
        jobs.push({
          id: `${workload}-${backend}${backend === 'opfs-vfs' ? `-${bufferMode}` : ''}`,
          suite: 'sql',
          config: {
            backends: [backend],
            workload,
            rows: workload === 'transactions' ? 10_000 : null,
            repetitions: 1,
            bufferMode,
            durability: 'balanced',
            relaxedDurability: false,
          },
        });
    }
  for (const bufferMode of ['disk', 'memory'] as const)
    jobs.push({
      id: `filesystem-${bufferMode}`,
      suite: 'filesystem',
      config: {
        files: 1000,
        repetitions: 1,
        bufferMode,
        durability: 'balanced',
      },
    });
  return jobs;
}
export function collectionSchedule(jobs: CollectionJob[]) {
  return Array.from({ length: 6 }, (_, round) =>
    jobs.map((_, index) => ({ job: jobs[(index + round) % jobs.length]!, round, warmup: round === 0 })),
  ).flat();
}
export function collectionEligible(jobs: CollectionJob[], entries: CollectionEntry[], interrupted: boolean) {
  const schedule = collectionSchedule(jobs);
  return (
    !interrupted &&
    entries.length === schedule.length &&
    schedule.every(({ job, round, warmup }, index) => {
      const entry = entries[index]!;
      return (
        entry.jobId === job.id &&
        entry.round === round &&
        entry.warmup === warmup &&
        !!entry.finishedAt &&
        !entry.error &&
        entry.samples.length === 1 &&
        entry.samples[0]!.status === 'ok'
      );
    })
  );
}
export function collectionBrowser(userAgent: string): CollectionBrowser | null {
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/Chrome\//.test(userAgent) && !/Edg\/|OPR\//.test(userAgent)) return 'chrome';
  if (/Version\/.*Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return 'safari';
  return null;
}

export function collectionEnvironment(userAgent: string, platform: string, maxTouchPoints: number) {
  const mobileApple = /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const browser = /CriOS\//.test(userAgent)
    ? 'chrome'
    : /FxiOS\//.test(userAgent)
      ? 'firefox'
      : collectionBrowser(userAgent);
  const version =
    browser === 'chrome'
      ? /(?:Chrome|CriOS)\/([\d.]+)/
      : browser === 'firefox'
        ? /(?:Firefox|FxiOS)\/([\d.]+)/
        : /Version\/([\d.]+)/;
  const os = mobileApple
    ? /iPad/.test(userAgent) || platform === 'MacIntel'
      ? 'iPadOS'
      : 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return { browser, browserVersion: userAgent.match(version)?.[1] ?? '', os, mobileApple };
}
export function collectionOmitsAhp(browser: CollectionBrowser | null, os: string, mobileApple: boolean) {
  return browser === 'safari' || mobileApple || /^(ios|ipados)$/i.test(os.trim());
}

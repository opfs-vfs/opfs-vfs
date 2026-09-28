"""Validate the reviewed 2026-09-23 collections and regenerate website statistics.
Run from any directory: python3 scripts/summarize-benchmarks.py
Only Python's standard library is required. Raw exports are never rewritten.
"""
import hashlib
import json
import math
from datetime import datetime
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'apps/website/public/benchmarks/results/2026-09-23'
OUTPUT = ROOT / 'apps/website/src/data/benchmark-results.json'
BROWSERS = ['chrome', 'safari', 'firefox']
BASE = '34ba9b3970c33a57508383778d405f2e1b0d8967'
PATCH = '985ff0a32a488aaf02083ca4f2c82a53c8ca67ff6f8e9295036d663334c326de'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def stats(values):
    require(len(values) == 5, 'Expected five measured values')
    if all(v is None for v in values):
        return None
    require(all(type(v) in (float, int) and math.isfinite(v) and v >= 0 for v in values), 'Invalid timing')
    return dict(median=median(values), min=min(values), max=max(values), n=5)


def expected_jobs(browser):
    jobs = []
    for workload in ['pglite-speedtest', 'transactions']:
        for backend in ['opfs-vfs', 'opfs-ahp', 'idb', 'memory']:
            if browser == 'safari' and backend == 'opfs-ahp':
                continue
            for buffer in ['disk', 'memory'] if backend == 'opfs-vfs' else ['disk']:
                jobs.append(dict(id=f'{workload}-{backend}' + (f'-{buffer}' if backend == 'opfs-vfs' else ''), suite='sql', config=dict(backends=[backend], workload=workload, rows=10000 if workload == 'transactions' else None, repetitions=1, bufferMode=buffer, durability='balanced', relaxedDurability=False)))
    for buffer in ['disk', 'memory']:
        jobs.append(dict(id=f'filesystem-{buffer}', suite='filesystem', config=dict(files=1000, repetitions=1, bufferMode=buffer, durability='balanced')))
    return jobs


def summarize():
    require(digest(DATA / 'collector.patch') == PATCH, 'Collector patch mismatch')
    result = dict(date='2026-09-23', protocol='mac-browser-v1', baseCommit=BASE, patchSha256=PATCH, machines=[])
    versions = None
    workloads = None
    for machine in ['m5-pro', 'm1-max']:
        folder = DATA / machine
        provenance = json.loads((folder / 'provenance.json').read_text())
        require(provenance['baseCommit'] == BASE and provenance['patchSha256'] == PATCH, 'Provenance mismatch')
        metadata = dict(id=machine, label=provenance['machine'], os='macOS ' + provenance['macOS'], browsers=[])
        intervals = []
        for browser in BROWSERS:
            path = folder / f'{browser}.json'
            receipt = next(c for c in provenance['collections'] if c['browser'] == browser)
            require(digest(path) == receipt['sha256'], f'Checksum mismatch: {path}')
            report = json.loads(path.read_text())
            require(report['kind'] == 'opfs-vfs-benchmark-collection' and report['schemaVersion'] == 1 and report['protocol'] == 'mac-browser-v1', 'Unknown collection format')
            require(report['status'] == 'complete' and report['eligibleForReview'] is True and report['interrupted'] is False, 'Ineligible collection')
            env = report['environment']
            require(env['browser'] == browser and env['macOS'] == provenance['macOS'] and env['crossOriginIsolated'] is True, 'Environment mismatch')
            require(report['versions']['sourceCommit'] == BASE + '+dirty', 'Source mismatch')
            if versions is None:
                versions, workloads = report['versions'], report['workloads']
            require(report['versions'] == versions and report['workloads'] == workloads, 'Versions or workloads differ')
            require(report['workloads']['payloadBytes'] == 1024, 'Unexpected payload')
            require(report['startedAt'] == receipt['startedAt'] and report['finishedAt'] == receipt['finishedAt'], 'Provenance timestamp mismatch')
            start, end = instant(report['startedAt']), instant(report['finishedAt'])
            require(start < end, 'Invalid interval')
            intervals.append((start, end))
            jobs = expected_jobs(browser)
            require(report['jobs'] == jobs, 'Job configuration mismatch')
            require(report['skipped'] == ([dict(backend='opfs-ahp', reason='Omitted on Safari by collection protocol.')] if browser == 'safari' else []), 'Unexpected omission')
            schedule = [(jobs[(i + r) % len(jobs)], r) for r in range(6) for i in range(len(jobs))]
            require(len(report['entries']) == len(schedule), 'Missing entries')
            previous = start
            for entry, (job, round_) in zip(report['entries'], schedule):
                require(entry['jobId'] == job['id'] and entry['round'] == round_ and entry['warmup'] == (round_ == 0), 'Schedule mismatch')
                require(not entry.get('error') and len(entry['samples']) == 1, 'Entry error')
                begin, finish = instant(entry['startedAt']), instant(entry['finishedAt'])
                require(previous <= begin <= finish <= end, 'Overlapping samples')
                previous = finish
                sample = entry['samples'][0]
                require(sample['status'] == 'ok' and not sample.get('error') and sample['repetition'] == 1, 'Failed sample')
                if job['suite'] == 'sql':
                    require(sample['backend'] == job['config']['backends'][0], 'Backend mismatch')
                    rows = 10000 if job['config']['workload'] == 'transactions' else 0
                    require(sample['expectedRows'] == rows and sample['actualRows'] == rows, 'Row verification mismatch')
                    for metric in ['initMs', 'workloadMs', 'persistenceMs', 'reopenMs']:
                        value = sample[metric]
                        require(value is None if job['config']['backends'] == ['memory'] and metric in ['persistenceMs', 'reopenMs'] else type(value) in (int, float) and math.isfinite(value) and value >= 0, 'Invalid SQL metric')
                    if job['config']['workload'] == 'pglite-speedtest':
                        require([s['id'] for s in sample['stages']] == list(range(1, 17)), 'Missing SQL cases')
                        require(all(math.isfinite(s['durationMs']) and s['durationMs'] >= 0 for s in sample['stages']), 'Invalid SQL case')
                        require(math.isclose(sum(s['durationMs'] for s in sample['stages']), sample['workloadMs'], abs_tol=0.001), 'SQL total mismatch')
                else:
                    require(all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in [sample['mountMs'], *sample['timings'].values()]), 'Invalid filesystem timing')
                    require(sample['verifiedFiles'] == 500, 'Filesystem verification mismatch')
                    require(set(sample['timings']) == set(['create', 'write', 'read', 'rename', 'delete', 'flush', 'reopen']), 'Missing filesystem phases')
            summaries = []
            for job in jobs:
                entries = [e for e in report['entries'] if e['jobId'] == job['id'] and not e['warmup']]
                samples = [e['samples'][0] for e in entries]
                if job['suite'] == 'sql':
                    metrics = {key: stats([s[key] for s in samples]) for key in ['initMs', 'workloadMs', 'persistenceMs', 'reopenMs']}
                    metrics['preparationMs'] = stats([e['preparationMs'] for e in entries])
                    stages = [dict(id=i, timing=stats([s['stages'][i-1]['durationMs'] for s in samples])) for i in range(1, 17)] if job['config']['workload'] == 'pglite-speedtest' else []
                else:
                    metrics = {'mountMs': stats([s['mountMs'] for s in samples]), **{key: stats([s['timings'][key] for s in samples]) for key in samples[0]['timings']}}
                    stages = []
                summaries.append(dict(id=job['id'], suite=job['suite'], metrics=metrics, stages=stages))
            metadata['browsers'].append(dict(id=browser, version=env['browserVersion'], notes=env['notes'], source=f'/benchmarks/results/2026-09-23/{machine}/{browser}.json', sha256=receipt['sha256'], measured=len(jobs)*5, jobs=summaries))
        intervals.sort()
        require(all(a[1] <= b[0] for a, b in zip(intervals, intervals[1:])), 'Browser collections overlap')
        result['machines'].append(metadata)
    result.update(versions=versions, workloads=workloads)
    return result


if __name__ == '__main__':
    result = summarize()
    OUTPUT.write_text(json.dumps(result, indent=2) + '\n')
    print('Validated six collections: 340 measured samples, 68 excluded warm-ups. Wrote', OUTPUT.relative_to(ROOT))

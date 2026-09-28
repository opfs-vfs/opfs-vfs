import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('collection exports all real worker samples with warmups, versions and correctness results', async ({ page }) => {
  test.skip(!process.env.BENCHMARK_COLLECTION_FULL, 'Opt in to the full 72-sample collection.');
  test.setTimeout(900_000);
  await page.goto('/benchmarks/collect/');
  await page.getByRole('textbox', { name: 'Machine / device' }).fill('Test computer 64 GB');
  await page.getByRole('textbox', { name: 'OS version', exact: true }).fill('26.6.2');
  await page.getByRole('textbox', { name: 'Operating system', exact: true }).fill('macOS');
  await page
    .getByRole('textbox', { name: 'Browser version', exact: true })
    .fill('automated smoke test, not for publication');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Run collection', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/^(Complete|Failed|Cancelled)$/, { timeout: 870_000 });
  await expect(page.getByRole('status')).toHaveText('Complete');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(report.kind).toBe('opfs-vfs-benchmark-collection');
  expect(report.eligibleForReview).toBe(true);
  expect(report.versions.sourceCommit).not.toBe('');
  expect(report.environment.machine).toBe('Test computer 64 GB');
  expect(report.entries).toHaveLength(report.jobs.length * 6);
  expect(report.entries.filter((e: { warmup: boolean }) => !e.warmup)).toHaveLength(report.jobs.length * 5);
  for (const entry of report.entries) {
    expect(entry.samples).toHaveLength(1);
    expect(entry.samples[0].status).toBe('ok');
    if (entry.jobId.startsWith('pglite-speedtest')) expect(entry.samples[0].stages).toHaveLength(16);
    if (entry.jobId.startsWith('filesystem')) expect(entry.samples[0].verifiedFiles).toBe(500);
    if (entry.jobId.startsWith('transactions')) expect(entry.samples[0].actualRows).toBe(10000);
  }
});

test('collection cancellation preserves a partial export', async ({ page }) => {
  await page.goto('/benchmarks/collect/');
  await page.getByRole('textbox', { name: 'Machine / device' }).fill('Test computer 64 GB');
  await page.getByRole('textbox', { name: 'OS version', exact: true }).fill('26.6.2');
  await page.getByRole('textbox', { name: 'Operating system', exact: true }).fill('macOS');
  await page.getByRole('textbox', { name: 'Browser version', exact: true }).fill('smoke test');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Run collection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled', { timeout: 45_000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(report.environment.machine).toBe('Test computer 64 GB');
  expect(report.environment.os).toBe('macOS');
  expect(report.environment.osVersion).toBe('26.6.2');
  expect(report.protocol).toBe('browser-collection-v2');
  expect(report.status).toBe('cancelled');
  expect(report.eligibleForReview).toBe(false);
  expect(report.interrupted).toBe(true);
});

test('cleanup failure stops collection before another worker starts', async ({ page }) => {
  await page.addInitScript(() => {
    // A real cleanup failure is unsafe to provoke; retain the real controller and inject the worker reply.
    class CleanupFailedWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      postMessage() {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              type: 'sample',
              sample: {
                backend: 'opfs-vfs',
                repetition: 1,
                status: 'failed',
                error: 'Cleanup failed: test failure',
              },
            },
          });
          this.onmessage?.({ data: { type: 'done', cancelled: false } });
        });
      }
      terminate() {}
    }
    window.Worker = CleanupFailedWorker as unknown as typeof Worker;
  });
  await page.goto('/benchmarks/collect/');
  await page.getByRole('textbox', { name: 'Machine / device' }).fill('Test computer 64 GB');
  await page.getByRole('textbox', { name: 'OS version', exact: true }).fill('26.6.2');
  await page.getByRole('textbox', { name: 'Operating system', exact: true }).fill('macOS');
  await page.getByRole('textbox', { name: 'Browser version', exact: true }).fill('smoke test');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Run collection', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Failed');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(report.entries).toHaveLength(1);
  expect(report.entries[0].samples[0].error).toContain('Cleanup failed:');
  expect(report.eligibleForReview).toBe(false);
  expect(report.error).toContain('Clear this benchmark origin');
});

test('mobile metadata and AHP omission survive export; required device details gate running', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/benchmarks/collect/');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: 'Run collection', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Machine / device' }).fill('iPad Pro M4');
  await page.getByRole('textbox', { name: 'OS version', exact: true }).fill('26.0');
  await page.getByRole('textbox', { name: 'Browser version', exact: true }).fill('mobile smoke');
  await expect(page.getByRole('textbox', { name: 'Operating system', exact: true })).toHaveValue('iPadOS');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Run collection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled', { timeout: 45_000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const report = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(report.environment.machine).toBe('iPad Pro M4');
  expect(report.environment.os).toBe('iPadOS');
  expect(report.environment.osVersion).toBe('26.0');
  expect(report.environment.macOS).toBeUndefined();
  expect(report.jobs).toHaveLength(10);
  expect(report.skipped[0].backend).toBe('opfs-ahp');
});

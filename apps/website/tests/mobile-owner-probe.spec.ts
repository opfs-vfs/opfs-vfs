import { expect, test } from '@playwright/test';

test('reports a terminal nested-worker capability result without starting a page owner', async ({ page }) => {
  await page.goto(`/demos/mobile-owner-probe/?probe=probe-${crypto.randomUUID()}`);
  const gate = page.getByText(/^Native coordinator gate:/);
  await expect(gate).toHaveText(/Native coordinator gate: (native-ready|unsupported)/, { timeout: 30_000 });
  const status = page.getByRole('status');
  if ((await gate.textContent())?.endsWith('unsupported')) {
    await expect(status).toHaveText(
      /Unsupported: (nested-worker-unavailable|nested-worker-failed|shared-array-buffer-unavailable|opfs-sync-handle-failed|native-cleanup-failed)\. No page-owned fallback was started\./,
    );
  } else {
    await expect(status).toHaveText(
      'Native capability passed. Coordinator integration remains disabled because the cross-browser topology is rejected.',
    );
  }
});

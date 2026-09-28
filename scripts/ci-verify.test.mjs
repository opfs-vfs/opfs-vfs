import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

await test('verify rejects failed, cancelled or unexpectedly skipped jobs', () => {
  const script = fileURLToPath(new URL('./ci-verify.sh', import.meta.url));
  const allowed = new Set(['success:success:["package"]', 'success:skipped:[]']);
  for (const checks of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const tests of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const packages of ['["package"]', '[]', '']) {
        const result = spawnSync('bash', [script], {
          env: { ...process.env, CHECKS_RESULT: checks, TESTS_RESULT: tests, TEST_PACKAGES: packages },
        });
        assert.equal(result.error, undefined);
        const scenario = `${checks}:${tests}:${packages}`;
        assert.equal(result.status === 0, allowed.has(scenario), scenario);
      }
    }
  }
});

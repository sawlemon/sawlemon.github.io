/**
 * End-to-end regression for the canonicalizer gate at the orchestrator
 * boundary: a malformed present month snapshot must abort the pipeline with
 * actionable Python diagnostics (never a silent total reduction), while
 * valid fixtures canonicalize with the expected totals. planOffline is the
 * write-free entrypoint of the publication flow; runtime artifacts live in
 * temporary directories outside the repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planOffline } from '../../../scripts/music-pipeline/orchestrator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_FIXTURES = resolve(HERE, '..', 'fixtures', 'raw');

function tempFlatSnapshots() {
  const dir = mkdtempSync(join(tmpdir(), 'replay-canonicalize-gate-'));
  cpSync(RAW_FIXTURES, dir, { recursive: true });
  return dir;
}

test('planOffline aborts with surfaced diagnostics for a malformed present month', () => {
  const dir = tempFlatSnapshots();
  try {
    // The original reproduction: February's month marker flipped to 13.
    const feb = join(dir, 'month-2024-02.json');
    const payload = JSON.parse(readFileSync(feb, 'utf8'));
    payload.resources['music-summaries']['month-2024-02'].attributes.month = 13;
    writeFileSync(feb, JSON.stringify(payload));
    assert.throws(
      () => planOffline({ snapshotDir: dir, logger: { log: () => {} } }),
      (error) => {
        assert.match(error.message, /exited with 1/);
        assert.match(error.message, /month-marker-invalid/);
        assert.match(error.message, /years\.2024\.months\.02/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planOffline canonicalizes valid fixtures with the expected totals', () => {
  const dir = tempFlatSnapshots();
  try {
    const plan = planOffline({ snapshotDir: dir, logger: { log: () => {} } });
    assert.deepEqual(plan.years, ['2024']);
    assert.deepEqual(
      plan.summary[0],
      { year: '2024', minutes: 120, months: 2, songs: 2, artists: 2 }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

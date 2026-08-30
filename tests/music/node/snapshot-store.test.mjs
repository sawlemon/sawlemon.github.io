import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshotStore, importFlatAsRun } from '../../../scripts/music-pipeline/snapshots/store.mjs';

test('snapshot store atomically commits and records hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-test-'));
  const store = createSnapshotStore({ root, clock: () => new Date('2024-01-01T00:00:00Z') });
  const writer = store.begin('run-1');
  writer.put({ kind: 'year', id: '2024', name: 'year-2024.json', payload: { data: [{ id: 'year-2024' }] } });
  writer.recordAbsent({ kind: 'month', id: '2024-02' });
  const manifest = writer.commit({ years: ['2024'] });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.snapshots.length, 2);
  assert.match(manifest.snapshots[0].payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(store.completedRuns()[0], 'run-1');
  assert.ok(existsSync(join(root, 'runs', 'run-1', 'raw', 'year-2024.json')));
});

test('aborted run never becomes completed', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-abort-'));
  const store = createSnapshotStore({ root });
  const writer = store.begin('run-abort');
  writer.put({ kind: 'year', id: '2024', name: 'year-2024.json', payload: '{}' });
  writer.abort();
  assert.deepEqual(store.completedRuns(), []);
  assert.equal(existsSync(join(root, 'runs', 'run-abort')), false);
});

test('legacy flat snapshots can be imported without changing payload bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-flat-'));
  const flat = mkdtempSync(join(tmpdir(), 'replay-flat-'));
  const payload = '{"data":[{"id":"year-2024"}]}';
  writeFileSync(join(flat, 'year-2024.json'), payload);
  importFlatAsRun({ root, flatDir: flat, runId: 'legacy-1', clock: () => new Date('2024-01-01T00:00:00Z') });
  assert.equal(readFileSync(join(root, 'runs', 'legacy-1', 'raw', 'year-2024.json'), 'utf8'), payload);
});

test('retention keeps newest completed runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-retain-'));
  const store = createSnapshotStore({ root, retainRuns: 2 });
  for (const id of ['2024-a', '2024-b', '2024-c']) {
    const writer = store.begin(id);
    writer.put({ kind: 'year', id: '2024', name: `year-${id}.json`, payload: '{}' });
    writer.commit({ years: ['2024'] });
  }
  assert.deepEqual(store.completedRuns(), ['2024-c', '2024-b']);
});

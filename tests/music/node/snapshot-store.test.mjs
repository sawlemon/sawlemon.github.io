import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSnapshotStore, importFlatAsRun } from '../../../scripts/music-pipeline/snapshots/store.mjs';
import {
  ManifestValidationError,
  validateManifestFile
} from '../../../scripts/music-pipeline/snapshots/manifest-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const CANONICALIZER = resolve(HERE, '..', '..', '..', 'scripts', 'music-pipeline', 'canonicalize', 'canonicalize.py');
const FIXED_CLOCK = () => new Date('2024-01-01T00:00:00Z');

test('snapshot store atomically commits and records hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-test-'));
  const store = createSnapshotStore({ root, clock: FIXED_CLOCK });
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

test('committed manifests record absent entries pathless, present entries with safe raw/ paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-absent-'));
  const store = createSnapshotStore({ root, clock: FIXED_CLOCK });
  const writer = store.begin('run-absent');
  writer.put({ kind: 'year', id: '2024', name: 'year-2024.json', payload: '{}' });
  writer.recordAbsent({ kind: 'month', id: '2024-02', httpStatus: 404 });
  const manifest = writer.commit({ years: ['2024'] });

  const absent = manifest.snapshots.find((s) => s.status === 'absent');
  const present = manifest.snapshots.find((s) => s.status === 'present');
  assert.equal(absent.id, '2024-02');
  assert.equal('path' in absent, false);
  assert.equal('payloadSha256' in absent, false);

  // The on-disk manifest (what the Python reader consumes) matches.
  const onDisk = JSON.parse(readFileSync(join(root, 'runs', 'run-absent', 'manifest.json'), 'utf8'));
  const absentOnDisk = onDisk.snapshots.find((s) => s.status === 'absent');
  assert.equal('path' in absentOnDisk, false);
  assert.equal('payloadSha256' in absentOnDisk, false);
  assert.match(present.path, /^raw\/[^/]/);
  assert.doesNotMatch(present.path, /\.\./);
  assert.match(present.payloadSha256, /^[0-9a-f]{64}$/);
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
  importFlatAsRun({ root, flatDir: flat, runId: 'legacy-1', clock: FIXED_CLOCK });
  assert.equal(readFileSync(join(root, 'runs', 'legacy-1', 'raw', 'year-2024.json'), 'utf8'), payload);
});

test('retention keeps newest completed runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-retain-'));
  const store = createSnapshotStore({ root, retainRuns: 2, clock: FIXED_CLOCK });
  for (const id of ['2024-a', '2024-b', '2024-c']) {
    const writer = store.begin(id);
    writer.put({ kind: 'year', id: '2024', name: `year-${id}.json`, payload: '{}' });
    writer.commit({ years: ['2024'] });
  }
  assert.deepEqual(store.completedRuns(), ['2024-c', '2024-b']);
});

test('default gate rejects an invalid manifest before promotion and does not prune completed runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-gate-'));
  // Two valid completed runs exist (kept because this store retains 5).
  const keeper = createSnapshotStore({ root, retainRuns: 5, clock: FIXED_CLOCK });
  for (const id of ['run-a', 'run-b']) {
    const writer = keeper.begin(id);
    writer.put({ kind: 'year', id: '2024', name: `year-${id}.json`, payload: '{}' });
    writer.commit({ years: ['2024'] });
  }

  // The reproduced defect set, expressed entirely through supported
  // writer/commit inputs: missing years (undefined is dropped by JSON),
  // a negative httpStatus on an absent entry, and string coverage. The
  // DEFAULT production gate — the real Python validator subprocess — must
  // reject it before promotion. With retainRuns: 1, a successful commit
  // would prune run-a and run-b.
  const broken = createSnapshotStore({ root, retainRuns: 1, clock: FIXED_CLOCK });
  const writer = broken.begin('run-c');
  writer.put({ kind: 'year', id: '2024', name: 'year-run-c.json', payload: '{}' });
  writer.recordAbsent({ kind: 'month', id: '2024-02', httpStatus: -5 });

  let gateError;
  assert.throws(
    () => writer.commit({ coverage: 'everything' }),
    (e) => {
      gateError = e;
      return e instanceof ManifestValidationError;
    }
  );
  assert.match(gateError.diagnostics, /manifest-years/);
  assert.match(gateError.diagnostics, /snapshot-http-status/);
  assert.match(gateError.diagnostics, /manifest-coverage/);
  assert.deepEqual(broken.completedRuns(), ['run-b', 'run-a']);

  // Staging remains behind and abortable per the established pattern; the
  // staged manifest really is missing years.
  const staging = join(root, 'runs', '.staging-run-c');
  assert.equal(existsSync(staging), true);
  const stagedManifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'));
  assert.equal('years' in stagedManifest, false);
  writer.abort();
  assert.equal(existsSync(staging), false);
  assert.deepEqual(broken.completedRuns(), ['run-b', 'run-a']);
});

test('put rejects payload names that could not form a safe raw/ path', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-store-name-'));
  const store = createSnapshotStore({ root, clock: FIXED_CLOCK });
  const writer = store.begin('run-name');
  for (const name of ['../escape.json', 'nested/name.json', '..', '']) {
    assert.throws(() => writer.put({ kind: 'year', id: '2024', name, payload: '{}' }), /unsafe payload file name/);
  }
  writer.abort();
  assert.deepEqual(store.completedRuns(), []);
});

test('promotion gate reuses the authoritative Python validator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-manifest-check-'));
  const valid = join(dir, 'valid.json');
  writeFileSync(valid, JSON.stringify({
    schemaVersion: 1,
    runId: 'r',
    source: 'apple-music-replay',
    fetchedAt: '2024-01-01T00:00:00Z',
    years: [],
    snapshots: [{ kind: 'year', id: '2024', status: 'absent' }]
  }));
  assert.doesNotThrow(() => validateManifestFile(valid));

  const contradictory = join(dir, 'contradictory.json');
  writeFileSync(contradictory, JSON.stringify({
    schemaVersion: 1,
    runId: 'r',
    source: 'apple-music-replay',
    fetchedAt: '2024-01-01T00:00:00Z',
    years: [],
    snapshots: [{ kind: 'year', id: '2024', status: 'absent', path: 'raw/year-2024.json' }]
  }));
  assert.throws(() => validateManifestFile(contradictory), (e) => e instanceof ManifestValidationError && e.code === 'manifest-invalid');

  // A 64-digit integer is not a hash: the manifest embeds a JSON integer
  // literal (JS Numbers cannot hold one), so the validator sees an int and
  // must reject it instead of stringifying it into a matching string.
  const numericHash = join(dir, 'numeric-hash.json');
  writeFileSync(numericHash, `{
    "schemaVersion": 1,
    "runId": "r",
    "source": "apple-music-replay",
    "fetchedAt": "2024-01-01T00:00:00Z",
    "years": ["2024"],
    "snapshots": [{
      "kind": "year",
      "id": "2024",
      "path": "raw/year-2024.json",
      "status": "present",
      "payloadSha256": ${'1'.repeat(64)}
    }]
  }`);
  assert.throws(
    () => validateManifestFile(numericHash),
    (e) => e instanceof ManifestValidationError && /snapshot-hash/.test(e.diagnostics)
  );
  rmSync(dir, { recursive: true, force: true });
});

test('integration: Node writer pathless absent entries canonicalize through the Python reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-integration-'));
  const store = createSnapshotStore({ root, clock: FIXED_CLOCK });
  const writer = store.begin('integration-1');
  for (const name of ['year-2024.json', 'month-2024-01.json', 'month-2024-02.json']) {
    writer.put({
      kind: name.startsWith('year-') ? 'year' : 'month',
      id: name.replace(/\.json$/, '').replace(/^year-/, '').replace(/^month-/, ''),
      name,
      payload: readFileSync(join(FIXTURES, 'raw', name), 'utf8')
    });
  }
  writer.recordAbsent({ kind: 'month', id: '2024-03', httpStatus: 404 });
  const manifest = writer.commit({ years: ['2024'] });
  const absent = manifest.snapshots.find((s) => s.status === 'absent');
  assert.equal('path' in absent, false);
  assert.equal('payloadSha256' in absent, false);

  const runDir = join(root, 'runs', 'integration-1');
  const output = join(root, 'music.json');
  const result = spawnSync(
    'python3',
    [CANONICALIZER, '--input-dir', runDir, '--generated-date', '2024-01-01', '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `canonicalize.py failed: ${result.stderr || result.stdout}`);
  const candidate = JSON.parse(readFileSync(output, 'utf8'));
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected', 'music.json'), 'utf8'));
  assert.deepEqual(candidate, expected);
  rmSync(root, { recursive: true, force: true });
});

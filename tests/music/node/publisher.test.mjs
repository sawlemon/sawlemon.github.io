import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSitePublication, publishSiteData } from '../../../scripts/music-pipeline/publishing/site-data.mjs';

function candidate() {
  return {
    generated: '2024-01-01',
    years: {
      '2024': {
        minutes: 1,
        months: [{ month: 1, label: 'Jan', minutes: 1, artists: [] }],
        topSongs: [{ title: 'Song', artist: 'Artist', album: null, artwork: null, plays: 1 }],
        topArtists: [{ name: 'Artist', minutes: 1, plays: 1 }],
        topAlbums: [],
        playlist: null
      }
    }
  };
}

test('site publication plan is write-free and detects changes', () => {
  const data = candidate();
  const before = JSON.stringify({ unchanged: true });
  const plan = planSitePublication({ candidate: data, targetCurrent: before });
  assert.equal(plan.changed, true);
  assert.equal(plan.targetPath, 'src/data/music.json');
  assert.match(plan.newSha256, /^[0-9a-f]{64}$/);
  assert.equal(before, JSON.stringify({ unchanged: true }));
});

test('site publication restores exact bytes when a check fails', () => {
  const repo = mkdtempSync(join(tmpdir(), 'replay-publisher-test-'));
  const targetDir = join(repo, 'src', 'data');
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, 'music.json');
  const before = '{"old":true}\n';
  writeFileSync(target, before);
  const data = candidate();
  const plan = planSitePublication({ candidate: data, targetCurrent: before });
  const result = publishSiteData({
    plan,
    candidate: data,
    repoRoot: repo,
    checks: [['sh', ['-c', 'exit 1']]]
  });
  assert.deepEqual(result, { published: false, checksPassed: false, restored: true });
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('site publication replaces target when checks pass', () => {
  const repo = mkdtempSync(join(tmpdir(), 'replay-publisher-ok-'));
  const targetDir = join(repo, 'src', 'data');
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, 'music.json');
  const before = '{"old":true}\n';
  writeFileSync(target, before);
  const data = candidate();
  const plan = planSitePublication({ candidate: data, targetCurrent: before });
  const result = publishSiteData({
    plan,
    candidate: data,
    repoRoot: repo,
    checks: [['sh', ['-c', 'exit 0']]]
  });
  assert.equal(result.published, true);
  assert.equal(result.checksPassed, true);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), data);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTargetOnlyChange, gitPreflight, GuardError } from '../../../scripts/music-pipeline/publishing/repository.mjs';

function fakeGit(map) {
  return (args) => {
    const key = args.join(' ');
    const value = map[key] ?? { ok: true, status: 0, out: '', err: '' };
    return typeof value === 'function' ? value(args) : value;
  };
}

test('preflight requires clean main aligned with origin', () => {
  const runGit = fakeGit({
    'status --porcelain': { ok: true, out: '', err: '' },
    'branch --show-current': { ok: true, out: 'main', err: '' },
    'fetch origin': { ok: true, out: '', err: '' },
    'rev-parse main': { ok: true, out: 'abc', err: '' },
    'rev-parse origin/main': { ok: true, out: 'abc', err: '' }
  });
  assert.deepEqual(gitPreflight({ repoRoot: '/tmp', runGit }), { branch: 'main', head: 'abc' });
});

test('preflight refuses dirty trees and wrong branches', () => {
  const dirty = fakeGit({ 'status --porcelain': { ok: true, out: ' M notes.txt', err: '' } });
  assert.throws(() => gitPreflight({ repoRoot: '/tmp', runGit: dirty }), (e) => e instanceof GuardError && e.code === 'dirty-tree');
  const wrong = fakeGit({
    'status --porcelain': { ok: true, out: '', err: '' },
    'branch --show-current': { ok: true, out: 'feature', err: '' }
  });
  assert.throws(() => gitPreflight({ repoRoot: '/tmp', runGit: wrong }), (e) => e instanceof GuardError && e.code === 'wrong-branch');
});

test('preflight refuses remote divergence', () => {
  const runGit = fakeGit({
    'status --porcelain': { ok: true, out: '', err: '' },
    'branch --show-current': { ok: true, out: 'main', err: '' },
    'fetch origin': { ok: true, out: '', err: '' },
    'rev-parse main': { ok: true, out: 'abc', err: '' },
    'rev-parse origin/main': { ok: true, out: 'def', err: '' }
  });
  assert.throws(() => gitPreflight({ repoRoot: '/tmp', runGit }), (e) => e instanceof GuardError && e.code === 'remote-diverged');
});

test('target-only assertion rejects unrelated changes', () => {
  const runGit = fakeGit({ 'status --porcelain': { ok: true, out: ' M src/data/music.json', err: '' } });
  assert.doesNotThrow(() => assertTargetOnlyChange({ repoRoot: '/tmp', targetPath: 'src/data/music.json', runGit }));
  const bad = fakeGit({ 'status --porcelain': { ok: true, out: ' M src/data/music.json\n M src/pages/index.astro', err: '' } });
  assert.throws(() => assertTargetOnlyChange({ repoRoot: '/tmp', targetPath: 'src/data/music.json', runGit: bad }), (e) => e instanceof GuardError && e.code === 'unexpected-changes');
});

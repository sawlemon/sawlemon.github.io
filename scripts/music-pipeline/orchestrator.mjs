import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSnapshotStore, importFlatAsRun } from './snapshots/store.mjs';
import { createAppleReplayAdapter } from './acquisition/apple-replay-browser.mjs';
import { createHash } from 'node:crypto';
import { REPO_ROOT, DEFAULT_PROFILE_DIR } from './config.mjs';
import { planSitePublication, publishSiteData, readTargetBytes, TARGET_PATH } from './publishing/site-data.mjs';
import { assertTargetOnlyChange, commitTarget, gitPreflight, pushAndVerify } from './publishing/repository.mjs';

const canonicalizer = resolve(REPO_ROOT, 'scripts', 'music-pipeline', 'canonicalize', 'canonicalize.py');
const validator = resolve(REPO_ROOT, 'scripts', 'music-pipeline', 'canonicalize', 'validate.py');
const target = resolve(REPO_ROOT, TARGET_PATH);

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result;
}

function hashFile(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runPythonCanonicalize(inputDir, output, generatedDate) {
  run('python3', [canonicalizer, '--input-dir', inputDir, '--output', output, '--generated-date', generatedDate]);
}

function validateCandidate(path) {
  run('python3', [validator, '--input', path], { stdio: 'inherit' });
}

function newestRun(store) {
  const runId = store.completedRuns()[0];
  return runId ? store.runPath(runId) : null;
}

function legacyFlatSnapshotDir(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).some((name) => /^year-\d{4}\.json$/.test(name)) ? dir : null;
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Offline plan: no browser/network, no target replacement, no git mutation. */
export function planOffline({ snapshotDir, runId, repoRoot = REPO_ROOT, logger = console }) {
  const store = createSnapshotStore({ root: snapshotDir });
  const inputDir = runId ? store.runPath(runId) : newestRun(store);
  // Keep --plan useful with the original /tmp/replay flat layout too.
  const resolvedInput = inputDir || legacyFlatSnapshotDir(snapshotDir);
  if (!resolvedInput) throw new Error(`no completed snapshot run or legacy flat snapshots found under ${snapshotDir}`);
  const tempDir = makeTempDir('replay-plan-');
  const candidate = join(tempDir, 'music.json');
  try {
    runPythonCanonicalize(resolvedInput, candidate, new Date().toISOString().slice(0, 10));
    validateCandidate(candidate);
    const data = JSON.parse(readFileSync(candidate, 'utf8'));
    const plan = planSitePublication({ candidate: data, targetCurrent: readTargetBytes(repoRoot) });
    logger.log(JSON.stringify({ mode: 'plan', runId: resolvedInput.split('/').pop(), ...plan }, null, 2));
    return plan;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function refresh(options, { logger = console } = {}) {
  const store = createSnapshotStore({ root: options.snapshotDir, retainRuns: options.retainRuns });
  let runDir;
  let runId = options.runId || new Date().toISOString().replace(/[:.]/g, '-');

  if (options.plan || options.dryRun) {
    return planOffline({ snapshotDir: options.snapshotDir, runId: options.runId, logger });
  }

  // Auto-push preflight happens before browser/network or target mutation.
  if (!options.noPush) gitPreflight({ repoRoot: REPO_ROOT });

  if (options.skipFetch) {
    runDir = options.runId ? store.runPath(options.runId) : newestRun(store);
    if (options.runId && !existsSync(runDir)) {
      throw new Error(`completed snapshot run does not exist: ${options.runId}`);
    }
    if (!runDir) {
      // Legacy flat /tmp/replay remains accepted as input.
      runDir = legacyFlatSnapshotDir(options.snapshotDir);
    }
    if (!runDir) {
      throw new Error(`no completed snapshot run or legacy flat snapshots found under ${options.snapshotDir}`);
    }
  } else {
    const adapter = createAppleReplayAdapter({ profileDir: DEFAULT_PROFILE_DIR, logger });
    await adapter.acquire({ store, runId });
    runDir = store.runPath(runId);
  }

  const tempDir = makeTempDir('replay-candidate-');
  const candidate = join(tempDir, 'music.json');
  try {
    runPythonCanonicalize(runDir, candidate, new Date().toISOString().slice(0, 10));
    validateCandidate(candidate);
    const candidateData = JSON.parse(readFileSync(candidate, 'utf8'));
    const plan = planSitePublication({ candidate: candidateData, targetCurrent: readTargetBytes() });

    if (!plan.changed) {
      logger.log('music.json is unchanged — nothing to publish.');
      return { plan, changed: false };
    }

    const published = publishSiteData({ plan, candidate: candidateData });
    if (!published.checksPassed) throw new Error('site check/build failed; previous music.json restored');

    if (options.noPush) {
      logger.log('--no-push: music.json regenerated but not committed.');
      return { plan, changed: true, published };
    }

    assertTargetOnlyChange({ repoRoot: REPO_ROOT, targetPath: TARGET_PATH });
    const commit = commitTarget({ repoRoot: REPO_ROOT, targetPath: TARGET_PATH });
    const pushed = pushAndVerify({ repoRoot: REPO_ROOT });
    logger.log(`Pushed ${commit.head.slice(0, 7)}; GitHub Actions will deploy the site.`);
    return { plan, changed: true, published, commit, pushed };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

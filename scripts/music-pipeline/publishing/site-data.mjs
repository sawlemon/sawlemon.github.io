/**
 * Site-data publisher for the Replay pipeline.
 *
 * Owns the transaction around src/data/music.json: plan the change, replace
 * atomically, run the site checks, and restore the exact previous bytes if
 * anything fails. Nothing else in the pipeline touches the target file.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const TARGET_PATH = 'src/data/music.json';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function yearSummary(candidate) {
  const years = candidate?.years ?? {};
  return Object.entries(years).map(([year, yd]) => ({
    year,
    minutes: yd.minutes,
    months: yd.months?.length ?? 0,
    songs: yd.topSongs?.length ?? 0,
    artists: yd.topArtists?.length ?? 0
  }));
}

/**
 * Pure plan: compares a canonical candidate (object) with the current
 * target file content (string or null). Performs no writes.
 */
export function planSitePublication({ candidate, targetCurrent, targetPath = TARGET_PATH }) {
  const candidateText = JSON.stringify(candidate, null, 1);
  const oldSha256 = targetCurrent == null ? null : sha256(targetCurrent);
  const newSha256 = sha256(candidateText);
  const changed = targetCurrent == null || oldSha256 !== newSha256;
  return {
    changed,
    oldSha256,
    newSha256,
    targetPath,
    years: Object.keys(candidate.years ?? {}).sort(),
    summary: yearSummary(candidate),
    diagnostics: []
  };
}

function runCheck(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return r.status === 0;
}

function restoreTarget({ backupFile, targetAbs, hadTarget }) {
  if (hadTarget) {
    // Copy the backup next to the target, then rename (same-volume atomic).
    const tmp = join(dirname(targetAbs), `.${basename(targetAbs)}.restore-tmp`);
    writeFileSync(tmp, readFileSync(backupFile, 'utf8'), { encoding: 'utf8' });
    renameSync(tmp, targetAbs);
  } else {
    rmSync(targetAbs, { force: true });
  }
}

/**
 * Publishes the candidate transactionally:
 *   1. back up the exact current target bytes,
 *   2. atomically replace the target,
 *   3. run the site checks (default: npm run check, npm run build),
 *   4. restore the exact previous bytes (or remove a newly created target)
 *      if any check fails.
 * Returns {published, checksPassed, restored}.
 */
export function publishSiteData({ plan, candidate, repoRoot = REPO_ROOT, checks }) {
  const targetAbs = join(repoRoot, plan.targetPath);
  const targetCurrent = existsSync(targetAbs) ? readFileSync(targetAbs, 'utf8') : null;

  // Never publish a plan that does not match the candidate being handed in.
  if (sha256(JSON.stringify(candidate, null, 1)) !== plan.newSha256) {
    throw new Error('site-data publisher: candidate does not match the plan being published');
  }

  const checkCommands =
    checks ??
    [
      ['npm', ['run', 'check']],
      ['npm', ['run', 'build']]
    ];

  const backupDir = mkdtempSync(join(tmpdir(), 'music-publish-'));
  const backupFile = join(backupDir, 'music.json');
  const hadTarget = targetCurrent != null;
  let published = false;
  let checksPassed = false;
  let restored = false;

  try {
    if (hadTarget) writeFileSync(backupFile, targetCurrent, { encoding: 'utf8' });

    mkdirSync(dirname(targetAbs), { recursive: true });
    // Atomic replacement: write a temp file next to the target (same
    // volume), then rename over it.
    const targetTmp = join(dirname(targetAbs), `.${basename(targetAbs)}.tmp`);
    writeFileSync(targetTmp, JSON.stringify(candidate, null, 1), { encoding: 'utf8' });
    renameSync(targetTmp, targetAbs);
    published = true;

    checksPassed = checkCommands.every(([cmd, args]) => runCheck(cmd, args, repoRoot));

    if (!checksPassed) {
      restoreTarget({ backupFile, targetAbs, hadTarget });
      restored = true;
      published = false;
    }
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }

  return { published, checksPassed, restored };
}

/**
 * Convenience for offline planning: read the current target bytes if the
 * file exists, else null. Exposed so orchestrators do not import fs directly.
 */
export function readTargetBytes(repoRoot = REPO_ROOT, targetPath = TARGET_PATH) {
  const abs = resolve(repoRoot, targetPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

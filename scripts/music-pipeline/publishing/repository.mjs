/**
 * Repository publisher for the Replay pipeline.
 *
 * The only module allowed to mutate Git state. Default publishing keeps the
 * historical behavior (commit src/data/music.json on main, push origin
 * main) but adds strict preflight and post-push verification:
 *
 *   - refuse on dirty working tree/index or unrelated changes;
 *   - refuse off main or on detached HEAD;
 *   - refuse when local main is ahead/behind/diverged from origin/main;
 *   - commit ONLY the data target, never anything staged by someone else;
 *   - verify origin/main == local HEAD after the push.
 *
 * A failed push leaves the local commit in place and reports recovery; this
 * module never resets, forces, or auto-pulls.
 */
import { spawnSync } from 'node:child_process';

const DEFAULT_GIT = (repoRoot) => (args) => {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

export class GuardError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code ?? 'guard-refused';
  }
}

function git(repoRoot, injected) {
  return injected ?? DEFAULT_GIT(repoRoot);
}

/**
 * Preflight: run BEFORE any browser/network/target mutation so a refused
 * run costs nothing.
 */
export function gitPreflight({ repoRoot, remote = 'origin', requiredBranch = 'main', runGit } = {}) {
  const g = git(repoRoot, runGit);

  const status = g(['status', '--porcelain']);
  if (!status.ok) throw new GuardError(`git status failed: ${status.err}`, 'git-status-failed');
  if (status.out) {
    throw new GuardError(
      `refusing to run: working tree not clean (${status.out.split('\n').length} change(s)) — commit or stash first`,
      'dirty-tree'
    );
  }

  const branch = g(['branch', '--show-current']);
  if (!branch.ok) throw new GuardError(`git branch failed: ${branch.err}`, 'git-branch-failed');
  if (branch.out !== requiredBranch) {
    throw new GuardError(
      `refusing to publish: current branch is "${branch.out}", expected "${requiredBranch}"`,
      'wrong-branch'
    );
  }

  const fetch = g(['fetch', remote]);
  if (!fetch.ok) throw new GuardError(`git fetch ${remote} failed: ${fetch.err}`, 'git-fetch-failed');

  const local = g(['rev-parse', requiredBranch]);
  const remoteRef = g(['rev-parse', `${remote}/${requiredBranch}`]);
  if (!local.ok || !remoteRef.ok) {
    throw new GuardError('could not resolve local/remote branch heads', 'git-refs-failed');
  }
  if (local.out !== remoteRef.out) {
    throw new GuardError(
      `refusing to publish: local ${requiredBranch} (${local.out.slice(0, 7)}) differs from ${remote}/${requiredBranch} (${remoteRef.out.slice(0, 7)}) — pull or push manually first`,
      'remote-diverged'
    );
  }

  return { branch: branch.out, head: local.out };
}

/**
 * After site publication: assert that the only working-tree change is the
 * data target being modified. Anything else refuses.
 */
export function assertTargetOnlyChange({ repoRoot, targetPath, runGit } = {}) {
  const g = git(repoRoot, runGit);
  const status = g(['status', '--porcelain']);
  const lines = status.out.split('\n').filter(Boolean);
  const expected = new RegExp(`^\\s?M\\s+${targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const unexpected = lines.filter((line) => !expected.test(line));
  if (unexpected.length) {
    throw new GuardError(
      `refusing to commit: unexpected working-tree changes (${unexpected.join(' ; ')})`,
      'unexpected-changes'
    );
  }
  if (!lines.length) {
    throw new GuardError('nothing to commit: target is unchanged', 'nothing-to-commit');
  }
  return true;
}

/**
 * Commits only the data target. Uses `git commit --only` so pre-existing
 * staged changes to other files can never leak into the commit.
 */
export function commitTarget({ repoRoot, targetPath, message = 'Refresh Apple Music Replay data', runGit } = {}) {
  const g = git(repoRoot, runGit);
  const commit = g(['commit', '--only', '-m', message, '--', targetPath]);
  if (!commit.ok) {
    throw new GuardError(`git commit failed: ${commit.err || commit.out}`, 'git-commit-failed');
  }
  const head = g(['rev-parse', 'HEAD']);
  return { committed: true, head: head.out };
}

/**
 * Pushes the branch and verifies the remote head moved to it. A failed push
 * leaves the local commit; recovery is manual by design.
 */
export function pushAndVerify({ repoRoot, branch = 'main', remote = 'origin', runGit } = {}) {
  const g = git(repoRoot, runGit);
  const push = g(['push', remote, branch]);
  if (!push.ok) {
    throw new GuardError(
      `git push failed (${push.err || push.out}) — the commit is local; inspect and push manually`,
      'git-push-failed'
    );
  }
  const fetch = g(['fetch', remote]);
  if (!fetch.ok) throw new GuardError(`post-push fetch failed: ${fetch.err}`, 'git-fetch-failed');
  const local = g(['rev-parse', 'HEAD']);
  const remoteRef = g(['rev-parse', `${remote}/${branch}`]);
  if (!local.ok || !remoteRef.ok || local.out !== remoteRef.out) {
    throw new GuardError('post-push verification failed: remote head does not match local HEAD', 'push-verify-failed');
  }
  return { pushed: true, remoteHead: remoteRef.out };
}

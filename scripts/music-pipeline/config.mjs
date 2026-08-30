import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_SNAPSHOT_DIR = process.env.REPLAY_DIR || '/tmp/replay';
export const DEFAULT_PROFILE_DIR = join(REPO_ROOT, 'scripts', 'refresh-music', '.profile');
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_RETAIN_RUNS = 3;

export function parseArgs(argv) {
  const options = {
    noPush: false,
    skipFetch: false,
    plan: false,
    dryRun: false,
    help: false,
    snapshotDir: DEFAULT_SNAPSHOT_DIR,
    runId: null,
    retainRuns: DEFAULT_RETAIN_RUNS
  };
  const takesValue = new Set(['--snapshot-dir', '--run-id', '--retain-runs']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-push') options.noPush = true;
    else if (arg === '--skip-fetch') options.skipFetch = true;
    else if (arg === '--plan') options.plan = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (takesValue.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--snapshot-dir') options.snapshotDir = resolve(value);
      if (arg === '--run-id') options.runId = value;
      if (arg === '--retain-runs') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error('--retain-runs must be a nonnegative integer');
        options.retainRuns = n;
      }
    } else {
      throw new Error(`unknown option: ${arg} (use --help)`);
    }
  }
  if (options.plan || options.dryRun) options.noPush = true;
  return options;
}

export const HELP = `Usage: npm run music:refresh -- [options]

Options:
  --no-push                  update/check music.json without commit or push
  --skip-fetch               use existing snapshot files instead of Apple Music
  --plan                    validate/canonicalize existing snapshots without writes
  --dry-run                 alias for the write-free offline plan
  --snapshot-dir <path>     snapshot root (default: REPLAY_DIR or /tmp/replay)
  --run-id <id>              completed run to use for --skip-fetch/--plan
  --retain-runs <n>          completed runs to retain (default: 3)
  --help                    show this help

Normal refresh keeps the historical auto-push behavior and requires clean main.
Tokens, cookies, and request headers never enter snapshots or logs.`;

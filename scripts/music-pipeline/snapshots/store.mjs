/**
 * Replay snapshot store.
 *
 * Persistence seam for raw Apple Music Replay responses. Raw payloads are
 * private listening data: they live outside the repository, are written
 * atomically into a run-scoped directory, and are promoted only after a
 * complete, validated manifest is committed. A failed or interrupted run
 * never replaces the previous completed run.
 *
 * Layout under the snapshot root (default $REPLAY_DIR or /tmp/replay):
 *
 *   runs/<run-id>/manifest.json     validated before promotion
 *   runs/<run-id>/raw/*.json        response payloads
 *
 * Retention keeps the newest N completed runs; pruning happens only after a
 * successful commit. Nothing here ever stores request headers, tokens,
 * cookies, or URLs with query strings.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertSafeRunId(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`unsafe run id: ${JSON.stringify(runId).slice(0, 40)}`);
  }
}

export function createSnapshotStore({ root, retainRuns = 3, clock = () => new Date() }) {
  const runsDir = join(root, 'runs');

  function stagingDir(runId) {
    return join(runsDir, `.staging-${runId}`);
  }

  function prune() {
    if (!existsSync(runsDir)) return;
    const runs = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .filter((d) => existsSync(join(runsDir, d.name, 'manifest.json')))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const stale of runs.slice(Math.max(retainRuns, 0))) {
      rmSync(join(runsDir, stale), { recursive: true, force: true });
    }
  }

  return {
    /** Starts a staging run; only commit() promotes it. */
    begin(runId) {
      assertSafeRunId(runId);
      const staged = stagingDir(runId);
      if (existsSync(staged)) {
        throw new Error(`run already staged: ${runId}`);
      }
      mkdirSync(join(staged, 'raw'), { recursive: true });
      const entries = [];
      const warnings = [];

      return {
        /** Writes one payload atomically and records its manifest entry. */
        put({ kind, id, name, payload, httpStatus = 200, observedAt = clock().toISOString() }) {
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
          const target = join(staged, 'raw', name);
          const tmp = `${target}.tmp`;
          writeFileSync(tmp, text, { encoding: 'utf8' });
          renameSync(tmp, target);
          entries.push({
            kind,
            id,
            path: `raw/${name}`,
            status: 'present',
            httpStatus,
            observedAt,
            payloadSha256: sha256(text)
          });
        },
        /** Records a resource the source says does not exist (404). */
        recordAbsent({ kind, id, httpStatus = 404, observedAt = clock().toISOString() }) {
          entries.push({ kind, id, status: 'absent', httpStatus, observedAt });
        },
        warn(message) {
          warnings.push(message);
        },
        /** Validates and promotes the run; returns the manifest. */
        commit({ source = 'apple-music-replay', years, coverage = {} }) {
          const manifest = {
            schemaVersion: 1,
            runId,
            source,
            fetchedAt: clock().toISOString(),
            years,
            snapshots: entries,
            coverage,
            warnings
          };
          writeFileSync(join(staged, 'manifest.json'), JSON.stringify(manifest, null, 1), { encoding: 'utf8' });
          const finalDir = join(runsDir, runId);
          if (existsSync(finalDir)) {
            throw new Error(`completed run already exists: ${runId}`);
          }
          renameSync(staged, finalDir);
          prune();
          return manifest;
        },
        /** Discards the staging run entirely. */
        abort() {
          rmSync(staged, { recursive: true, force: true });
        }
      };
    },

    /** Lists completed run ids, newest first. */
    completedRuns() {
      if (!existsSync(runsDir)) return [];
      return readdirSync(runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .filter((d) => existsSync(join(runsDir, d.name, 'manifest.json')))
        .map((d) => d.name)
        .sort()
        .reverse();
    },

    /** Removes a completed run by id (used by retention tooling). */
    remove(runId) {
      assertSafeRunId(runId);
      rmSync(join(runsDir, runId), { recursive: true, force: true });
    },

    /** Copies a completed run directory elsewhere (for offline tooling). */
    runPath(runId) {
      assertSafeRunId(runId);
      return join(runsDir, runId);
    }
  };
}

/**
 * Copies a legacy flat directory (year-*.json / month-*.json) into a
 * completed run, so --skip-fetch and old layouts flow through the same
 * reader path as fresh runs.
 */
export function importFlatAsRun({ root, flatDir, runId, clock = () => new Date() }) {
  if (!existsSync(flatDir)) {
    throw new Error(`flat snapshot directory does not exist: ${flatDir}`);
  }
  const store = createSnapshotStore({ root, clock });
  const writer = store.begin(runId);
  try {
    const entries = [];
    for (const f of readdirSync(flatDir)) {
      if (!/^(year-\d{4}|month-\d{4}-\d{2})\.json$/.test(f)) continue;
      const kind = f.startsWith('year-') ? 'year' : 'month';
      const id = f.replace(/\.json$/, '').replace(/^year-/, '').replace(/^month-/, '');
      const payload = readFileSync(join(flatDir, f), 'utf8');
      writer.put({ kind, id, name: f, payload });
      entries.push(f);
    }
    if (!entries.length) {
      throw new Error(`no year-*.json or month-*.json files in ${flatDir}`);
    }
    const years = [...new Set(entries.filter((e) => e.startsWith('year-')).map((e) => e.slice(5, 9)))];
    return writer.commit({ years });
  } catch (error) {
    writer.abort();
    throw error;
  }
}

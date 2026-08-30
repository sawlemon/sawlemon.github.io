# Music Replay refresh

One command regenerates the [music page](https://sawlemon.github.io/music/) from Apple Music Replay:

```sh
npm run music:refresh
```

## Pipeline

The command is a thin coordinator over five stages:

1. The Apple Replay acquisition adapter opens a headed Chromium session, waits for authorization, captures the Replay app's own request templates, and fetches every year exposed by its dropdown plus months 1–12.
2. The snapshot store writes raw responses to a run-scoped directory outside the repository and records a non-secret manifest.
3. The Python canonicalizer maps raw Apple resources to the stable `src/data/music.json` shape.
4. The validator checks raw manifest and canonical-data invariants before publication.
5. The site publisher atomically replaces `music.json`, runs Astro check/build, and restores the exact old bytes if either check fails. The repository publisher then commits only `src/data/music.json` and pushes `main`.

The modules live under `scripts/music-pipeline/`:

```text
acquisition/       Apple browser adapter and URL/status protocol rules
snapshots/         atomic run writer and manifest
canonicalize/      Python raw reader, mapper, and validator
publishing/        site-data transaction and guarded Git publisher
cli.mjs            strict argument parser
orchestrator.mjs  stage coordinator
```

## Tokens and private data

The browser profile lives in `scripts/refresh-music/.profile/` and remains ignored by Git. MusicKit tokens, cookies, and captured request headers stay in browser/process memory. They are never printed, placed in a manifest, written to the repository, or sent to a logging service.

Raw listening snapshots live outside the repository under `${REPLAY_DIR:-/tmp/replay}/runs/`. Completed runs are ephemeral: the newest three are retained by default, older runs are removed only after a later run commits successfully. Interrupted runs stay in staging and never replace the last completed run.

## Options

```sh
npm run music:refresh -- --no-push
npm run music:refresh -- --skip-fetch --no-push
npm run music:refresh -- --plan
npm run music:refresh -- --dry-run
npm run music:refresh -- --snapshot-dir /path/to/replay
npm run music:refresh -- --run-id <completed-run-id>
npm run music:refresh -- --retain-runs 5
npm run music:refresh -- --help
```

- `--no-push` keeps the current review flow: acquire or read snapshots, validate, update `music.json`, run check/build, and stop without commit/push.
- `--skip-fetch` uses the newest completed run. A legacy flat directory containing `year-YYYY.json` and `month-YYYY-MM.json` is still accepted.
- `--plan` and `--dry-run` are offline and write-free. They read an existing completed run or legacy flat snapshots, canonicalize/validate in a temporary directory, and report years, coverage, hashes, and whether `music.json` would change. They do not open Apple Music, modify `music.json`, or touch Git.
- `--snapshot-dir` and `REPLAY_DIR` select the snapshot root. Node and Python use the same setting.
- `--run-id` selects a completed run for offline or skip-fetch operation.
- `--retain-runs` controls completed-run retention.
- Unknown options fail with usage instead of being ignored.

The default command still auto-publishes, but it refuses before acquisition if the repository is dirty, the branch is not exactly `main`, or local `main` does not match `origin/main`. After publication it refuses to commit if any path besides `src/data/music.json` changed, commits only that path, pushes without force, and verifies the remote head. A failed push leaves the local commit in place for manual recovery.

## Setup

```sh
cd scripts/refresh-music
npm install
npx playwright install chromium
```

The live browser path is manual. CI validates the checked-in canonical data and builds the site; it never opens Apple Music or accesses the private browser profile.

## Compatibility and rollback

The old entrypoints remain available:

```sh
REPLAY_DIR=/path/to/flat-snapshots python3 scripts/build-music-data.py
npm run music:refresh -- --skip-fetch --no-push
```

The canonical output keeps its existing fields, ranking rules, playlist selection, UTF-8 formatting, and build-date `generated` field. If site check/build fails, the publisher restores the exact previous bytes. If Git push fails, the new commit remains local and is reported; the pipeline never resets or force-pushes.

The current acquisition reads the year dropdown exposed by Apple Replay. It no longer relies on a fixed 2019-to-current year probe.

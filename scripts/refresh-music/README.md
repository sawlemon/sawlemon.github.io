# Music Replay refresh

One command regenerates the [music page](https://sawlemon.github.io/music/) from Apple Music Replay:

```sh
npm run music:refresh
```

## What it does

1. Opens `replay.music.apple.com` in a headed Chromium window (first run: you log in with your Apple
   ID; the session persists in `scripts/refresh-music/.profile/` so later runs usually don't ask).
2. Once logged in, reads the MusicKit developer token + personal media-user token from the page.
   **Tokens are held in memory only** — never logged, never written to disk, never committed.
3. Probes Replay years 2019 → current year, and fetches the year + monthly summaries into
   `/tmp/replay/` (same files `scripts/build-music-data.py` already parses).
4. Runs `scripts/build-music-data.py` to regenerate `src/data/music.json`.
5. Runs `npm run build` + `npm run check`; if both pass, commits **only** `src/data/music.json` to
   `main` and pushes. GitHub Actions deploys the site.

## Useful variants

```sh
npm run music:refresh -- --no-push      # regenerate music.json, stop before committing
npm run music:refresh -- --skip-fetch   # rebuild music.json from existing /tmp/replay files
```

## Setup (one time)

```sh
cd scripts/refresh-music
npm install
npx playwright install chromium
```

## Notes

- `src/data/music.json` is the only file the tool is allowed to commit; it refuses to run the
  commit step from any branch other than `main`.
- Replay data for the in-progress year updates as you listen; rerun anytime to pick it up.
- `/tmp/replay/` is cleared on reboot — the script refetches everything, so that's fine.
- If Apple changes their Replay frontend and token extraction breaks, the script fails loudly at
  step 2 with `could not read MusicKit tokens from the page`.

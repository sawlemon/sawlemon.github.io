#!/usr/bin/env node
// Refresh Apple Music Replay data end-to-end:
//   1. Open replay.apple.com in a headed Chromium (persistent profile keeps you logged in).
//   2. Wait for the Apple Music login, then read the MusicKit developer + user tokens (memory only —
//      never logged, never written to disk).
//   3. Discover every Replay year that has data (probing from 2019 to the current year) and fetch
//      year + month summaries into /tmp/replay/.
//   4. Run scripts/build-music-data.py to regenerate src/data/music.json.
//   5. Run the site build + astro check; if clean, commit and push ONLY src/data/music.json.
//
// Usage:  npm run music:refresh            (full run: fetch, build, commit, push)
//         npm run music:refresh -- --no-push   (stop after regenerating music.json)
//         npm run music:refresh -- --skip-fetch (skip steps 1-3; rebuild from existing /tmp/replay)

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REPLAY_DIR = '/tmp/replay';
const PROFILE_DIR = join(HERE, '.profile');
const FIRST_YEAR = 2019;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const PUSH = !args.has('--no-push');
const SKIP_FETCH = args.has('--skip-fetch');

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: REPO, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} exited with ${r.status}`);
  }
}

function sh(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

async function main() {
  mkdirSync(REPLAY_DIR, { recursive: true });

  if (!SKIP_FETCH) {
    await fetchReplayData();
  }

  console.log('\n[4/5] Regenerating src/data/music.json …');
  run('python3', [join(REPO, 'scripts', 'build-music-data.py')]);

  console.log('\n[5/5] Building site …');
  run('npm', ['run', 'build']);
  run('npm', ['run', 'check']);

  const changed = sh('git', ['status', '--porcelain', '--', 'src/data/music.json']);
  if (!changed.out) {
    console.log('\nmusic.json is unchanged — nothing to commit. Done.');
  } else if (!PUSH) {
    console.log('\n--no-push: music.json regenerated but not committed. Review with `git diff src/data/music.json`.');
  } else {
    const branch = sh('git', ['branch', '--show-current']);
    if (branch.out !== 'main') {
      throw new Error(`refusing to push: current branch is "${branch.out}", expected "main"`);
    }
    run('git', ['add', 'src/data/music.json']);
    run('git', ['commit', '-m', 'Refresh Apple Music Replay data']);
    run('git', ['push', 'origin', 'main']);
    console.log('\nPushed. GitHub Actions will deploy the site.');
  }
}

async function fetchReplayData() {
  console.log('[1/5] Opening replay.apple.com …');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://replay.music.apple.com/', { waitUntil: 'domcontentloaded' });

    console.log('[2/5] Waiting for Apple Music login (log in inside the opened browser window) …');
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let authorized = false;
    while (Date.now() < deadline) {
      authorized = await page
        .evaluate(() => window.MusicKit?.getInstance?.()?.isAuthorized === true)
        .catch(() => false);
      if (authorized) break;
      await page.waitForTimeout(2000);
    }
    if (!authorized) throw new Error('timed out waiting for Apple Music login');
    console.log('      logged in ✓');

    const tokens = await page.evaluate(() => {
      const kit = window.MusicKit?.getInstance?.();
      return { dev: kit?.developerToken ?? null, user: kit?.musicUserToken ?? null };
    });
    if (!tokens.dev || !tokens.user) throw new Error('could not read MusicKit tokens from the page');
    // Tokens stay in memory only from here on.

    // Find a real summary URL the page already requested, to reuse its query params.
    const template = await page.evaluate(() => {
      for (const e of performance.getEntriesByType('resource')) {
        if (/amp-api[^/]*\.music\.apple\.com\/v1\/me\/music-summaries\//.test(e.name)) return e.name;
      }
      return null;
    });
    const templateUrl = template || 'https://amp-api.music.apple.com/v1/me/music-summaries/year-2025?l=en-GB';
    const urlFor = (id) => {
      const u = new URL(templateUrl.replace('amp-api-edge', 'amp-api'));
      u.pathname = u.pathname.replace(/music-summaries\/.*$/, `music-summaries/${id}`);
      return u.toString();
    };

    const headers = {
      Authorization: `Bearer ${tokens.dev}`,
      'Media-User-Token': tokens.user,
      Origin: 'https://replay.music.apple.com',
      Referer: 'https://replay.music.apple.com/',
      Accept: 'application/json',
    };
    const get = async (url) => {
      const r = await fetch(url, { headers });
      if (!r.ok) return null; // 404 = no data for that period; anything else handled by caller
      return r.json();
    };

    console.log('[3/5] Discovering Replay years …');
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let y = FIRST_YEAR; y <= currentYear; y++) {
      const data = await get(urlFor(`year-${y}`));
      if (!data?.data?.length) continue;
      years.push(y);
      writeFileSync(join(REPLAY_DIR, `year-${y}.json`), JSON.stringify(data));
      console.log(`      ${y}: ${data.data.length} summary(ies)`);
    }
    if (!years.length) throw new Error('no Replay years returned data — is this account using Apple Music?');

    for (const y of years) {
      for (let m = 1; m <= 12; m++) {
        const id = `month-${y}-${String(m).padStart(2, '0')}`;
        const data = await get(urlFor(id));
        const path = join(REPLAY_DIR, `${id}.json`);
        if (data?.data?.length) writeFileSync(path, JSON.stringify(data));
        else if (existsSync(path)) rmSync(path); // drop stale files from previous runs
      }
      console.log(`      ${y}: months fetched`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

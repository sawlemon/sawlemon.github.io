#!/usr/bin/env node
// Refresh Apple Music Replay data end-to-end:
//   1. Open replay.music.apple.com in a headed Chromium (persistent profile keeps you logged in).
//   2. Wait for the Apple Music login, then capture the app's OWN amp-api requests:
//        - a month summary detail request (fires on load) → month query-param template
//        - a year summary detail request (fires when we switch year via the UI's year dropdown)
//          → year query-param template
//      Both are used verbatim (only the summary id is swapped). Tokens stay in memory; they are
//      never logged or written to disk.
//   3. List available years from the year dropdown options, fetch every year summary + probe
//      months 01-12 for each year in-page. Results land in /tmp/replay/ as year-YYYY.json and
//      month-YYYY-MM.json.
//   4. Run scripts/build-music-data.py to regenerate src/data/music.json.
//   5. Run the site build + astro check; if clean, commit and push ONLY src/data/music.json.
//
// Usage:  npm run music:refresh            (full run: fetch, build, commit, push)
//         npm run music:refresh -- --no-push   (stop after regenerating music.json)
//         npm run music:refresh -- --skip-fetch (skip steps 1-3; rebuild from existing /tmp/replay)

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REPLAY_DIR = '/tmp/replay';
const PROFILE_DIR = join(HERE, '.profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const PUSH = !args.has('--no-push');
const SKIP_FETCH = args.has('--skip-fetch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Every music-summaries request the app makes gets recorded here (URL only; headers are read off
// the individual request objects we care about).
function watchSummaries(page) {
  const seen = [];
  const onReq = (r) => {
    const u = r.url();
    if (/amp-api[^/]*\.music\.apple\.com\/v1\/me\/music-summaries\//.test(u)) {
      seen.push({ url: u, headers: r.headers() });
    }
  };
  page.on('request', onReq);
  return { seen, stop: () => page.off('request', onReq) };
}

const isMonthDetail = (u) => /music-summaries\/month-\d+-\d+\?/.test(u);
const isYearDetail = (u) => /music-summaries\/year-\d{4}\?/.test(u);

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
  console.log('[1/5] Opening replay.music.apple.com …');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 1400 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const watcher = watchSummaries(page);

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

    // The home page fetches the current month's detail on load. Wait for it.
    console.log('[3/5] Capturing the app\'s own API request templates …');
    for (let i = 0; i < 30 && !watcher.seen.some((r) => isMonthDetail(r.url)); i++) {
      await sleep(1000);
    }
    let monthReq = watcher.seen.find((r) => isMonthDetail(r.url));
    if (!monthReq) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 60 && !watcher.seen.some((r) => isMonthDetail(r.url)); i++) {
        await sleep(1000);
      }
      monthReq = watcher.seen.find((r) => isMonthDetail(r.url));
    }
    if (!monthReq) {
      throw new Error('the Replay app never fetched a month summary — is the page loading correctly?');
    }
    const monthTemplate = monthReq.url;
    const headers = monthReq.headers;
    console.log('      month template ✓');

    // Switch year via the UI's year dropdown so the app itself fires a year-detail request
    // with the (undocumented) param set that returns full song/artist/album resources.
    // The dropdown renders a moment after the data loads, so poll for it.
    let yearSelect = null;
    for (let i = 0; i < 40 && !yearSelect; i++) {
      for (const sel of await page.locator('select').all()) {
        const opts = await sel.locator('option').allTextContents().catch(() => []);
        if (opts.some((o) => /^\d{4}$/.test(o.trim()))) {
          yearSelect = sel;
          break;
        }
      }
      if (!yearSelect) await sleep(1500);
    }
    const beforeYears = watcher.seen.filter((r) => isYearDetail(r.url)).length;
    if (!yearSelect) {
      throw new Error(
        'no year dropdown found on the Replay page — Apple may have changed the Replay UI'
      );
    }
    const options = (await yearSelect.locator('option').allTextContents()).map((o) => o.trim());
    const current = (await yearSelect.inputValue().catch(() => '')) || options[0];
    const target = options.filter((o) => o && o !== current).pop(); // most recent other year
    if (!target) {
      throw new Error('year dropdown has no other year to switch to — nothing to capture');
    }
    try {
      await yearSelect.selectOption({ label: target });
    } catch (e) {
      throw new Error(`selecting year "${target}" in the dropdown failed: ${e.message.split('\n')[0]}`);
    }
    await sleep(8000);
    let yearReqs = watcher.seen.filter((r) => isYearDetail(r.url));
    if (yearReqs.length === beforeYears) {
      // One retry: switch to a different year (the first option this time) and wait longer.
      const alt = options.find((o) => o && o !== current && o !== target);
      if (alt) {
        await yearSelect.selectOption({ label: alt }).catch(() => {});
        await sleep(12000);
        yearReqs = watcher.seen.filter((r) => isYearDetail(r.url));
      }
    }
    if (yearReqs.length === beforeYears) {
      throw new Error(
        'switching year did not trigger a year-detail request — Apple may have changed the Replay UI'
      );
    }
    // Unique query-param sets across the year requests, most recent first.
    const yearTemplates = [...new Set(yearReqs.map((r) => r.url.replace(/year-\d{4}/, 'year-ID')))];
    console.log(`      year template(s): ${yearTemplates.length} ✓`);

    // Year list: the dropdown options are exactly the available years.
    const years = options;
    if (!years.length) throw new Error('could not read available years from the year dropdown');
    console.log('      available years:', years.join(', '));

    // Pick the year template that returns full resources; fall back to whatever returns anything.
    const fetchInPage = (url) =>
      page.evaluate(
        async ({ url, headers }) => {
          try {
            const r = await fetch(url, { headers });
            if (!r.ok) return { status: r.status, json: null };
            return { status: r.status, json: await r.json() };
          } catch (e) {
            return { status: 0, json: null, error: e.message };
          }
        },
        { url, headers }
      );

    let chosenYearTemplate = null;
    for (const t of yearTemplates) {
      const probeUrl = t.replace('year-ID', `year-${years[0]}`);
      const res = await fetchInPage(probeUrl);
      const resKeys = res.json?.resources ? Object.keys(res.json.resources) : [];
      if (resKeys.includes('song-period-summaries')) {
        chosenYearTemplate = t;
        break;
      }
      if (res.json?.resources && !chosenYearTemplate) chosenYearTemplate = t;
    }
    if (!chosenYearTemplate) {
      throw new Error('no year-template returned a resources map — Apple may have changed the API');
    }

    // Fetch every year summary.
    const yearsData = [];
    const failures = [];
    for (const year of years) {
      const res = await fetchInPage(chosenYearTemplate.replace('year-ID', `year-${year}`));
      if (res.json?.data?.length) yearsData.push(res.json);
      else failures.push(`year-${year}: HTTP ${res.status}`);
    }
    if (!yearsData.length) {
      throw new Error(`no year summaries returned data (${failures.join(', ')})`);
    }
    for (const json of yearsData) {
      writeFileSync(join(REPLAY_DIR, `${json.data[0].id}.json`), JSON.stringify(json));
    }
    console.log(`      saved years: ${yearsData.map((j) => j.data[0].id).join(', ')}`);

    // Months: probe 01-12 per year with the month template (future/absent months 404 and are skipped).
    const monthPaths = new Set();
    for (const json of yearsData) {
      const year = json.data[0].id.replace('year-', '');
      for (let m = 1; m <= 12; m++) {
        const url = monthTemplate.replace(/month-\d+-\d+/, `month-${year}-${m}`);
        const res = await fetchInPage(url);
        if (res.json?.data?.length) {
          const fname = `month-${year}-${String(m).padStart(2, '0')}.json`;
          writeFileSync(join(REPLAY_DIR, fname), JSON.stringify(res.json));
          monthPaths.add(fname.replace(/\.json$/, ''));
        }
      }
      console.log(`      ${year}: months done`);
    }
    for (const f of readdirSync(REPLAY_DIR)) {
      if (f.startsWith('month-') && !monthPaths.has(f.replace(/\.json$/, ''))) {
        rmSync(join(REPLAY_DIR, f));
      }
    }
    console.log(`      saved months: ${monthPaths.size} total`);
  } finally {
    watcher.stop();
    await ctx.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

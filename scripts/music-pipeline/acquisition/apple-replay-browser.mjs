/**
 * Apple Music Replay acquisition adapter.
 *
 * The only module allowed to know about Playwright, replay.music.apple.com,
 * the persistent browser profile, and the app's own request templates.
 * Everything it writes goes through the snapshot store; everything it
 * returns is secret-free. Tokens stay in browser-process memory and are
 * never logged, hashed, or persisted.
 *
 * The flow is ported verbatim from the original scripts/refresh-music/
 * refresh.mjs (see repo history 385f494 and 6597818): capture the app's
 * own month/year detail requests, switch the year dropdown to trigger the
 * year detail, pick the template whose probe returns full resources, then
 * fetch every dropdown year and months 1-12 for each.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyStatus,
  isMonthDetail,
  isYearDetail,
  buildMonthUrl,
  buildYearUrl,
  pickYearTemplate,
  redactUrl,
  switchTargets,
  yearOptions
} from './replay-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFRESH_PACKAGE = join(HERE, '..', '..', 'refresh-music', 'package.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRY_DELAYS_MS = [1000, 2000, 4000];

function loadChromium() {
  const require = createRequire(REFRESH_PACKAGE);
  return require('playwright').chromium;
}

export function createAppleReplayAdapter({
  profileDir,
  loginTimeoutMs = 10 * 60 * 1000,
  clock = () => Date.now(),
  logger = console,
  chromium
}) {
  return {
    /**
     * Acquires one complete snapshot run.
     * Returns {runId, years, coverage, manifest}. Throws on auth failure,
     * unrecoverable API drift, or a fatal status; partial runs are aborted.
     */
    async acquire({ store, runId }) {
      const chromiumInstance = chromium ?? loadChromium();
      const ctx = await chromiumInstance.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1280, height: 1400 }
      });
      const page = ctx.pages()[0] || (await ctx.newPage());
      const writer = store.begin(runId);

      try {
        // Every music-summaries request the app makes gets recorded (URL +
        // headers for the few requests we actually use; headers stay here).
        const seen = [];
        const onReq = (r) => {
          const u = r.url();
          if (/amp-api[^/]*\.music\.apple\.com\/v1\/me\/music-summaries\//.test(u)) {
            seen.push({ url: u, headers: r.headers() });
          }
        };
        page.on('request', onReq);

        await page.goto('https://replay.music.apple.com/', { waitUntil: 'domcontentloaded' });

        logger.log('[acquire] waiting for Apple Music login (log in inside the opened browser window) …');
        const deadline = clock() + loginTimeoutMs;
        let authorized = false;
        while (clock() < deadline) {
          authorized = await page
            .evaluate(() => window.MusicKit?.getInstance?.()?.isAuthorized === true)
            .catch(() => false);
          if (authorized) break;
          await page.waitForTimeout(2000);
        }
        if (!authorized) throw new Error('timed out waiting for Apple Music login');
        logger.log('      logged in ✓');

        // The home page fetches the current month's detail on load. Wait for
        // it; reload once if the app is slow.
        logger.log('[acquire] capturing the app’s own API request templates …');
        for (let i = 0; i < 30 && !seen.some((r) => isMonthDetail(r.url)); i++) {
          await sleep(1000);
        }
        let monthReq = seen.find((r) => isMonthDetail(r.url));
        if (!monthReq) {
          await page.reload({ waitUntil: 'domcontentloaded' });
          for (let i = 0; i < 60 && !seen.some((r) => isMonthDetail(r.url)); i++) {
            await sleep(1000);
          }
          monthReq = seen.find((r) => isMonthDetail(r.url));
        }
        if (!monthReq) {
          throw new Error('the Replay app never fetched a month summary — is the page loading correctly?');
        }
        const monthTemplate = monthReq.url;
        const headers = monthReq.headers;
        logger.log('      month template ✓');

        // The year dropdown renders a moment after the data loads; poll for it.
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
        if (!yearSelect) {
          throw new Error('no year dropdown found on the Replay page — Apple may have changed the Replay UI');
        }
        const options = (await yearSelect.locator('option').allTextContents()).map((o) => o.trim());
        const current = (await yearSelect.inputValue().catch(() => '')) || options[0];
        const { target, alt } = switchTargets(options, current);
        if (!target) {
          throw new Error('year dropdown has no other year to switch to — nothing to capture');
        }
        const beforeYears = seen.filter((r) => isYearDetail(r.url)).length;
        try {
          await yearSelect.selectOption({ label: target });
        } catch (e) {
          throw new Error(`selecting year "${target}" in the dropdown failed: ${e.message.split('\n')[0]}`);
        }
        await sleep(8000);
        let yearReqs = seen.filter((r) => isYearDetail(r.url));
        if (yearReqs.length === beforeYears && alt) {
          await yearSelect.selectOption({ label: alt }).catch(() => {});
          await sleep(12000);
          yearReqs = seen.filter((r) => isYearDetail(r.url));
        }
        if (yearReqs.length === beforeYears) {
          throw new Error('switching year did not trigger a year-detail request — Apple may have changed the Replay UI');
        }
        // Unique query-param sets across the year requests, most recent first.
        const yearTemplates = [...new Set(yearReqs.map((r) => r.url.replace(/year-\d{4}/, 'year-ID')))];
        logger.log(`      year template(s): ${yearTemplates.length} ✓`);

        const years = yearOptions(options);
        if (!years.length) throw new Error('could not read available years from the year dropdown');
        logger.log('      available years:', years.join(', '));

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

        // Fetch with bounded retries for transient statuses (429/5xx/network).
        const fetchWithRetries = async (url) => {
          let last = { status: 0, json: null };
          for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            last = await fetchInPage(url);
            if (classifyStatus(last.status) !== 'retry') return last;
            if (attempt < RETRY_DELAYS_MS.length) {
              logger.log(`      retrying ${redactUrl(url)} (attempt ${attempt + 2}) …`);
              await sleep(RETRY_DELAYS_MS[attempt]);
            }
          }
          return last;
        };

        const chosenYearTemplate = await pickYearTemplate(yearTemplates, async (template) => {
          const res = await fetchInPage(buildYearUrl(template, years[0]));
          return { status: res.status, json: res.json };
        });
        if (!chosenYearTemplate) {
          throw new Error('no year-template returned a resources map — Apple may have changed the API');
        }

        // Fetch every year summary. A 404 year is recorded absent (warning);
        // anything else that fails is fatal — a partial year run must not
        // reach publication.
        const coverage = { years: [] };
        const manifestYears = [];
        let yearFailures = [];
        for (const year of years) {
          const res = await fetchWithRetries(buildYearUrl(chosenYearTemplate, year));
          const observedAt = new Date().toISOString();
          if (res.json?.data?.length) {
            const id = res.json.data[0].id; // e.g. "year-2024"
            writer.put({ kind: 'year', id: year, name: `${id}.json`, payload: res.json, httpStatus: res.status, observedAt });
            manifestYears.push(year);
          } else if (classifyStatus(res.status) === 'absent') {
            writer.recordAbsent({ kind: 'year', id: year, httpStatus: res.status, observedAt });
            writer.warn(`year ${year}: no summary (HTTP 404)`);
          } else {
            yearFailures.push(`year-${year}: HTTP ${res.status}`);
            break;
          }
        }
        if (yearFailures.length) {
          throw new Error(`year fetch failed (${yearFailures.join(', ')}) — run aborted, previous data untouched`);
        }
        if (!manifestYears.length) {
          throw new Error('no year summaries returned data — run aborted');
        }
        logger.log(`      saved years: ${manifestYears.join(', ')}`);

        // Months: probe 01-12 per year with the month template. Future or
        // empty months 404 and are recorded as explicitly absent.
        let monthsPresent = 0;
        let monthsAbsent = 0;
        for (const year of manifestYears) {
          for (let m = 1; m <= 12; m++) {
            const url = buildMonthUrl(monthTemplate, year, m);
            const res = await fetchWithRetries(url);
            const observedAt = new Date().toISOString();
            const kind = classifyStatus(res.status);
            const padded = String(m).padStart(2, '0');
            if (kind === 'ok' && res.json?.data?.length) {
              writer.put({
                kind: 'month',
                id: `${year}-${padded}`,
                name: `month-${year}-${padded}.json`,
                payload: res.json,
                httpStatus: res.status,
                observedAt
              });
              monthsPresent++;
            } else if (kind === 'absent') {
              writer.recordAbsent({ kind: 'month', id: `${year}-${padded}`, httpStatus: res.status, observedAt });
              monthsAbsent++;
            } else if (kind === 'auth') {
              throw new Error(`Apple authorization rejected a month fetch (HTTP ${res.status}) — run aborted`);
            } else {
              throw new Error(`month fetch failed for ${year}-${padded} (HTTP ${res.status}) — run aborted, previous data untouched`);
            }
          }
          logger.log(`      ${year}: months done`);
        }

        const manifest = writer.commit({
          years: manifestYears,
          coverage: {
            years: manifestYears.length,
            monthsPresent,
            monthsAbsent,
            monthsProbed: manifestYears.length * 12
          }
        });
        logger.log(`      snapshot run committed: ${runId}`);
        return { runId, years: manifestYears, coverage: manifest.coverage, manifest };
      } catch (error) {
        writer.abort();
        throw error;
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  };
}

/**
 * Apple Music Replay request-protocol rules.
 *
 * Pure, browser-free logic extracted from the acquisition adapter so it can
 * be unit tested without Playwright: request matching, URL allowlisting,
 * template construction, status classification, and option/target picking.
 *
 * Security rules enforced here:
 *  - only amp-api*.music.apple.com music-summaries requests are ever matched;
 *  - redacted URLs keep origin+path only (query strings carry tokens);
 *  - year/month substitutions validate their inputs before touching a URL.
 */

export const SUMMARY_REQUEST_RE = /amp-api[^/]*\.music\.apple\.com\/v1\/me\/music-summaries\//;

export const isMonthDetail = (url) => /music-summaries\/month-\d+-\d+\?/.test(url);
export const isYearDetail = (url) => /music-summaries\/year-\d{4}\?/.test(url);

/** Redacted form of a request URL: origin + path, never the query string. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '<invalid-url>';
  }
}

/** How a fetch status should be treated by the acquisition adapter. */
export function classifyStatus(status) {
  if (status === 200) return 'ok';
  if (status === 404) return 'absent';
  if (status === 401 || status === 403) return 'auth';
  if (status === 0 || status === 429 || (typeof status === 'number' && status >= 500)) return 'retry';
  return 'fatal';
}

export function isFourDigitYear(value) {
  return /^\d{4}$/.test(String(value));
}

/**
 * Builds a year summary URL from the captured template.
 * The template keeps the literal `year-ID` placeholder, exactly as the
 * acquisition adapter normalizes the app's own request URLs.
 */
export function buildYearUrl(template, year) {
  if (!isFourDigitYear(year)) throw new Error(`invalid year: ${JSON.stringify(String(year)).slice(0, 20)}`);
  return template.replace('year-ID', `year-${year}`);
}

/**
 * Builds a month summary URL. The URL keeps the app's unpadded month form
 * (`month-2024-3`), while snapshot files use the padded form.
 */
export function buildMonthUrl(template, year, month) {
  if (!isFourDigitYear(year)) throw new Error(`invalid year: ${JSON.stringify(String(year)).slice(0, 20)}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid month: ${JSON.stringify(String(month)).slice(0, 20)}`);
  }
  return template.replace(/month-\d+-\d+/, `month-${year}-${month}`);
}

/**
 * Picks the year template that returns full resources (the app's own
 * detail-request param set). `probe(template)` returns {status, json}.
 * Preference: a resources map containing song-period-summaries, then the
 * first template returning any resources map. Returns null when nothing
 * qualifies.
 */
export async function pickYearTemplate(templates, probe) {
  let firstWithResources = null;
  for (const template of templates) {
    const { status, json } = await probe(template);
    if (status !== 200 || !json) continue;
    const resourceKeys = json.resources ? Object.keys(json.resources) : [];
    if (resourceKeys.includes('song-period-summaries')) return template;
    if (json.resources && !firstWithResources) firstWithResources = template;
  }
  return firstWithResources;
}

/**
 * Picks which dropdown options to switch to in order to trigger the app's
 * own year-detail request. Mirrors the working acquisition flow: switch to
 * the most recent other year first, retry with the first other year.
 */
export function switchTargets(options, current) {
  const others = options.filter((o) => o && o !== current);
  const target = others.pop() ?? null;
  const alt = others.find((o) => o && o !== target) ?? null;
  return { target, alt };
}

/** Year labels for the snapshot manifest, from dropdown option texts. */
export function yearOptions(options) {
  return options.map((o) => String(o).trim()).filter((o) => /^\d{4}$/.test(o));
}

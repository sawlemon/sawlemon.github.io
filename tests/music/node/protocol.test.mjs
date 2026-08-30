import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthUrl,
  buildYearUrl,
  classifyStatus,
  pickYearTemplate,
  redactUrl,
  switchTargets,
  yearOptions
} from '../../../scripts/music-pipeline/acquisition/replay-protocol.mjs';

test('classifies Replay response statuses', () => {
  assert.equal(classifyStatus(200), 'ok');
  assert.equal(classifyStatus(404), 'absent');
  assert.equal(classifyStatus(401), 'auth');
  assert.equal(classifyStatus(403), 'auth');
  assert.equal(classifyStatus(429), 'retry');
  assert.equal(classifyStatus(503), 'retry');
  assert.equal(classifyStatus(0), 'retry');
  assert.equal(classifyStatus(400), 'fatal');
});

test('redacts query strings from request URLs', () => {
  assert.equal(
    redactUrl('https://amp-api.music.apple.com/v1/me/music-summaries/year-2024?views=foo&token=secret'),
    'https://amp-api.music.apple.com/v1/me/music-summaries/year-2024'
  );
  assert.equal(redactUrl('not a url'), '<invalid-url>');
});

test('validates and substitutes year/month templates', () => {
  const year = 'https://amp-api.music.apple.com/v1/me/music-summaries/year-ID?views=all';
  const month = 'https://amp-api.music.apple.com/v1/me/music-summaries/month-2024-1?views=all';
  assert.equal(buildYearUrl(year, '2024'), 'https://amp-api.music.apple.com/v1/me/music-summaries/year-2024?views=all');
  assert.equal(buildMonthUrl(month, '2024', 3), 'https://amp-api.music.apple.com/v1/me/music-summaries/month-2024-3?views=all');
  assert.throws(() => buildYearUrl(year, '24'));
  assert.throws(() => buildMonthUrl(month, '2024', 13));
});

test('selects a full-resource year template', async () => {
  const templates = ['one', 'two', 'three'];
  const chosen = await pickYearTemplate(templates, async (template) => ({
    status: 200,
    json: template === 'two' ? { resources: { 'song-period-summaries': {} } } : { resources: { artists: {} } }
  }));
  assert.equal(chosen, 'two');
});

test('falls back to the first template with resources', async () => {
  const chosen = await pickYearTemplate(['one', 'two'], async () => ({ status: 200, json: { resources: { artists: {} } } }));
  assert.equal(chosen, 'one');
  assert.equal(await pickYearTemplate(['one'], async () => ({ status: 500, json: null })), null);
});

test('chooses year-switch retry targets and filters options', () => {
  assert.deepEqual(switchTargets(['2026', '2025', '2024'], '2026'), { target: '2024', alt: '2025' });
  assert.deepEqual(switchTargets(['2026'], '2026'), { target: null, alt: null });
  assert.deepEqual(yearOptions([' 2026 ', 'Replay', '2025']), ['2026', '2025']);
});

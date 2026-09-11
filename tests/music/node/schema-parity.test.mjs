/**
 * Schema/validator parity for the Replay snapshot-manifest contract.
 *
 * contracts/raw-snapshot.schema.json and the authoritative Python validator
 * (canonicalize/validate.py: validate_raw_manifest) agree only by
 * construction; this suite pins that agreement. It compiles the real schema
 * in strict draft-2020-12 mode with ajv-formats' full date-time
 * implementation and evaluates the same shared corpus of manifests that
 * tests/music/python/test_schema_parity.py feeds to the Python validator,
 * so a future drift between the two either breaks a case here, breaks a
 * case there, or is caught by the Python-side diagnostic tests.
 *
 * Known edges that cannot live in the shared corpus (documented, and pinned
 * Python-side in tests/music/python/test_validate.py where applicable):
 * - JSON floats: `1.0`/`2.0` in JSON text parse as 1/2 in JavaScript, so
 *   "is it a JSON integer?" is unobservable here. The Python validator
 *   rejects float-encoded integers; JSON Schema's `integer`/`const` treat
 *   them as equal numbers. Pinned Python-side (schemaVersion 1.0,
 *   httpStatus 2.0).
 * - Timestamps with year 0000: ajv-formats accepts them (RFC 3339 allows a
 *   four-digit year 0000); Python's stdlib datetime cannot represent year
 *   0 and rejects them. No Replay data can predate Apple Music; Python
 *   (the promotion gate) keeps the stricter behavior. Pinned Python-side.
 * - Control-character whitespace: Python's str.strip() treats \x1c-\x1f as
 *   whitespace (rejects a runId of \x1c) while ECMA-262 \s does not, and
 *   the reverse holds for a leading \ufeff. Both directions are outside
 *   any realistic input; Python stays authoritative for the promotion gate.
 *
 * The schema's date-time pattern deliberately pins the RFC 3339 ABNF
 * (mandatory T separator, colon-separated offset) that both sides enforce;
 * see the $comment next to it in the schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SCHEMA_PATH = join(REPO, 'scripts', 'music-pipeline', 'contracts', 'raw-snapshot.schema.json');
const CORPUS_PATH = join(REPO, 'tests', 'music', 'fixtures', 'manifest-cases.json');

/**
 * Compiles the actual contract schema in strict mode. ajv's draft-2020-12
 * class is required for the schema's `$schema` declaration, and ajv-formats
 * is required for `format: date-time` to assert rather than annotate; the
 * "full" mode is the strict, calendar-aware implementation.
 */
function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv, { formats: ['date-time'], mode: 'full' });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  return ajv.compile(schema);
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));

test('parity corpus is well-formed', () => {
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0, 'corpus must list cases');
  const names = new Set();
  for (const entry of corpus.cases) {
    assert.ok(typeof entry.name === 'string' && entry.name !== '', 'case needs a stable name');
    assert.ok(!names.has(entry.name), `duplicate case name: ${entry.name}`);
    names.add(entry.name);
    assert.ok('manifest' in entry, `case ${entry.name} needs a manifest`);
    assert.ok(typeof entry.valid === 'boolean', `case ${entry.name} needs a boolean valid flag`);
  }
});

test('schema compiles in strict draft-2020-12 mode with date-time formats', () => {
  const validate = compileSchema();
  assert.equal(typeof validate, 'function');
});

for (const entry of corpus.cases) {
  const expectation = entry.valid ? 'valid' : 'invalid';
  test(`schema: ${entry.name} is ${expectation}`, () => {
    const validate = compileSchema();
    const accepted = validate(entry.manifest);
    assert.equal(
      accepted,
      entry.valid,
      accepted
        ? `expected ${expectation}, but the schema accepted it`
        : `expected ${expectation}, but the schema rejected it: ${JSON.stringify(validate.errors, null, 1)}`
    );
    if (!entry.valid) {
      assert.ok(validate.errors.length > 0, 'an invalid case must produce at least one error');
    }
  });
}

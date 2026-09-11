/**
 * Manifest contract check (Node/Python boundary).
 *
 * The authoritative snapshot-manifest contract lives in
 * scripts/music-pipeline/canonicalize/validate.py (mirrored by
 * scripts/music-pipeline/contracts/raw-snapshot.schema.json). Rather than
 * duplicating it in JavaScript, promotion runs the same Python validator
 * CLI that CI uses. Diagnostics are structured, secret-free, and never
 * contain payload fragments.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const VALIDATOR_SCRIPT = resolve(HERE, '..', 'canonicalize', 'validate.py');

export class ManifestValidationError extends Error {
  constructor(message, { diagnostics = '' } = {}) {
    super(message);
    this.name = 'ManifestValidationError';
    this.code = 'manifest-invalid';
    this.diagnostics = diagnostics;
  }
}

/**
 * Validates a manifest file with the Python contract validator.
 * Resolves (returns) when the manifest is valid; throws
 * ManifestValidationError when it is not, or when the validator itself
 * cannot run.
 */
export function validateManifestFile(manifestPath, { python = 'python3', validatorScript = VALIDATOR_SCRIPT } = {}) {
  const result = spawnSync(python, [validatorScript, '--input', manifestPath], { encoding: 'utf8' });
  if (result.error) {
    throw new ManifestValidationError(`manifest validator could not run (${python}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const diagnostics = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    const first = diagnostics.split('\n').find(Boolean) ?? 'no diagnostics';
    throw new ManifestValidationError(`manifest failed validation before promotion: ${first}`, { diagnostics });
  }
  return true;
}

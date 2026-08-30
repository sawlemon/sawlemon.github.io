#!/usr/bin/env node
/**
 * Backward-compatible Apple Music Replay entrypoint.
 * The implementation now lives in scripts/music-pipeline/; this file keeps
 * existing npm run music:refresh invocations working.
 */
import '../music-pipeline/cli.mjs';

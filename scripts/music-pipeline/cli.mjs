#!/usr/bin/env node
import { HELP, parseArgs } from './config.mjs';
import { planOffline, refresh } from './orchestrator.mjs';

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  try {
    if (options.plan || options.dryRun) {
      planOffline({ snapshotDir: options.snapshotDir, runId: options.runId });
    } else {
      await refresh(options);
    }
  } catch (error) {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();

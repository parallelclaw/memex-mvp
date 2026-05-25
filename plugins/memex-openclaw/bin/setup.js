#!/usr/bin/env node
/**
 * Standalone fallback for `openclaw memex-openclaw setup`. Lets you
 * run the orchestrator without OpenClaw's CLI plumbing — useful for:
 *   - CI scripts that test the plugin without spinning up OpenClaw
 *   - users on OpenClaw versions where api.registerCli isn't available
 *   - debugging where you want the orchestrator to run in isolation
 *
 * Argument flags mirror the in-OpenClaw subcommand:
 *   --json --no-backfill --no-auto-restart --force
 *   --restart-delay <N> --since <date> --memex-db <path>
 *   --config <path> --agents-dir <path>
 */

import { argv, exit } from 'node:process';
import { MemexStore } from '../lib/store.js';
import { runSetup, printSetupReport } from './setup-impl.js';

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eat = () => argv[++i];
    switch (a) {
      case '--json':            opts.json = true; break;
      case '--no-backfill':     opts.noBackfill = true; break;
      case '--no-auto-restart': opts.noAutoRestart = true; break;
      case '--force':           opts.force = true; break;
      case '--restart-delay':   opts.restartDelay = parseInt(eat(), 10) || 3; break;
      case '--since':           opts.since = eat(); break;
      case '--memex-db':        opts.memexDb = eat(); break;
      case '--config':          opts.configPath = eat(); break;
      case '--agents-dir':      opts.agentsDir = eat(); break;
      case '-h':
      case '--help':
        process.stdout.write(
`memex-openclaw-setup — one-shot setup orchestrator

Wires ~/.openclaw/openclaw.json (plugin + MCP), backfills session history
into memex.db, optionally schedules a self-restart of the gateway.

Flags:
  --json                      machine-parseable JSON instead of human summary
  --no-backfill               skip importing past OpenClaw sessions
  --no-auto-restart           detect restart mechanism but do not trigger it
  --force                     overwrite a conflicting mcp.servers.memex
  --restart-delay <seconds>   seconds before triggering self-restart (default 3)
  --since <date>              YYYY-MM-DD or unix epoch — limit backfill
  --memex-db <path>           override memex.db location
  --config <path>             override openclaw.json location
  --agents-dir <path>         override agents/ directory location

Exit codes:
  0   ready or already_in_sync
  1   partial (missing memex / conflict — review the report)
  2   failed (couldn't read/write openclaw.json — manual intervention)
`,
        );
        exit(0);
        break;
      default:
        process.stderr.write(`unknown flag: ${a}\n`);
        exit(64);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(argv);
  const store = new MemexStore(opts.memexDb);
  try {
    const report = runSetup(store, opts);
    printSetupReport(report, { json: !!opts.json });
    if (report.status === 'failed') exit(2);
    if (report.status === 'partial') exit(1);
    exit(0);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`memex-openclaw-setup: ${err.stack || err.message}\n`);
  exit(2);
});

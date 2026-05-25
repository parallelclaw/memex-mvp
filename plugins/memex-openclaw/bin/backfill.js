#!/usr/bin/env node
/**
 * Standalone fallback for `openclaw memex-openclaw backfill`. Same
 * pattern as bin/setup.js — see that file for context.
 *
 * Flags:
 *   --json --dry-run --since <date> --agents-dir <path>
 *   --memex-db <path> --ignore-watermark
 */

import { argv, exit } from 'node:process';
import { MemexStore } from '../lib/store.js';
import { runBackfill } from '../lib/backfill.js';

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eat = () => argv[++i];
    switch (a) {
      case '--json':              opts.json = true; break;
      case '--dry-run':           opts.dryRun = true; break;
      case '--ignore-watermark':  opts.ignoreWatermark = true; break;
      case '--since':             opts.since = eat(); break;
      case '--agents-dir':        opts.agentsDir = eat(); break;
      case '--memex-db':          opts.memexDb = eat(); break;
      case '-h':
      case '--help':
        process.stdout.write(
`memex-openclaw-backfill — import OpenClaw session history into memex.db

Reads ~/.openclaw/agents/*/sessions/*.jsonl, parses each primary
session file (checkpoints + trajectories skipped), inserts user +
assistant turns into memex.db using the same conv_id formula as live
capture, so UNIQUE dedup handles all overlap. Per-agent watermark
means re-runs are O(0) after the first successful run.

Flags:
  --json                  JSON output instead of human summary
  --dry-run               predict counts without writing
  --since <date>          YYYY-MM-DD or unix epoch
  --agents-dir <path>     override ~/.openclaw/agents/
  --memex-db <path>       override memex.db location
  --ignore-watermark      process all sessions, including ones already imported
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
    const result = runBackfill(store, opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(
        `backfill: ${result.status}\n` +
        `  agents scanned:           ${result.agents_scanned}\n` +
        `  sessions seen:            ${result.sessions_seen}\n` +
        `  sessions processed:       ${result.sessions_processed}\n` +
        `  sessions skipped (mark):  ${result.sessions_skipped_watermark}\n` +
        `  messages imported:        ${result.messages_imported}\n` +
        `  messages skipped (dup):   ${result.messages_skipped_dup}\n` +
        (result.errors.length ? `  errors:                  ${result.errors.length}\n` : '') +
        `  next_action:              ${result.next_action}\n`,
      );
    }
    exit(0);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`memex-openclaw-backfill: ${err.stack || err.message}\n`);
  exit(1);
});

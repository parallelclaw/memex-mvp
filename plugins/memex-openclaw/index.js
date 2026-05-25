/**
 * memex-openclaw — OpenClaw plugin that captures every turn verbatim
 * into the memex unified SQLite corpus.
 *
 * v0.1.1 changes from 0.1.0:
 *   • Removed `kind: "memory"` — conflicted with memory-core's exclusive
 *     memory slot (bug 3 from 2026-05-21 VPS test report).
 *   • Replaced `registerMemoryCorpusSupplement` with `api.registerTool`
 *     — corpus supplement API is not exported to external (npm) plugins
 *     in OpenClaw 2026.5.x (bug 2).
 *   • Hardened defensive logging: writes to /tmp/memex-openclaw-debug.log
 *     at the very first line of register() so we can verify register()
 *     fires at all on gateway restart (bug 1 diagnostic instrumentation).
 *
 * @see openclaw.plugin.json for manifest
 * @see package.json for npm distribution
 */

import {
  definePluginEntry,
  buildJsonPluginConfigSchema,
} from 'openclaw/plugin-sdk/core';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { MemexStore } from './lib/store.js';
import { deriveConvId, deriveMsgId, extractText } from './lib/conv_id.js';
import { registerMemexTools } from './lib/tools.js';

// v0.1.5: read OUR package.json version dynamically instead of hard-coding
// a string. Pre-0.1.5 the activated-log message claimed "v0.1.1" forever
// because the constant was forgotten across releases — confusing on VPS
// where users sanity-check the version from the gateway log. Reading from
// package.json (synchronously, at module load) guarantees the logged
// version always matches the installed package.
const _require = createRequire(import.meta.url);
let PLUGIN_VERSION = 'unknown';
try {
  // package.json sits in the same dir as index.js — resolved relative to
  // this file's location so it works whether the plugin is bundled or
  // installed via npm under ~/.openclaw/npm/node_modules/.
  PLUGIN_VERSION = _require('./package.json').version || 'unknown';
} catch {
  /* fall through with 'unknown' — diag-only, must not crash plugin load */
}

// v0.1.1 BUG-1 DIAGNOSTIC: trace register() invocations to a file the
// user can grep. v0.1.0 had a problem where register() was called
// during `openclaw plugins install` but NOT on `gateway restart` for
// external (npm-installed) plugins. This trace will tell us if the
// problem persists in 0.1.1 or got fixed by changes to manifest.
function traceRegister(msg) {
  try {
    appendFileSync(
      '/tmp/memex-openclaw-debug.log',
      `[${new Date().toISOString()}] ${msg}\n`,
      { mode: 0o644 },
    );
  } catch {
    /* /tmp not writable? whatever — diag-only */
  }
}

traceRegister('module loaded (top-level)');

// v0.1.2: configSchema is REQUIRED by OpenClaw 2026.5+ plugin manifest
// validator. Bug 5 from the 2026-05-22 VPS test. Even plugins with no
// real config need to declare a (possibly empty) schema. We expose one
// optional field — `dbPath` — for users who want memex.db at a custom
// location.
const CONFIG_SCHEMA = buildJsonPluginConfigSchema({
  type: 'object',
  properties: {
    dbPath: {
      type: 'string',
      title: 'memex.db path',
      description:
        'Override location of the memex SQLite file. Default is ' +
        '~/.memex/data/memex.db (shared with memex-mvp + memex-hermes).',
      default: '~/.memex/data/memex.db',
    },
  },
  additionalProperties: false,
});

export default definePluginEntry({
  id: 'memex-openclaw',
  name: 'Memex',
  description:
    'Captures every OpenClaw turn verbatim into the memex unified SQLite corpus. ' +
    'Pair with memex-mvp (npm) to search OpenClaw + Hermes + Claude Code + Telegram from one place.',
  configSchema: CONFIG_SCHEMA,

  register(api) {
    traceRegister('register() called — gateway recognised plugin');

    const logger = api.logger;
    const cfg = api.pluginConfig || {};
    let store;

    try {
      store = new MemexStore(cfg.dbPath);
      const initialCount = store.count();
      logger.info(
        `memex-openclaw: opened ${store.dbPath} (current rows: ${initialCount})`,
      );
      traceRegister(`store opened: ${store.dbPath}, rows=${initialCount}`);
    } catch (err) {
      logger.error(`memex-openclaw: failed to open memex.db: ${err.message}`);
      traceRegister(`store open FAILED: ${err.message}`);
      // v0.1.1: do NOT early-return. We still register tools (even if they
      // fail later) so the user can see the plugin is at least live and
      // diagnose. Capture hooks will no-op cleanly if store is null.
    }

    // ------------------------------------------------------------
    // 1. Primary capture — every successful turn
    // ------------------------------------------------------------
    api.on('agent_end', async (event, ctx) => {
      if (!store) return;
      if (!event?.success) return;
      try {
        const platform = ctx?.messageProvider || 'unknown';
        const channelId = ctx?.channelId;
        const sessionId = ctx?.sessionId;
        const agentId = ctx?.agentId || 'main';
        const convId = deriveConvId({
          messageProvider: platform,
          channelId,
          sessionId,
        });

        // Capture only the LAST TURN's user + assistant messages.
        // OpenClaw passes full history but earlier turns were already
        // captured by prior agent_end invocations; UNIQUE dedup makes
        // re-insertion harmless but wasteful.
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const lastTurn = messages.slice(-2);
        const baseTs = Math.floor(Date.now() / 1000);

        for (let i = 0; i < lastTurn.length; i++) {
          const msg = lastTurn[i];
          if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
          const text = extractText(msg);
          if (!text || !text.trim()) continue;

          store.insertMessage({
            conversationId: convId,
            msgId: deriveMsgId({ role: msg.role, text, convId }),
            role: msg.role,
            text,
            ts: baseTs + i,
            channel: platform,
            metadata: {
              raw_type: 'openclaw-agent-end',
              session_id: sessionId,
              agent_id: agentId,
              platform,
              channel_id: channelId,
              model_provider: ctx?.modelProviderId,
              model_id: ctx?.modelId,
              run_id: event.runId,
            },
          });
        }

        store.upsertConversation({
          conversationId: convId,
          title: convId,
          firstTs: baseTs,
          lastTs: baseTs,
        });
      } catch (err) {
        logger.error(`memex-openclaw: agent_end capture failed: ${err.message}`);
      }
    });

    // ------------------------------------------------------------
    // 2. Preserve messages before they're compacted out of context
    // ------------------------------------------------------------
    api.on('before_compaction', async (event, ctx) => {
      if (!store) return;
      try {
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        if (messages.length === 0) return;

        const platform = ctx?.messageProvider || 'unknown';
        const channelId = ctx?.channelId;
        const sessionId = ctx?.sessionId;
        const convId = deriveConvId({
          messageProvider: platform,
          channelId,
          sessionId,
        });
        const baseTs = Math.floor(Date.now() / 1000);

        let saved = 0;
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
          const text = extractText(msg);
          if (!text || !text.trim()) continue;
          const wrote = store.insertMessage({
            conversationId: convId,
            msgId: deriveMsgId({ role: msg.role, text, convId }),
            role: msg.role,
            text,
            ts: baseTs + i,
            channel: platform,
            metadata: {
              raw_type: 'openclaw-pre-compaction',
              session_id: sessionId,
              platform,
              channel_id: channelId,
            },
          });
          if (wrote) saved++;
        }
        if (saved > 0) {
          logger.info(
            `memex-openclaw: preserved ${saved} message(s) before compaction (conv=${convId})`,
          );
        }
      } catch (err) {
        logger.error(`memex-openclaw: before_compaction failed: ${err.message}`);
      }
    });

    // ------------------------------------------------------------
    // 3. Session-end safety net
    // ------------------------------------------------------------
    api.on('session_end', async (event, ctx) => {
      if (!store) return;
      try {
        const platform = ctx?.messageProvider || 'unknown';
        const channelId = ctx?.channelId;
        const sessionId = event?.sessionId || ctx?.sessionId;
        const convId = deriveConvId({
          messageProvider: platform,
          channelId,
          sessionId,
        });
        store.upsertConversation({
          conversationId: convId,
          title: convId,
          lastTs: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        logger.error(`memex-openclaw: session_end failed: ${err.message}`);
      }
    });

    // ------------------------------------------------------------
    // 4. Register tools the LLM can call directly
    //    (v0.1.1: replaces registerMemoryCorpusSupplement which is
    //    not exported to external plugins in OpenClaw 2026.5.x)
    //
    //    v0.2.0 note: api.registerTool DOES register an RPC tool in
    //    OpenClaw's gateway registry, but for NON-bundled plugins
    //    those tools are NOT exposed to the LLM toolset. The LLM
    //    sees memex tools via the memex MCP server wired into
    //    `mcp.servers.memex` (done by `setup` below). registerTool
    //    here remains useful for direct RPC calls from other plugins
    //    on the same gateway — zero maintenance cost to keep.
    // ------------------------------------------------------------
    if (store) {
      try {
        registerMemexTools(api, store, logger);
        traceRegister('tools registered: memex_search, memex_get');
      } catch (err) {
        logger.error(`memex-openclaw: tool registration failed: ${err.message}`);
        traceRegister(`tool registration FAILED: ${err.message}`);
      }
    } else {
      logger.warn('memex-openclaw: store unavailable, skipping tool registration');
    }

    // ------------------------------------------------------------
    // 5. Register CLI subcommands so users (or LLM agents driving the
    //    install) can run `openclaw memex-openclaw setup` and
    //    `openclaw memex-openclaw backfill` as one-shot orchestrators.
    //
    //    OpenClaw's plugin SDK exposes api.registerCli; the callback
    //    receives a ctx with a commander-compatible `program` we can
    //    add subcommands to. We ALSO ship a standalone npm bin
    //    (memex-openclaw-setup / memex-openclaw-backfill) as a
    //    fallback path — see package.json `bin` — for CI scripts or
    //    sanity testing without OpenClaw's CLI plumbing.
    // ------------------------------------------------------------
    if (typeof api.registerCli === 'function') {
      try {
        api.registerCli(async (ctx) => {
          // Lazy import — keeps the plugin's hot path slim. setup.js
          // pulls in subprocess + fs helpers we don't need until the
          // user actually runs setup.
          const { runSetup, printSetupReport } = await import('./lib/setup.js');
          const { runBackfill } = await import('./lib/backfill.js');

          ctx.program
            .command('setup')
            .description(
              'One-shot: wire openclaw.json (plugin + MCP), backfill ' +
              'OpenClaw session history into memex.db, and (optionally) ' +
              'schedule a self-restart of the gateway.',
            )
            .option('--json', 'emit machine-parseable JSON instead of human summary')
            .option('--no-backfill', 'skip importing past OpenClaw sessions')
            .option('--no-auto-restart', 'detect restart mechanism but do not trigger it')
            .option('--force', 'overwrite a conflicting mcp.servers.memex entry')
            .option('--restart-delay <seconds>', 'seconds before triggering self-restart', '3')
            .option('--since <date>', 'YYYY-MM-DD or unix epoch — limit backfill to recent sessions')
            .option('--memex-db <path>', 'override memex.db location')
            .option('--config <path>', 'override ~/.openclaw/openclaw.json location')
            .option('--agents-dir <path>', 'override ~/.openclaw/agents/ location')
            .action(async (opts) => {
              // Use the SAME store instance the plugin opened, so
              // backfill writes are visible to subsequent live capture
              // without reopen.
              const report = runSetup(store, {
                configPath: opts.config,
                noBackfill: opts.backfill === false,
                noAutoRestart: opts.autoRestart === false,
                force: !!opts.force,
                restartDelay: parseInt(opts.restartDelay, 10) || 3,
                since: opts.since,
                agentsDir: opts.agentsDir,
              });
              printSetupReport(report, { json: !!opts.json });
            });

          ctx.program
            .command('backfill')
            .description(
              'Import OpenClaw session history (~/.openclaw/agents/<name>/sessions/*.jsonl) ' +
              'into memex.db. Idempotent — re-runs skip already-processed sessions.',
            )
            .option('--json', 'emit JSON instead of human summary')
            .option('--dry-run', 'predict counts without writing')
            .option('--since <date>', 'YYYY-MM-DD or unix epoch')
            .option('--agents-dir <path>', 'override ~/.openclaw/agents/')
            .option('--ignore-watermark', 'process all sessions regardless of last-import time')
            .action(async (opts) => {
              const result = runBackfill(store, {
                dryRun: !!opts.dryRun,
                since: opts.since,
                agentsDir: opts.agentsDir,
                ignoreWatermark: !!opts.ignoreWatermark,
              });
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
            });
        });
        traceRegister('CLI subcommands registered: setup, backfill');
      } catch (err) {
        // CLI registration is non-critical — capture still works.
        logger.warn(`memex-openclaw: CLI registration failed: ${err.message}`);
        traceRegister(`CLI registration FAILED: ${err.message}`);
      }
    } else {
      // Older OpenClaw without registerCli — fall back to the npm bin
      // (memex-openclaw-setup) which calls the same library code.
      traceRegister('api.registerCli unavailable — use the standalone bin instead');
    }

    // ------------------------------------------------------------
    // 6. v0.2.0: Auto-backfill on startup — silent, idempotent.
    //
    //    Why: zero-click UX. Even if the user installs the plugin
    //    without running `setup` (e.g. they used a custom install
    //    flow), the next gateway start will pull pre-install history
    //    into memex.db. Watermark in plugin_state ensures it's a
    //    millisecond-level no-op on subsequent restarts.
    //
    //    Why setImmediate, not synchronous: the gateway is still
    //    bringing other plugins up. Don't make memex-openclaw the
    //    plugin that delays everyone else's load by reading hundreds
    //    of JSONL files on startup. setImmediate yields to the
    //    event loop; backfill happens in the background.
    //
    //    Why we still keep `setup --force` + `backfill --ignore-watermark`
    //    (via api.registerCli + bin/*) — for power users who want to
    //    re-import, or for the install-memex-claw skill which can't
    //    rely on startup auto-backfill having run yet.
    // ------------------------------------------------------------
    if (store) {
      setImmediate(async () => {
        try {
          const { runBackfill } = await import('./lib/backfill.js');
          const result = runBackfill(store, {});
          if (result.messages_imported > 0) {
            logger.info(
              `memex-openclaw: startup auto-backfill — `
              + `imported ${result.messages_imported} messages from `
              + `${result.sessions_processed} session(s)`,
            );
            traceRegister(
              `startup auto-backfill: ${result.messages_imported} imported`,
            );
          } else if (result.status === 'no_history') {
            traceRegister('startup auto-backfill: no_history');
          } else {
            // Already in sync — skip log noise, only trace.
            traceRegister('startup auto-backfill: already in sync');
          }
        } catch (err) {
          // Backfill is non-essential at startup — live capture works
          // regardless. Surface the failure but don't propagate.
          logger.warn(
            `memex-openclaw: startup auto-backfill failed: ${err.message}`,
          );
          traceRegister(`startup auto-backfill FAILED: ${err.message}`);
        }
      });
    }

    logger.info(`memex-openclaw: plugin activated (v${PLUGIN_VERSION})`);
    traceRegister('register() returned — hooks active');
  },
});

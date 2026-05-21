/**
 * memex-openclaw — OpenClaw plugin that captures every turn verbatim
 * into the memex unified SQLite corpus.
 *
 * Replaces the v0.11.x file-watcher daemon approach. This plugin:
 *   • Subscribes to `agent_end` for per-turn capture — no file watching
 *   • Subscribes to `before_compaction` to preserve messages before
 *     they're dropped from active context
 *   • Subscribes to `session_end` as a safety-net flush
 *   • Registers a `MemoryCorpusSupplement` so the model's built-in
 *     `memory_search` tool sees memex content alongside workspace memory
 *
 * Channel detection: zero parsing. OpenClaw 2026.5+ hands us
 * `ctx.messageProvider` (e.g. "telegram") and `ctx.channelId` (e.g.
 * "97592799") directly in the hook context.
 *
 * Storage: ~/.memex/data/memex.db (override via plugin config db_path).
 * Schema parity with memex-mvp (npm) and memex-hermes (pip) — all three
 * write to the same database with the same UNIQUE-constraint dedup.
 *
 * @see openclaw.plugin.json for manifest
 * @see package.json for npm distribution
 */

import {
  definePluginEntry,
  registerMemoryCorpusSupplement,
} from 'openclaw/plugin-sdk/core';

import { MemexStore } from './lib/store.js';
import { deriveConvId, deriveMsgId, extractText } from './lib/conv_id.js';
import { buildCorpusSupplement } from './lib/corpus_supplement.js';

export default definePluginEntry({
  id: 'memex-openclaw',
  name: 'Memex',
  description:
    'Captures every OpenClaw turn verbatim into the memex unified SQLite corpus. ' +
    'Pair with memex-mvp (npm) to search OpenClaw + Hermes + Claude Code + Telegram from one place.',
  kind: 'memory',

  register(api) {
    const logger = api.logger;
    const cfg = api.pluginConfig || {};
    let store;

    try {
      store = new MemexStore(cfg.dbPath);
      logger.info(`memex-openclaw: opened ${store.dbPath} (current rows: ${store.count()})`);
    } catch (err) {
      logger.error(`memex-openclaw: failed to open memex.db: ${err.message}`);
      return; // can't operate without store
    }

    // -------------------------------------------------------------
    // 1. Primary capture — every turn that completes successfully
    // -------------------------------------------------------------
    api.on('agent_end', async (event, ctx) => {
      if (!event?.success) return; // failed turns are skipped (LLM error, etc.)
      try {
        const platform = ctx?.messageProvider || 'unknown';
        const channelId = ctx?.channelId;
        const sessionId = ctx?.sessionId;
        const agentId = ctx?.agentId || 'main';
        const convId = deriveConvId({ messageProvider: platform, channelId, sessionId });

        // Capture only the LAST TURN's user + assistant messages —
        // earlier history was captured by prior agent_end invocations.
        // (OpenClaw passes full conversation history but most of it is
        // already in memex.db from previous turns; UNIQUE dedup makes
        // re-inserting harmless but wasteful.)
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const lastTurn = messages.slice(-2);

        const baseTs = Math.floor(Date.now() / 1000);
        for (let i = 0; i < lastTurn.length; i++) {
          const msg = lastTurn[i];
          if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
          const text = extractText(msg);
          if (!text || !text.trim()) continue;

          const msgId = deriveMsgId({ role: msg.role, text, convId });
          store.insertMessage({
            conversationId: convId,
            msgId,
            role: msg.role,
            text,
            ts: baseTs + i, // tiny offset to preserve order
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

        // Keep conversations.last_ts current.
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

    // -------------------------------------------------------------
    // 2. Preserve messages before they're compacted out of context
    // -------------------------------------------------------------
    api.on('before_compaction', async (event, ctx) => {
      try {
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        if (messages.length === 0) return;

        const platform = ctx?.messageProvider || 'unknown';
        const channelId = ctx?.channelId;
        const sessionId = ctx?.sessionId;
        const convId = deriveConvId({ messageProvider: platform, channelId, sessionId });

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

    // -------------------------------------------------------------
    // 3. Session-end safety net — flush the full final history
    // -------------------------------------------------------------
    api.on('session_end', async (event, ctx) => {
      try {
        // session_end doesn't carry messages[] in OpenClaw 2026.5 —
        // we have sessionId + sessionKey + reason. The hook serves as
        // a marker that this conv is "done"; we update conv last_ts
        // and let agent_end captures already-in-DB stand.
        const platform = ctx?.messageProvider || 'unknown';
        const channelId = ctx?.channelId;
        const sessionId = event?.sessionId || ctx?.sessionId;
        const convId = deriveConvId({ messageProvider: platform, channelId, sessionId });
        store.upsertConversation({
          conversationId: convId,
          title: convId,
          lastTs: Math.floor(Date.now() / 1000),
        });
        logger.debug(`memex-openclaw: session_end conv=${convId} reason=${event?.reason}`);
      } catch (err) {
        logger.error(`memex-openclaw: session_end failed: ${err.message}`);
      }
    });

    // -------------------------------------------------------------
    // 4. Expose memex contents to OpenClaw's built-in memory_search
    // -------------------------------------------------------------
    try {
      const supplement = buildCorpusSupplement(store, logger);
      registerMemoryCorpusSupplement('memex-openclaw', supplement);
      logger.info('memex-openclaw: registered as memory corpus supplement');
    } catch (err) {
      // Non-fatal — capture still works without supplement registration.
      logger.warn(
        `memex-openclaw: could not register corpus supplement: ${err.message} ` +
        '(capture still active; built-in memory_search will not surface memex rows)',
      );
    }

    logger.info('memex-openclaw: plugin activated');
  },
});

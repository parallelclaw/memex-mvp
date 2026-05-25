/**
 * One-shot backfill of OpenClaw session history into memex.db.
 *
 * OpenClaw 2026.5+ stores agent session logs as JSONL files under:
 *
 *   ~/.openclaw/agents/<agentName>/sessions/<sessionUuid>.jsonl
 *
 * Three file kinds exist in that directory; we process exactly one:
 *
 *   <uuid>.jsonl                  ← INCLUDED (regular sessions)
 *   <uuid>.checkpoint.<uuid>.jsonl  ← SKIPPED (compaction snapshots —
 *                                    would double-count messages already
 *                                    in the primary session file)
 *   <uuid>.trajectory.jsonl       ← SKIPPED (debug/trace artifacts —
 *                                    not human-facing content)
 *
 * Conv_id is derived using the SAME function the live plugin uses
 * (`deriveConvId` from conv_id.js). That guarantees backfilled rows
 * and live-captured rows share conversation_ids, so the UNIQUE(source,
 * conversation_id, msg_id) constraint in memex.db deduplicates
 * transparently — re-running backfill is a free no-op after the first
 * successful run.
 *
 * Watermarking (v0.2.0): per-agent last-processed mtime is stored in
 * plugin_state via store.setState/getState. After a partial-failure
 * run, the next backfill resumes from where the last one stopped —
 * unprocessed sessions are tried again, processed ones are skipped
 * without even being parsed. This is the claude-mem pattern (referenced
 * in our 2026-05-25 research).
 *
 * Return shape is designed for an LLM agent that drove the install:
 * `next_action`, `watermark_advanced`, `restart_needed` make it
 * possible for the agent to *reason* about a re-run without parsing
 * raw counts. See memex-hermes-backfill for the prior art.
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { deriveConvId, deriveMsgId, extractText } from './conv_id.js';

const PLUGIN_ID = 'memex-openclaw';

// Strict UUID-only filename — excludes .checkpoint.*.jsonl and
// .trajectory.jsonl artifacts which would otherwise pollute the import.
const PRIMARY_SESSION_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Default location OpenClaw 2026.5+ uses for agent session logs.
 */
export function defaultAgentsDir() {
  return join(homedir(), '.openclaw', 'agents');
}

/**
 * List agent names by scanning the agents/ directory.
 * Returns ['main', 'other-agent', ...] (sorted, dirs only).
 * Empty array if the dir doesn't exist (treated as "no history" case).
 */
export function discoverAgents(agentsDir) {
  if (!existsSync(agentsDir)) return [];
  let entries;
  try { entries = readdirSync(agentsDir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * List primary session JSONL files for one agent, with mtimes.
 * Returns [{ path, sessionId, mtime }, ...] sorted by mtime ascending
 * (oldest first) so backfill processes in chronological order — useful
 * for the watermark to advance monotonically.
 */
export function listAgentSessions(agentsDir, agentName) {
  const sessionsDir = join(agentsDir, agentName, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  let entries;
  try { entries = readdirSync(sessionsDir); }
  catch { return []; }

  const out = [];
  for (const name of entries) {
    if (!PRIMARY_SESSION_RE.test(name)) continue;
    const path = join(sessionsDir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    out.push({
      path,
      sessionId: name.slice(0, -('.jsonl'.length)),
      mtime: Math.floor(st.mtimeMs / 1000),
    });
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

/**
 * Pull (role, text, ts, messageProvider, channelId) out of one JSONL
 * event line. OpenClaw event schemas vary slightly across versions and
 * gateways, so this parser is intentionally tolerant:
 *
 *   - Recognises events where role ∈ {user, assistant}
 *   - Accepts content as string OR structured content-parts array
 *   - Accepts ts at top level OR nested under metadata/timing
 *   - Accepts channel routing at top level OR under metadata.context
 *
 * Returns null if the event isn't a user/assistant message worth
 * importing (e.g. tool calls, system messages, internal events).
 */
function parseEvent(event) {
  if (!event || typeof event !== 'object') return null;

  // Locate role — primary or fallback locations.
  const role =
    event.role ||
    event.message?.role ||
    event.type === 'message' ? event.role : null;
  if (role !== 'user' && role !== 'assistant') return null;

  // Locate text content. extractText() handles string, array of parts,
  // and {text: "..."} shapes — same helper the live plugin uses.
  const text = extractText(event.message || event);
  if (!text || !text.trim()) return null;

  // Locate timestamp — prefer explicit unix seconds, else parse ISO,
  // else fall back to now-ish (the file's mtime will be a better
  // signal but parseEvent doesn't see that).
  let ts = event.ts || event.timestamp || event.created_at;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    ts = isNaN(parsed) ? null : Math.floor(parsed / 1000);
  } else if (typeof ts === 'number' && ts > 1e12) {
    // Likely milliseconds.
    ts = Math.floor(ts / 1000);
  }

  // Locate channel routing — these may live at top level, under
  // metadata, or under context. Try each in priority order.
  const ctx = event.context || event.metadata?.context || event.metadata || {};
  const messageProvider =
    event.messageProvider || ctx.messageProvider || ctx.platform || null;
  const channelId =
    event.channelId || ctx.channelId || ctx.chat_id || null;

  return {
    role,
    text: String(text),
    ts: ts || null,
    messageProvider,
    channelId,
  };
}

/**
 * Process one session JSONL file. Returns { sessionId, inserted,
 * skipped, errors } counts. Caller is responsible for watermark.
 */
function backfillOneSession(store, file, opts = {}) {
  const { dryRun = false, sinceTs = null } = opts;
  let raw;
  try { raw = readFileSync(file.path, 'utf8'); }
  catch (err) {
    return { sessionId: file.sessionId, inserted: 0, skipped: 0, errors: [err.message] };
  }

  const lines = raw.split('\n');
  let inserted = 0;
  let skipped = 0;
  const errors = [];

  // Many JSONL streams begin with a session-init event that carries
  // messageProvider/channelId for the whole session. We collect those
  // hints from any event and apply the last-seen values to subsequent
  // messages that don't carry their own routing.
  let stickyProvider = null;
  let stickyChannelId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let event;
    try { event = JSON.parse(line); }
    catch (err) {
      errors.push(`line ${i + 1}: parse error: ${err.message}`);
      continue;
    }

    // Update sticky routing from ANY event that carries hints, even
    // non-message events (e.g. session_start).
    const ctx = event.context || event.metadata?.context || event.metadata || {};
    if (event.messageProvider || ctx.messageProvider || ctx.platform) {
      stickyProvider = event.messageProvider || ctx.messageProvider || ctx.platform;
    }
    if (event.channelId != null || ctx.channelId != null || ctx.chat_id != null) {
      stickyChannelId = event.channelId ?? ctx.channelId ?? ctx.chat_id;
    }

    const parsed = parseEvent(event);
    if (!parsed) continue;

    // Apply sticky routing if the event itself didn't carry it.
    const messageProvider = parsed.messageProvider || stickyProvider;
    const channelId = parsed.channelId ?? stickyChannelId;
    const ts = parsed.ts || file.mtime;

    if (sinceTs && ts < sinceTs) {
      skipped++;
      continue;
    }

    const convId = deriveConvId({
      messageProvider,
      channelId,
      sessionId: file.sessionId,
    });
    const msgId = deriveMsgId({ role: parsed.role, text: parsed.text, convId });

    if (dryRun) {
      if (store.getById && store.exists?.(convId, msgId)) skipped++;
      else inserted++;
      continue;
    }

    const wrote = store.insertMessage({
      conversationId: convId,
      msgId,
      role: parsed.role,
      text: parsed.text,
      ts,
      channel: messageProvider || null,
      metadata: {
        raw_type: 'openclaw-backfill',
        session_id: file.sessionId,
        agent_id: opts.agentName || null,
        platform: messageProvider,
        channel_id: channelId,
      },
    });
    if (wrote) inserted++;
    else skipped++;
  }

  return { sessionId: file.sessionId, inserted, skipped, errors };
}

/**
 * Top-level backfill. Walks agents → sessions → messages, respects
 * watermark, advances watermark on success.
 *
 * opts:
 *   agentsDir:   override default ~/.openclaw/agents/
 *   dryRun:      no DB writes; reports what would happen
 *   since:       YYYY-MM-DD or unix epoch — only sessions touched
 *                after this date
 *   ignoreWatermark: process ALL sessions regardless of last-mtime
 *                    (use for `--force` or recovery)
 *
 * Returns a structured report — same shape regardless of dry-run vs
 * real, designed for an LLM agent to parse next_action and decide
 * whether to trigger restart.
 */
export function runBackfill(store, opts = {}) {
  const agentsDir = opts.agentsDir || defaultAgentsDir();
  const dryRun = !!opts.dryRun;
  const ignoreWatermark = !!opts.ignoreWatermark;
  const sinceTs = parseSince(opts.since);

  const agents = discoverAgents(agentsDir);
  const result = {
    agents_dir: agentsDir,
    agents_scanned: agents.length,
    sessions_seen: 0,
    sessions_processed: 0,
    sessions_skipped_watermark: 0,
    messages_imported: 0,
    messages_skipped_dup: 0,
    per_agent: [],
    errors: [],
    watermark_advanced: false,
    dry_run: dryRun,
  };

  if (agents.length === 0) {
    result.status = 'no_history';
    result.next_action = 'none';
    return result;
  }

  for (const agentName of agents) {
    const sessions = listAgentSessions(agentsDir, agentName);
    const watermarkKey = `agent:${agentName}:last_mtime`;
    const wmRaw = ignoreWatermark ? null : store.getState(PLUGIN_ID, watermarkKey);
    const watermark = wmRaw ? Number(wmRaw) || 0 : 0;

    let agentInserted = 0;
    let agentSkippedDup = 0;
    let agentSessionsProcessed = 0;
    let agentSessionsSkipped = 0;
    let agentNewWatermark = watermark;

    for (const file of sessions) {
      result.sessions_seen++;
      if (file.mtime <= watermark) {
        agentSessionsSkipped++;
        result.sessions_skipped_watermark++;
        continue;
      }
      const r = backfillOneSession(store, file, {
        dryRun, sinceTs, agentName,
      });
      agentInserted += r.inserted;
      agentSkippedDup += r.skipped;
      agentSessionsProcessed++;
      if (r.errors.length) {
        result.errors.push(...r.errors.map((e) =>
          `${agentName}/${file.sessionId}: ${e}`,
        ));
      }
      // Advance watermark only on a session that had at least one
      // event we tried to process — empty/corrupt sessions don't
      // count, so we'll retry them next run.
      if ((r.inserted + r.skipped) > 0 && file.mtime > agentNewWatermark) {
        agentNewWatermark = file.mtime;
      }
    }

    // Commit watermark (real runs only).
    if (!dryRun && agentNewWatermark > watermark) {
      store.setState(PLUGIN_ID, watermarkKey, String(agentNewWatermark));
      result.watermark_advanced = true;
    }

    result.sessions_processed += agentSessionsProcessed;
    result.messages_imported += agentInserted;
    result.messages_skipped_dup += agentSkippedDup;
    result.per_agent.push({
      agent: agentName,
      sessions_total: sessions.length,
      sessions_processed: agentSessionsProcessed,
      sessions_skipped_watermark: agentSessionsSkipped,
      messages_imported: agentInserted,
      messages_skipped_dup: agentSkippedDup,
      watermark_before: watermark,
      watermark_after: dryRun ? watermark : agentNewWatermark,
    });
  }

  // Decide overall status + next_action signal for the calling agent.
  if (result.messages_imported === 0 && result.messages_skipped_dup === 0) {
    result.status = 'no_new_data';
    result.next_action = 'none';
  } else if (result.messages_imported === 0) {
    result.status = 'already_in_sync';
    result.next_action = 'none';
  } else {
    result.status = 'imported';
    result.next_action = dryRun ? 'review_then_real_run' : 'restart_gateway';
  }

  return result;
}

/**
 * Parse a --since string (YYYY-MM-DD or unix epoch) into unix seconds.
 * Returns null on missing / invalid (treated as "no filter").
 */
function parseSince(since) {
  if (since == null || since === '') return null;
  const s = String(since).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parsed = Date.parse(s);
  return isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

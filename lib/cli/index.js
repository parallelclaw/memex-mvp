/**
 * memex CLI — terminal-mode subcommands for the `memex` binary.
 *
 * When the user invokes the `memex` bin with a recognized subcommand
 * (search / recent / list / get / overview / projects / help / --help
 * / --version), we run a one-shot query and exit. When called WITHOUT
 * any argument, server.js falls through to MCP-stdio mode (the
 * primary mode used by Claude Code, Cursor, Cline, Continue, Zed).
 *
 * The CLI opens memex.db in read-only mode and uses WAL-friendly
 * queries — safe to run while memex-sync daemon is writing.
 *
 * Why duplicate SQL from server.js?  The MCP handlers in server.js
 * are tightly coupled with the JSON-RPC response shape (jsonResult /
 * textResult, half-life-boost params, group_by_conversation, …).
 * Replicating the simple queries here keeps the CLI self-contained
 * and avoids a risky refactor of the production MCP path. The CLI
 * intentionally exposes the MOST USEFUL subset — not every MCP tool
 * has a CLI peer.
 *
 * Output format:
 *   default → human-friendly markdown with light ANSI colors (TTY only)
 *   --json  → structured JSON for shell pipelines / agents
 */

import Database from 'better-sqlite3';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  installHook,
  uninstallHook,
  getHookStatus,
  resolveMemexBinPath,
} from '../hook/install.js';

// ---------- Subcommand registry ----------
export const CLI_SUBCOMMAND_NAMES = [
  'search', 'recent', 'list', 'get', 'overview',
  'projects', 'context', 'hook', 'when',
  'help', '-h', '--help', '-v', '--version',
];

// ---------- Path helpers ----------
const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');
// HELP.md lives at the package root, two levels up from lib/cli/
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HELP_MD_PATH = join(PACKAGE_ROOT, 'HELP.md');

// ---------- ANSI helpers ----------
const TTY = process.stdout.isTTY;
const c = TTY
  ? {
      dim:   (s) => `\x1b[2m${s}\x1b[0m`,
      bold:  (s) => `\x1b[1m${s}\x1b[0m`,
      cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow:(s) => `\x1b[33m${s}\x1b[0m`,
    }
  : {
      dim: (s) => s, bold: (s) => s, cyan: (s) => s,
      green: (s) => s, yellow: (s) => s,
    };

// ---------- argv parser (minimal, no deps) ----------
function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--chat') opts.chat = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--sort') opts.sort = argv[++i];
    else if (a === '--include-archived') opts.includeArchived = true;
    else if (a === '--pwd') opts.pwd = argv[++i];
    else if (a === '--budget' || a === '--budget-tokens') opts.budget = parseInt(argv[++i], 10);
    else if (a === '--freshness-days') opts.freshnessDays = parseInt(argv[++i], 10);
    else if (a === '--no-source') {
      // Allow repeated --no-source telegram --no-source obsidian
      if (!Array.isArray(opts.noSource)) opts.noSource = [];
      opts.noSource.push(argv[++i]);
    }
    else if (a === '--as-of') opts.asOf = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) { /* ignore unknown flag for forward-compat */ }
    else positionals.push(a);
  }
  return { opts, positionals };
}

function openDb() {
  if (!existsSync(DB_PATH)) {
    console.error(`memex.db not found at ${DB_PATH}`);
    console.error(`Run 'memex-sync install' to set up the daemon and create the DB.`);
    process.exit(1);
  }
  // Read-only handle: WAL allows this to coexist with the writing daemon.
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function fmtDate(ts) {
  if (!ts || ts === 0) return '?';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fmtDateTime(ts) {
  if (!ts || ts === 0) return '?';
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Parse YYYY-MM-DD into unix timestamp at start-of-day (00:00 UTC).
 * Returns null on invalid input.
 */
function parseAsOf(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

// FTS5 expects sanitized tokens — strip what would be operators
function sanitizeFtsQuery(q) {
  return String(q || '')
    .trim()
    .replace(/[^\p{L}\p{N}_\-\s"]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// =============================================================
// SEARCH
// =============================================================
async function cmdSearch(args) {
  const { opts, positionals } = parseArgs(args);
  const query = positionals.join(' ').trim();
  if (!query || opts.help) {
    console.error('Usage: memex search "<query>" [--source X] [--chat X] [--project X] [--sort SORT] [--limit N] [--json]');
    console.error('  --sort: relevance (default) | date_asc | date_desc');
    process.exit(query ? 0 : 2);
  }
  const limit = Math.min(50, Math.max(1, opts.limit || 10));
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) {
    console.error('Query became empty after sanitization — try simpler keywords.');
    process.exit(2);
  }

  const filters = ['messages_fts MATCH ?'];
  const params = [sanitized];
  if (opts.source) {
    filters.push('m.source = ?');
    params.push(opts.source);
  }
  if (!opts.includeArchived) {
    filters.push('(c.archived_at IS NULL OR c.archived_at = 0)');
  }
  if (opts.project) {
    filters.push('c.project_path LIKE ?');
    params.push(`%${opts.project}%`);
  }
  if (opts.chat) {
    filters.push('LOWER(c.title) LIKE LOWER(?)');
    params.push(`%${opts.chat}%`);
  }
  // Time-travel: --as-of YYYY-MM-DD returns only messages with ts strictly
  // before that calendar date (start-of-day). Useful for retrospectives:
  // "what did I know about X two weeks ago?"
  if (opts.asOf) {
    const cutoff = parseAsOf(opts.asOf);
    if (cutoff === null) {
      console.error(`Invalid --as-of date: "${opts.asOf}". Expected YYYY-MM-DD.`);
      process.exit(2);
    }
    filters.push('m.ts > 0 AND m.ts < ?');
    params.push(cutoff);
  }

  let orderBy;
  if (opts.sort === 'date_asc') {
    orderBy = 'CASE WHEN m.ts IS NULL OR m.ts = 0 THEN 1 ELSE 0 END, m.ts ASC';
  } else if (opts.sort === 'date_desc') {
    orderBy = 'CASE WHEN m.ts IS NULL OR m.ts = 0 THEN 1 ELSE 0 END, m.ts DESC';
  } else {
    // Same BM25 × recency formula as memex_search, with half_life = 30 days
    orderBy = `bm25(messages_fts) * exp(-(CAST(strftime('%s','now') AS REAL) - COALESCE(NULLIF(m.ts, 0), CAST(strftime('%s','now') AS REAL))) / 86400.0 / 30.0)`;
  }

  const sql = `
    SELECT m.source, m.conversation_id, m.role, m.sender, m.ts,
           snippet(messages_fts, 0, '<<', '>>', ' … ', 18) AS snippet,
           c.title AS conversation_title
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
 LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE ${filters.join(' AND ')}
  ORDER BY ${orderBy}
     LIMIT ?
  `;
  const db = openDb();
  const rows = db.prepare(sql).all(...params, limit);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ query, count: rows.length, results: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No results for ${c.bold('"' + query + '"')}`);
    return;
  }
  console.log(`${c.bold(rows.length)} result(s) for ${c.bold('"' + query + '"')}\n`);
  for (const r of rows) {
    console.log(`${c.cyan(r.conversation_title || r.conversation_id)} ${c.dim('· ' + r.source + ' · ' + fmtDate(r.ts))}`);
    console.log(`  ${r.snippet.replace(/<<(.+?)>>/g, (_, m) => c.yellow(m))}`);
    console.log(`  ${c.dim('conversation_id: ' + r.conversation_id)}`);
    console.log('');
  }
}

// =============================================================
// RECENT
// =============================================================
async function cmdRecent(args) {
  const { opts } = parseArgs(args);
  if (opts.help) {
    console.error('Usage: memex recent [--limit N] [--source X] [--json]');
    process.exit(0);
  }
  const limit = Math.min(100, Math.max(1, opts.limit || 20));
  const filters = [];
  const params = [];
  if (opts.source) {
    filters.push('m.source = ?');
    params.push(opts.source);
  }
  if (!opts.includeArchived) {
    filters.push('(c.archived_at IS NULL OR c.archived_at = 0)');
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT m.source, m.conversation_id, m.role, m.sender, m.ts,
           substr(m.text, 1, 240) AS preview,
           c.title AS conversation_title
      FROM messages m
 LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     ${where}
  ORDER BY m.ts DESC
     LIMIT ?
  `;
  const db = openDb();
  const rows = db.prepare(sql).all(...params, limit);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ count: rows.length, results: rows }, null, 2));
    return;
  }
  console.log(`${c.bold(rows.length)} recent message(s)\n`);
  for (const r of rows) {
    console.log(`${c.cyan(r.conversation_title || r.conversation_id)} ${c.dim('· ' + r.source + ' · ' + fmtDateTime(r.ts))}`);
    console.log(`  ${c.dim(r.role + ':')} ${r.preview.replace(/\s+/g, ' ').trim()}`);
    console.log('');
  }
}

// =============================================================
// LIST conversations
// =============================================================
async function cmdList(args) {
  const { opts } = parseArgs(args);
  if (opts.help) {
    console.error('Usage: memex list [--source X] [--limit N] [--json]');
    process.exit(0);
  }
  const limit = Math.min(200, Math.max(1, opts.limit || 20));
  const filters = [];
  const params = [];
  if (opts.source) {
    filters.push('source = ?');
    params.push(opts.source);
  }
  if (!opts.includeArchived) {
    filters.push('(archived_at IS NULL OR archived_at = 0)');
  }
  filters.push("(parent_conversation_id IS NULL)"); // skip subagents by default
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT conversation_id, source, title, first_ts, last_ts, message_count
      FROM conversations
     ${where}
  ORDER BY last_ts DESC
     LIMIT ?
  `;
  const db = openDb();
  const rows = db.prepare(sql).all(...params, limit);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ count: rows.length, conversations: rows }, null, 2));
    return;
  }
  console.log(`${c.bold(rows.length)} conversation(s)\n`);
  for (const r of rows) {
    console.log(`${c.cyan(r.title || r.conversation_id)}`);
    console.log(`  ${c.dim(r.source + ' · ' + r.message_count + ' msgs · ' + fmtDate(r.first_ts) + ' → ' + fmtDate(r.last_ts))}`);
    console.log(`  ${c.dim(r.conversation_id)}`);
    console.log('');
  }
}

// =============================================================
// GET full conversation
// =============================================================
async function cmdGet(args) {
  const { opts, positionals } = parseArgs(args);
  const convId = positionals[0];
  if (!convId || opts.help) {
    console.error('Usage: memex get <conversation_id> [--limit N] [--json]');
    console.error('Find conversation_ids via `memex list` or `memex search`.');
    process.exit(convId ? 0 : 2);
  }
  const limit = Math.min(2000, Math.max(1, opts.limit || 200));
  const db = openDb();
  const conv = db
    .prepare(`SELECT * FROM conversations WHERE conversation_id = ?`)
    .get(convId);
  if (!conv) {
    db.close();
    console.error(`No conversation found for id: ${convId}`);
    process.exit(1);
  }
  const msgs = db
    .prepare(`
      SELECT role, sender, text, ts
        FROM messages
       WHERE conversation_id = ?
    ORDER BY ts ASC, id ASC
       LIMIT ?
    `)
    .all(convId, limit);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ conversation: conv, messages: msgs }, null, 2));
    return;
  }
  console.log(`# ${conv.title || conv.conversation_id}`);
  console.log(`${c.dim(conv.source + ' · ' + msgs.length + ' message(s) · ' + fmtDate(conv.first_ts) + ' → ' + fmtDate(conv.last_ts))}`);
  console.log('');
  for (const m of msgs) {
    console.log(`${c.cyan(m.role + ' (' + m.sender + ')')} ${c.dim(fmtDateTime(m.ts))}`);
    console.log(m.text);
    console.log('');
  }
}

// =============================================================
// OVERVIEW
// =============================================================
async function cmdOverview(args) {
  const { opts } = parseArgs(args);
  const db = openDb();
  const sources = db.prepare(`
    SELECT source, COUNT(*) AS msgs, COUNT(DISTINCT conversation_id) AS chats,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts
      FROM messages
  GROUP BY source
  ORDER BY msgs DESC
  `).all();
  const totalMsgs = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get().c;
  const totalConvs = db.prepare(`SELECT COUNT(*) AS c FROM conversations`).get().c;
  const recentConvs = db.prepare(`
    SELECT conversation_id, source, title, last_ts
      FROM conversations
     WHERE archived_at IS NULL OR archived_at = 0
  ORDER BY last_ts DESC
     LIMIT 10
  `).all();

  // Streak + today's capture count (D6 — GitHub-style daily habit signal)
  const streak = computeStreak(db);

  db.close();

  if (opts.json) {
    console.log(JSON.stringify({
      total_messages: totalMsgs,
      total_conversations: totalConvs,
      sources,
      recent_conversations: recentConvs,
      streak: streak,
    }, null, 2));
    return;
  }
  console.log(c.bold('memex corpus snapshot') + '\n');
  console.log(`Total: ${c.green(totalMsgs + ' messages')} in ${c.green(totalConvs + ' conversations')}\n`);

  // Streak block — only show if there's at least one captured day
  if (streak.streakDays > 0) {
    const today = streak.todayMessages;
    const todayLine = today > 0
      ? `Today: ${c.green(today + ' messages')} across ${streak.todayConversations} conversation(s).`
      : `${c.dim('No captures yet today.')}`;
    const streakLine = streak.streakDays >= 2
      ? `${c.green('✓ ' + streak.streakDays + '-day capture streak')} (since ${fmtDate(streak.streakStartTs)}). ${todayLine}`
      : `${c.dim('Starting fresh — capture something today to begin a streak.')} ${todayLine}`;
    console.log(streakLine + '\n');
  }

  console.log(c.bold('By source:'));
  for (const s of sources) {
    console.log(`  ${s.source.padEnd(18)} ${String(s.msgs).padStart(7)} msgs · ${String(s.chats).padStart(5)} chats · ${fmtDate(s.first_ts)} → ${fmtDate(s.last_ts)}`);
  }
  console.log('');
  console.log(c.bold('10 most recent conversations:'));
  for (const r of recentConvs) {
    console.log(`  ${c.dim(fmtDate(r.last_ts))}  ${c.cyan((r.title || r.conversation_id).slice(0, 60))}  ${c.dim('(' + r.source + ')')}`);
  }
}

/**
 * Compute current capture streak: consecutive days (working backward from
 * today) with at least one message captured.
 *
 * Returns:
 *   {
 *     streakDays:      number,   // 0 if today has 0 captures
 *     streakStartTs:   number,   // ts of the earliest day in the streak
 *     todayMessages:   number,   // count of messages captured today
 *     todayConversations: number,
 *   }
 *
 * "Day" boundaries are UTC (matches how we store ts). A more user-friendly
 * version would use local-day, but UTC is consistent and predictable —
 * good enough for v0.8.1.
 */
function computeStreak(db) {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(now / 86400) * 86400; // UTC midnight today

  // Distinct days with captures, sorted desc — pull up to ~365 days to bound work
  const days = db.prepare(`
    SELECT DISTINCT (ts / 86400) AS day
      FROM messages
     WHERE ts >= ?
  ORDER BY day DESC
  `).all(todayStart - 365 * 86400);

  let streakDays = 0;
  let streakStartTs = 0;
  if (days.length > 0) {
    const todayDay = Math.floor(todayStart / 86400);
    let cursor = todayDay;
    for (const row of days) {
      if (row.day === cursor) {
        streakDays += 1;
        streakStartTs = row.day * 86400;
        cursor -= 1;
      } else if (row.day < cursor) {
        // Streak broken — stop
        break;
      }
      // row.day > cursor shouldn't happen with DESC order; if it does, skip
    }
  }

  const todayRow = db.prepare(`
    SELECT COUNT(*) AS msgs, COUNT(DISTINCT conversation_id) AS convs
      FROM messages
     WHERE ts >= ?
  `).get(todayStart);

  return {
    streakDays,
    streakStartTs,
    todayMessages: todayRow.msgs,
    todayConversations: todayRow.convs,
  };
}

// =============================================================
// PROJECTS
// =============================================================
async function cmdProjects(args) {
  const { opts } = parseArgs(args);
  const limit = Math.min(500, Math.max(1, opts.limit || 50));
  const db = openDb();
  const rows = db.prepare(`
    SELECT project_path AS path, COUNT(*) AS chats
      FROM conversations
     WHERE project_path IS NOT NULL AND project_path != ''
  GROUP BY project_path
  ORDER BY chats DESC, project_path ASC
     LIMIT ?
  `).all(limit);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ count: rows.length, projects: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No projects captured yet. Run `memex-sync backfill-projects` to populate project paths on older conversations.');
    return;
  }
  console.log(`${c.bold(rows.length)} project(s):\n`);
  for (const r of rows) {
    console.log(`  ${String(r.chats).padStart(4)} chats  ${c.cyan(r.path)}`);
  }
}

// =============================================================
// WHEN — chronological "when did we talk about X" CLI shortcut
// =============================================================
//
// `memex when "JWT decision"` answers the single most common memex query
// in 1 second: dates, sources, conversation titles. No snippets, no
// re-ranking — just chronological recall.
//
// Returns one row per matching conversation, sorted by latest message in
// that conversation (date_desc). Useful when the user remembers a topic
// but can't recall WHICH session it came from or WHEN.
async function cmdWhen(args) {
  const { opts, positionals } = parseArgs(args);
  const query = positionals.join(' ').trim();

  if (!query || opts.help) {
    console.error('Usage: memex when "<query>" [--source X] [--limit N] [--json]');
    console.error('');
    console.error('Returns a chronological "when did we talk about X" list — date + source +');
    console.error('conversation title, no snippets. Sorted newest first.');
    process.exit(query ? 0 : 2);
  }

  const limit = Math.min(50, Math.max(1, opts.limit || 15));
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) {
    console.error('Query became empty after sanitization — try simpler keywords.');
    process.exit(2);
  }

  const filters = ['messages_fts MATCH ?'];
  const params = [sanitized];
  if (opts.source) {
    filters.push('m.source = ?');
    params.push(opts.source);
  }
  if (!opts.includeArchived) {
    filters.push('(c.archived_at IS NULL OR c.archived_at = 0)');
  }

  // Aggregate by conversation: one row per chat, latest hit's date, match count
  const sql = `
    SELECT m.conversation_id,
           m.source,
           MAX(m.ts) AS latest_ts,
           MIN(m.ts) AS earliest_ts,
           COUNT(*)  AS match_count,
           c.title AS conversation_title
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
 LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE ${filters.join(' AND ')}
  GROUP BY m.conversation_id
  ORDER BY latest_ts DESC
     LIMIT ?
  `;
  const db = openDb();
  const rows = db.prepare(sql).all(...params, limit);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ query, count: rows.length, results: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`No mentions of ${c.bold('"' + query + '"')} found.`);
    return;
  }
  console.log(`${c.bold('"' + query + '"')} mentioned in ${c.bold(rows.length)} conversation(s):\n`);
  for (const r of rows) {
    const date = fmtDate(r.latest_ts);
    const range = r.earliest_ts && r.earliest_ts !== r.latest_ts
      ? ` (also ${fmtDate(r.earliest_ts)})`
      : '';
    const count = r.match_count > 1 ? ` · ${r.match_count} matches` : '';
    console.log(`  ${c.green(date)}${c.dim(range)}  ${c.dim(r.source.padEnd(14))}  ${c.cyan((r.conversation_title || r.conversation_id).slice(0, 60))}${c.dim(count)}`);
  }
  console.log('');
  console.log(c.dim(`To read one: memex get <conversation_id>  |  to search content: memex search "${query}"`));
}

// =============================================================
// CONTEXT — output relevant memex context for current pwd
// =============================================================
//
// Designed to be called by Claude Code SessionStart hook (or equivalent).
// stdout markdown becomes a system message injected into Claude's context
// BEFORE the user sends their first prompt. So Claude "knows" what the
// user has been doing in this project without being asked.
//
// Smart selection:
//   1. Direct project_path match — conversations where this exact path was
//      captured (Claude Code/Cowork cwd, Obsidian vault, etc.)
//   2. Project-name fuzzy match — conversations whose title mentions the
//      basename of pwd (catches discussions of the project across sources
//      like Telegram where there's no project_path).
//
// Default budget: 1500 tokens (≈6000 chars markdown). Truncated cleanly
// if needed — never spill into Claude's context window unboundedly.
//
// Privacy: telegram source is included by default (users discussed feature
// idea here) but can be excluded via --no-source telegram. Future:
// per-source sensitivity flags in ~/.memex/config.json.
//
// Output is markdown. --json gives the structured underlying data.
async function cmdContext(args) {
  const { opts } = parseArgs(args);

  if (opts.help) {
    console.error('Usage: memex context [--pwd PATH] [--limit N] [--budget-tokens N] [--freshness-days N] [--no-source NAME] [--json]');
    console.error('');
    console.error('Outputs markdown summarizing recent memex activity relevant to the current pwd.');
    console.error('Designed for use as a Claude Code SessionStart hook.');
    process.exit(0);
  }

  const pwd = opts.pwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const limit = Math.min(20, Math.max(1, opts.limit || 5));
  const tokenBudget = Math.min(8000, Math.max(50, opts.budget || 1500));
  const freshnessDays = Math.min(365, Math.max(1, opts.freshnessDays || 90));
  const excludeSources = Array.isArray(opts.noSource) ? opts.noSource : (opts.noSource ? [opts.noSource] : []);

  const project = basename(pwd);
  const sinceTs = Math.floor(Date.now() / 1000) - freshnessDays * 86400;

  const db = openDb();

  // 1. Direct project_path matches — highest signal.
  const directFilters = [
    'project_path LIKE ?',
    'last_ts >= ?',
    '(archived_at IS NULL OR archived_at = 0)',
  ];
  const directParams = [`%${pwd}%`, sinceTs];
  if (excludeSources.length) {
    const placeholders = excludeSources.map(() => '?').join(',');
    directFilters.push(`source NOT IN (${placeholders})`);
    directParams.push(...excludeSources);
  }
  const directConvs = db.prepare(`
    SELECT conversation_id, source, title, first_ts, last_ts, message_count
      FROM conversations
     WHERE ${directFilters.join(' AND ')}
  ORDER BY last_ts DESC
     LIMIT ?
  `).all(...directParams, limit);

  // 2. Fuzzy project-name matches in title (catches Telegram / web discussion of project).
  // Skip duplicates we already got from direct match.
  const seenIds = new Set(directConvs.map((c) => c.conversation_id));
  const fuzzyFilters = [
    'LOWER(title) LIKE LOWER(?)',
    'last_ts >= ?',
    '(archived_at IS NULL OR archived_at = 0)',
  ];
  const fuzzyParams = [`%${project}%`, sinceTs];
  if (excludeSources.length) {
    const placeholders = excludeSources.map(() => '?').join(',');
    fuzzyFilters.push(`source NOT IN (${placeholders})`);
    fuzzyParams.push(...excludeSources);
  }
  const fuzzyConvs = db.prepare(`
    SELECT conversation_id, source, title, first_ts, last_ts, message_count
      FROM conversations
     WHERE ${fuzzyFilters.join(' AND ')}
  ORDER BY last_ts DESC
     LIMIT ?
  `).all(...fuzzyParams, limit * 2);
  const filteredFuzzy = fuzzyConvs.filter((r) => !seenIds.has(r.conversation_id)).slice(0, Math.max(1, limit - directConvs.length));

  db.close();

  const all = [...directConvs, ...filteredFuzzy];

  if (opts.json) {
    console.log(JSON.stringify({
      pwd, project, freshness_days: freshnessDays,
      direct_matches: directConvs.length,
      fuzzy_matches: filteredFuzzy.length,
      conversations: all,
      token_budget: tokenBudget,
    }, null, 2));
    return;
  }

  // Markdown output (TTY-color stripped — this is consumed by Claude, not the user)
  const lines = [];
  lines.push(`## memex auto-context for ${project}`);
  lines.push('');

  if (all.length === 0) {
    lines.push(`_No recent activity in memex for this project (last ${freshnessDays} days)._`);
    lines.push('');
    lines.push(`Path searched: \`${pwd}\``);
    lines.push('');
    lines.push('---');
    lines.push(`_memex auto-context · empty · v0.8+_`);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (directConvs.length > 0) {
    lines.push(`### Recent conversations in this project (last ${freshnessDays} days)`);
    lines.push('');
    for (const conv of directConvs) {
      const date = fmtDate(conv.last_ts);
      const title = (conv.title || conv.conversation_id).slice(0, 100);
      lines.push(`- **${date}** · _${conv.source}_ · ${title} (${conv.message_count} msgs)`);
    }
    lines.push('');
  }

  if (filteredFuzzy.length > 0) {
    lines.push(`### Related discussions mentioning "${project}"`);
    lines.push('');
    for (const conv of filteredFuzzy) {
      const date = fmtDate(conv.last_ts);
      const title = (conv.title || conv.conversation_id).slice(0, 100);
      lines.push(`- **${date}** · _${conv.source}_ · ${title}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`_memex auto-context · ${all.length} sources · v0.8+_`);
  lines.push(`_To search deeper, ask memex (via MCP tool or terminal: \`memex search "..."\`)._`);

  let out = lines.join('\n') + '\n';

  // Token budget enforcement — rough estimate ≈ 4 chars/token. Truncate
  // cleanly at a line boundary to keep markdown valid.
  const maxChars = tokenBudget * 4;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    const lastNewline = out.lastIndexOf('\n');
    if (lastNewline > 0) out = out.slice(0, lastNewline);
    out += '\n\n_[context truncated — exceeds token budget]_\n';
  }

  process.stdout.write(out);
}

// =============================================================
// HOOK — install/uninstall/status for Claude Code SessionStart
// =============================================================
async function cmdHook(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const { opts } = parseArgs(rest);

  if (!sub || sub === '--help' || sub === '-h') {
    console.error('Usage: memex hook <install|uninstall|status>');
    console.error('');
    console.error('  install    Add memex SessionStart hook to ~/.claude/settings.json');
    console.error('             Idempotent — re-runs are no-ops.');
    console.error('             Claude Code will inject memex context on every new session.');
    console.error('');
    console.error('  uninstall  Remove the memex hook entry. Preserves all other hooks.');
    console.error('');
    console.error('  status     Show whether the hook is currently installed.');
    process.exit(sub ? 0 : 2);
  }

  if (sub === 'install') {
    const r = installHook();
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.error) {
      console.error(`✗ ${r.error}`);
      process.exit(1);
    }
    if (r.alreadyPresent) {
      console.log(`✓ memex hook already installed in ${r.settingsPath}`);
      console.log(`  command: ${r.command}`);
      return;
    }
    console.log(`✓ memex SessionStart hook installed`);
    console.log(`  settings: ${r.settingsPath}`);
    console.log(`  command:  ${r.command}`);
    console.log('');
    console.log('Restart Claude Code (Cmd+Q + reopen) for the hook to activate.');
    console.log('After restart, Claude will see memex context on every new session.');
    console.log('');
    console.log('Disable later: memex hook uninstall');
    return;
  }

  if (sub === 'uninstall') {
    const r = uninstallHook();
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.error) {
      console.error(`✗ ${r.error}`);
      process.exit(1);
    }
    if (!r.wasPresent) {
      console.log('memex hook was not installed (nothing to remove).');
      return;
    }
    console.log('✓ memex SessionStart hook removed');
    console.log('  Other hooks in ~/.claude/settings.json preserved.');
    console.log('');
    console.log('Restart Claude Code (Cmd+Q + reopen) for the change to take effect.');
    return;
  }

  if (sub === 'status') {
    const r = getHookStatus();
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log(`settings file: ${r.settingsPath}`);
    if (!r.settingsExists) {
      console.log('  status: file does not exist');
      console.log('  hook:   NOT installed');
      return;
    }
    if (!r.settingsValid) {
      console.log('  status: file exists but is not valid JSON');
      console.log('  hook:   could not determine (fix settings file first)');
      return;
    }
    console.log(`  hook:   ${r.installed ? 'INSTALLED' : 'NOT installed'}`);
    if (r.installed) console.log(`  command: ${r.command}`);
    console.log(`  other SessionStart hooks: ${r.otherSessionStartHooks}`);
    if (!r.installed) {
      console.log('');
      console.log('Install with: memex hook install');
    }
    return;
  }

  console.error(`Unknown hook subcommand: ${sub}`);
  console.error('Run "memex hook --help" for usage.');
  process.exit(2);
}

// =============================================================
// HELP — print HELP.md content
// =============================================================
async function cmdHelp() {
  if (!existsSync(HELP_MD_PATH)) {
    console.error(`HELP.md not found at ${HELP_MD_PATH}`);
    console.error(`See https://github.com/parallelclaw/memex-mvp/blob/main/HELP.md`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(HELP_MD_PATH, 'utf-8'));
}

// =============================================================
// USAGE — `memex --help`
// =============================================================
async function cmdUsage() {
  console.log(`memex — local-first MCP memory server for AI agents

USAGE
  memex                          run as MCP stdio server (called by Claude Code,
                                 Cursor, Cline, Continue, Zed via MCP config)

  memex <command> [args]         run a one-shot terminal query and exit

COMMANDS
  search "<query>"               full-text search across all sources
    --source <name>              filter by source (telegram, claude-code, …)
    --chat "<title>"             filter by conversation title (substring)
    --project <path>             filter by project_path (substring)
    --sort <mode>                relevance | date_asc | date_desc
    --as-of YYYY-MM-DD           time-travel: only messages before this date
    --limit N                    max results (default 10, max 50)
    --json                       output JSON instead of markdown

  when "<query>"                 chronological "when did we talk about X" —
                                 one row per conversation, date + title, no snippets
    --source <name>              filter by source
    --limit N                    default 15, max 50
    --json

  recent                         most recent messages across all sources
    --limit N                    default 20, max 100
    --source <name>              filter by source
    --json

  list                           list conversations by recency
    --source <name>              filter by source
    --limit N                    default 20, max 200
    --json

  get <conversation_id>          full transcript of one conversation
    --limit N                    max messages (default 200, max 2000)
    --json

  overview                       corpus snapshot — sources, counts, recent chats
    --json

  projects                       list distinct project_paths captured
    --limit N                    default 50, max 500
    --json

  context                        output markdown summary of recent activity
                                 in current pwd (for Claude Code SessionStart
                                 hook — auto-injects context into new sessions)
    --pwd PATH                   override (default: $CLAUDE_PROJECT_DIR or cwd)
    --limit N                    max conversations to include (default 5)
    --budget-tokens N            cap output size (default 1500)
    --freshness-days N           only conversations newer than (default 90)
    --no-source NAME             exclude a source (repeatable; e.g. telegram)
    --json

  hook install                   install SessionStart hook in
                                 ~/.claude/settings.json (idempotent)
  hook uninstall                 remove only the memex hook entry
  hook status                    show whether the hook is installed

  help                           print the user guide (HELP.md)
  --help, -h                     this command reference
  --version, -v                  print package version

EXAMPLES
  memex search "Postgres migration"
  memex search "Q2 deck" --chat "Memex Bot"
  memex search "auth" --source claude-code --sort date_desc --limit 5
  memex list --source web --json | jq '.conversations[].title'
  memex get web-1582ab51a7b7

DAEMON COMMANDS (separate binary)
  memex-sync install             register the macOS LaunchAgent for auto-capture
  memex-sync status              daemon health + watched files
  memex-sync scan                one-time backfill of existing AI sessions
  memex-sync --help              full daemon CLI reference

For the full user guide:  memex help
On the web:                https://memex.parallelclaw.ai
`);
}

// =============================================================
// VERSION
// =============================================================
async function cmdVersion() {
  try {
    const pkgPath = join(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`memex-mvp ${pkg.version}`);
  } catch (_) {
    console.log('memex-mvp (version unknown)');
  }
}

// =============================================================
// DISPATCH
// =============================================================
export async function runCli(sub, args) {
  switch (sub) {
    case 'search':     return cmdSearch(args);
    case 'recent':     return cmdRecent(args);
    case 'list':       return cmdList(args);
    case 'get':        return cmdGet(args);
    case 'overview':   return cmdOverview(args);
    case 'projects':   return cmdProjects(args);
    case 'when':       return cmdWhen(args);
    case 'context':    return cmdContext(args);
    case 'hook':       return cmdHook(args);
    case 'help':       return cmdHelp();
    case '--help':
    case '-h':         return cmdUsage();
    case '--version':
    case '-v':         return cmdVersion();
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error(`Run 'memex --help' for usage.`);
      process.exit(2);
  }
}

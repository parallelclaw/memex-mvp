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
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------- Subcommand registry ----------
export const CLI_SUBCOMMAND_NAMES = [
  'search', 'recent', 'list', 'get', 'overview',
  'projects', 'help', '-h', '--help', '-v', '--version',
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
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({
      total_messages: totalMsgs,
      total_conversations: totalConvs,
      sources,
      recent_conversations: recentConvs,
    }, null, 2));
    return;
  }
  console.log(c.bold('memex corpus snapshot') + '\n');
  console.log(`Total: ${c.green(totalMsgs + ' messages')} in ${c.green(totalConvs + ' conversations')}\n`);
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
    --limit N                    max results (default 10, max 50)
    --json                       output JSON instead of markdown

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

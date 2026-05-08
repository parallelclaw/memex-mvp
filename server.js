#!/usr/bin/env node
/**
 * Memex MVP — Local MCP server for cross-agent AI memory
 * Layer 1 — Memory only (parse, store, search, retrieve)
 *
 * Drop a Telegram Desktop JSON export (or any supported format) into
 * ~/.memex/inbox/   and the server will index it automatically.
 *
 * Then point Claude Desktop / Claude Code at this binary via MCP config and
 * ask things like:
 *   "find what I discussed with my Telegram OpenClaw bot about pricing"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import chokidar from 'chokidar';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, existsSync, statSync } from 'node:fs';

// -------------------- Paths --------------------
const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const INBOX = join(MEMEX_DIR, 'inbox');
const DATA = join(MEMEX_DIR, 'data');
const ARCHIVE = join(DATA, 'conversations');
const DB_PATH = join(DATA, 'memex.db');
const LOG_PATH = join(DATA, 'memex.log');

[MEMEX_DIR, INBOX, DATA, ARCHIVE].forEach((d) => mkdirSync(d, { recursive: true }));

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  process.stderr.write(line);
  try {
    import('node:fs').then(({ appendFileSync }) =>
      appendFileSync(LOG_PATH, line)
    );
  } catch (_) {}
}

// -------------------- Database --------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    msg_id          TEXT,
    role            TEXT,
    sender          TEXT,
    text            TEXT,
    ts              INTEGER,
    metadata        TEXT,
    UNIQUE(source, conversation_id, msg_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, sender, conversation_id, source,
    content=messages, content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
    VALUES (new.id, new.text, new.sender, new.conversation_id, new.source);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
    VALUES (new.id, new.text, new.sender, new.conversation_id, new.source);
  END;

  CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    title           TEXT,
    first_ts        INTEGER,
    last_ts         INTEGER,
    message_count   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS imports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name       TEXT,
    source          TEXT,
    imported_at     INTEGER,
    message_count   INTEGER
  );
`);

// -------------------- Migrations --------------------
// archived_at on conversations (added 0.2): NULL = active, unix-ts = archived.
// SQLite ALTER TABLE ADD COLUMN throws if the column exists, so we swallow
// that specific error and rethrow anything else.
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN archived_at INTEGER`);
} catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// On re-imports the additive counter would drift (it doubles every time the
// same file gets reprocessed, because messages dedupe via UNIQUE(msg_id) but
// the counter would still add). Recompute message_count from the source of
// truth (the messages table) every time.
const upsertConversation = db.prepare(`
  INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(conversation_id) DO UPDATE SET
    title = excluded.title,
    first_ts = MIN(first_ts, excluded.first_ts),
    last_ts = MAX(last_ts, excluded.last_ts),
    message_count = (
      SELECT COUNT(*) FROM messages
       WHERE messages.conversation_id = conversations.conversation_id
    )
`);
const insertImport = db.prepare(`
  INSERT INTO imports (file_name, source, imported_at, message_count) VALUES (?, ?, ?, ?)
`);

// -------------------- Importers --------------------

/** Telegram Desktop JSON export (single chat or all_chats). */
function importTelegram(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));

  // Telegram Desktop produces either a single chat object or { chats: { list: [...] } }
  const chats = Array.isArray(raw.chats?.list)
    ? raw.chats.list
    : Array.isArray(raw.list)
    ? raw.list
    : raw.messages
    ? [raw]
    : [];

  let totalImported = 0;
  const myUserId = String(raw?.personal_information?.user_id || raw?.user_id || '');

  const tx = db.transaction((chatList) => {
    for (const chat of chatList) {
      if (!Array.isArray(chat.messages)) continue;

      const conversationId = `tg-${chat.id ?? chat.name ?? 'unknown'}`;
      const title =
        chat.name ||
        (chat.type === 'saved_messages' ? 'Saved Messages' : `Telegram chat ${chat.id}`);

      let first_ts = Infinity;
      let last_ts = 0;
      let chatMsgs = 0;

      for (const msg of chat.messages) {
        if (msg.type !== 'message') continue;

        // Telegram text can be a string or an array of {type, text} fragments
        let text = '';
        if (typeof msg.text === 'string') {
          text = msg.text;
        } else if (Array.isArray(msg.text)) {
          text = msg.text
            .map((f) => (typeof f === 'string' ? f : f.text || ''))
            .join('');
        }
        if (!text || !text.trim()) continue;

        const ts = parseInt(msg.date_unixtime || '0', 10);
        if (ts) {
          first_ts = Math.min(first_ts, ts);
          last_ts = Math.max(last_ts, ts);
        }

        const fromId = String(msg.from_id || '');
        const isMe =
          (myUserId && fromId === `user${myUserId}`) ||
          (myUserId && fromId === myUserId);
        const role = isMe ? 'user' : 'assistant';

        insertMessage.run(
          'telegram',
          conversationId,
          String(msg.id),
          role,
          msg.from || (isMe ? 'me' : 'bot'),
          text,
          ts,
          JSON.stringify({
            chat_name: chat.name,
            chat_type: chat.type,
            reply_to: msg.reply_to_message_id || null,
          })
        );
        chatMsgs += 1;
      }

      if (chatMsgs > 0) {
        upsertConversation.run(
          conversationId,
          'telegram',
          title,
          isFinite(first_ts) ? first_ts : null,
          last_ts || null,
          chatMsgs
        );
        totalImported += chatMsgs;
      }
    }
  });

  tx(chats);
  return totalImported;
}

/** Skip these top-level event types — they're not dialogue. */
const CLAUDE_CODE_SKIP_TYPES = new Set(['queue-operation', 'ai-title', 'summary']);

/** Auto-generated user messages produced by /compact, /resume, and
 *  continuation flows. They're real messages (we keep them in the
 *  index), but they're never useful as conversation titles. */
const CONTINUATION_PREFIXES = [
  'This session is being continued',
  'Continue from where you left off',
  'Please continue from where you left off',
];
function isContinuationBoilerplate(text) {
  for (const p of CONTINUATION_PREFIXES) if (text.startsWith(p)) return true;
  // XML/tag-wrapped artefacts (uploaded_files, system-reminder, command-name…)
  if (text.startsWith('<')) return true;
  return false;
}

/** Extract a clean dialogue message from a Claude Code JSONL record.
 *
 *  Handles both:
 *    1. Legacy flat shape (original spec):
 *       {"role":"user","content":"...","timestamp":"..."}
 *    2. Real nested shape (current Claude Code / Cowork on disk):
 *       {"type":"user","message":{"role":"user","content":"..."},"timestamp":"..."}
 *       {"parentUuid":"...","message":{"role":"assistant","content":[{type:"text",text:"..."},...]}}
 *
 *  Filters out everything that isn't human-readable dialogue:
 *    - queue-operation / ai-title / summary events
 *    - attachment-only records (deferred_tools_delta, skill_listing, plan_mode)
 *    - tool_use / tool_result / thinking / redacted_thinking / image content blocks
 *    - encrypted thinking signatures (multi-kilobyte base64 blobs)
 *
 *  Returns null when the record should be skipped, otherwise
 *  { role, text, id, timestamp }.
 */
function extractMessageFromRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Skip non-dialogue top-level event types
  if (CLAUDE_CODE_SKIP_TYPES.has(obj.type)) return null;

  // Skip attachment-only records (Claude Code harness bookkeeping)
  if (obj.attachment && !obj.message) return null;

  // Resolve role/content from either nested or flat shape
  const nested = obj.message;
  const fromNested = nested && typeof nested === 'object';
  const role = fromNested ? nested.role : obj.role;
  if (!role || typeof role !== 'string') return null;

  let rawContent;
  if (fromNested) {
    rawContent = nested.content;
  } else if (obj.content !== undefined) {
    rawContent = obj.content;
  } else {
    rawContent = obj.text;
  }

  // Normalise content into dialogue-only text
  let text = '';
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    const parts = [];
    for (const block of rawContent) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      // Only keep text-bearing blocks. Drop tool_use, tool_result, thinking,
      // redacted_thinking, image, and any future unknown block types.
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    text = parts.join('\n');
  }

  if (!text || !text.trim()) return null;

  const id = (fromNested && nested.id) || obj.id || null;
  const timestamp =
    obj.timestamp || (fromNested && nested.timestamp) || null;

  return { role, text, id, timestamp };
}

/** Claude Code or Cowork JSONL log (one JSON object per line).
 *  source: 'claude-code' or 'claude-cowork' (passed by caller based on filename prefix).
 *
 *  Reads BOTH the legacy flat shape and the real nested shape. Skips tool
 *  noise / queue-operations / encrypted thinking signatures via
 *  extractMessageFromRecord.
 */
function importClaudeCodeJsonl(filePath, source = 'claude-code') {
  const fileName = basename(filePath, '.jsonl');
  const conversationId = `${source}-${fileName}`;
  const sourceLabel = source === 'claude-cowork' ? 'Claude Cowork' : 'Claude Code';
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  let imported = 0;
  let first_ts = Infinity;
  let last_ts = 0;
  // Anthropic writes a human-readable title into the JSONL as an ai-title
  // record. We pick the latest one as the conversation title. If absent, we
  // fall back to the first user message (truncated), then to the file stem.
  let aiTitle = null;
  let firstUserText = null;

  const tx = db.transaction((rows) => {
    for (const line of rows) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }

      if (obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
        aiTitle = obj.aiTitle.trim();
        continue;
      }

      const msg = extractMessageFromRecord(obj);
      if (!msg) continue;
      // Index only proper dialogue turns. The 'tool_result' role (legacy
      // flat shape with string content) and 'system' role aren't user-facing.
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      const ts = msg.timestamp
        ? Math.floor(new Date(msg.timestamp).getTime() / 1000)
        : 0;
      if (ts) {
        first_ts = Math.min(first_ts, ts);
        last_ts = Math.max(last_ts, ts);
      }
      if (msg.role === 'user' && !firstUserText) {
        const text = msg.text.trim().replace(/\s+/g, ' ');
        // Continuation/resume sessions auto-generate boilerplate first
        // messages ("This session is being continued...", "Continue from
        // where you left off.", etc.) that aren't useful as titles —
        // skip them and let the next real user message win.
        if (text && !isContinuationBoilerplate(text)) {
          firstUserText = text.slice(0, 80);
        }
      }
      insertMessage.run(
        source,
        conversationId,
        msg.id,
        msg.role,
        msg.role === 'user' ? 'me' : source,
        msg.text,
        ts,
        JSON.stringify({ raw_type: obj.type || null })
      );
      imported += 1;
    }
  });

  tx(lines);

  if (imported > 0) {
    const title =
      aiTitle ||
      (firstUserText ? `${sourceLabel} · ${firstUserText}` : `${sourceLabel} · ${fileName}`);
    upsertConversation.run(
      conversationId,
      source,
      title,
      isFinite(first_ts) ? first_ts : null,
      last_ts || null,
      imported
    );
  }
  return imported;
}

/** Auto-detect format and import */
function importFile(filePath) {
  if (!existsSync(filePath)) return 0;
  const stats = statSync(filePath);
  if (!stats.isFile()) return 0;

  const lower = filePath.toLowerCase();
  const baseName = basename(lower);
  let imported = 0;
  let source = 'unknown';

  try {
    if (lower.endsWith('.json')) {
      const head = readFileSync(filePath, 'utf-8').slice(0, 8192);
      // Telegram has either "messages" or "chats" near the top
      if (
        head.includes('"messages"') ||
        head.includes('"chats"') ||
        head.includes('"personal_information"')
      ) {
        imported = importTelegram(filePath);
        source = 'telegram';
      }
    } else if (lower.endsWith('.jsonl')) {
      // Filename prefix lets feed-memex (or the user) tell us which
      // Anthropic product the session came from. Defaults to claude-code.
      source = baseName.startsWith('cowork-') ? 'claude-cowork' : 'claude-code';
      imported = importClaudeCodeJsonl(filePath, source);
    }
  } catch (err) {
    log('import error:', filePath, err.message);
    return 0;
  }

  if (imported > 0) {
    insertImport.run(
      basename(filePath),
      source,
      Math.floor(Date.now() / 1000),
      imported
    );

    // Move processed file to archive
    const targetDir = join(ARCHIVE, source);
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, basename(filePath));
    try {
      renameSync(filePath, target);
    } catch (_) {}

    log(`imported ${imported} messages from ${basename(filePath)} (${source})`);
  } else {
    log(`no messages imported from ${basename(filePath)}`);
  }
  return imported;
}

// -------------------- Watch inbox --------------------
chokidar
  .watch(INBOX, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 800 } })
  .on('add', (filePath) => {
    log('inbox detected:', basename(filePath));
    importFile(filePath);
  });

// -------------------- MCP Server --------------------
const server = new Server(
  { name: 'memex', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'memex_search',
    description:
      'Search across all your imported AI / chat history. Uses full-text search with stemming. ' +
      'Returns the most relevant message snippets with source, sender, timestamp, and conversation id. ' +
      'Use this when the user asks about past conversations, decisions, or things they discussed before.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Words or short phrase to look for. Supports FTS5 syntax: "podcast pricing" finds both words; "podcast OR price" matches either.',
        },
        limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
        source: {
          type: 'string',
          description: 'Optional filter: "telegram", "claude-code", "claude-cowork", etc.',
        },
        group_by_conversation: {
          type: 'boolean',
          default: true,
          description:
            'If true (default), returns one best-ranked hit per conversation along with a match_count of total matches in that chat. Set to false to get every individual matching message (legacy behaviour).',
        },
        include_archived: {
          type: 'boolean',
          default: false,
          description:
            'If true, also search inside archived conversations. Default: false (archived chats are excluded from search).',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description:
            'Output format. "markdown" (default) is a human-readable digest. "json" returns a structured array of result objects — useful for AI agents that want to parse fields directly.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memex_recent',
    description:
      'Return the most recent messages across all sources. Use when the user asks "what was I just talking about" or "show my latest discussions".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        source: { type: 'string', description: 'Optional source filter' },
        include_archived: {
          type: 'boolean',
          default: false,
          description: 'If true, also include messages from archived conversations.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
        },
      },
    },
  },
  {
    name: 'memex_get_conversation',
    description:
      'Return the full transcript of one conversation by its conversation_id (which other tools include in their output).',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 2000 },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
        },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'memex_list_conversations',
    description:
      'List conversations sorted by most recent activity. Use this to browse what chats exist ' +
      'across sources, or to find a specific conversation by title before pulling its full ' +
      'transcript with memex_get_conversation. Each entry has conversation_id, source, title, ' +
      'message_count, and date range.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 200 },
        source: {
          type: 'string',
          description: 'Optional source filter: "telegram", "claude-code", "claude-cowork", etc.',
        },
        since_ts: {
          type: 'integer',
          description: 'Optional Unix timestamp — only conversations with last activity at or after this time.',
        },
        include_archived: {
          type: 'boolean',
          default: false,
          description:
            'If true, also include archived conversations in the listing. Default: false.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
        },
      },
    },
  },
  {
    name: 'memex_archive_conversation',
    description:
      'Archive or unarchive a conversation. Archived chats stay fully indexed but are hidden ' +
      'from memex_list_conversations and memex_search by default — pass include_archived: true ' +
      'on those tools to include them. Use this to declutter the listing without losing data. ' +
      'Pass archive: false to unarchive.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        archive: {
          type: 'boolean',
          default: true,
          description: 'true (default) to archive, false to unarchive.',
        },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'memex_list_sources',
    description:
      'List which sources have been imported and how many messages are stored from each. Useful for diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
        },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === 'memex_search') {
      const limit = Math.min(50, Math.max(1, args.limit || 10));
      const groupByConv = args.group_by_conversation !== false; // default true
      const includeArchived = args.include_archived === true;
      const format = pickFormat(args);
      // FTS5 needs special handling for non-alphanumeric input — quote tokens
      const query = String(args.query || '')
        .trim()
        .replace(/[^\p{L}\p{N}_\-\s"]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!query) {
        return format === 'json'
          ? jsonResult({ query: args.query || '', count: 0, results: [], error: 'Empty query.' })
          : textResult('Empty query.');
      }

      const filters = [];
      const matchParams = [query];
      if (args.source) {
        filters.push('m.source = ?');
        matchParams.push(args.source);
      }
      if (!includeArchived) {
        filters.push('(c.archived_at IS NULL OR c.archived_at = 0)');
      }
      const filterClause = filters.length ? `AND ${filters.join(' AND ')}` : '';
      // When grouping, fetch wider so we have enough unique conversations after dedup.
      const fetchLimit = groupByConv ? Math.min(500, limit * 10) : limit;

      const sql = `
        SELECT m.id, m.source, m.conversation_id, m.sender, m.role,
               m.text, m.ts,
               snippet(messages_fts, 0, '<<', '>>', ' … ', 24) AS snippet,
               c.title AS conversation_title,
               c.archived_at AS archived_at
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.rowid
     LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
         WHERE messages_fts MATCH ?
           ${filterClause}
      ORDER BY rank
         LIMIT ?
      `;
      let rows = db.prepare(sql).all(...matchParams, fetchLimit);
      if (rows.length === 0) {
        return format === 'json'
          ? jsonResult({ query: args.query, count: 0, results: [] })
          : textResult(`No results for "${args.query}".`);
      }

      if (groupByConv) {
        // Real per-conversation match counts across the whole corpus, not just the fetched window.
        const counts = new Map();
        const countSql = `
          SELECT m.conversation_id, COUNT(*) AS match_count
            FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
       LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
           WHERE messages_fts MATCH ?
             ${filterClause}
           GROUP BY m.conversation_id
        `;
        for (const c of db.prepare(countSql).all(...matchParams)) {
          counts.set(c.conversation_id, c.match_count);
        }
        // Rows are rank-sorted, so the first occurrence per conversation is the best one.
        const seen = new Set();
        const deduped = [];
        for (const r of rows) {
          if (seen.has(r.conversation_id)) continue;
          seen.add(r.conversation_id);
          r.match_count = counts.get(r.conversation_id) || 1;
          deduped.push(r);
          if (deduped.length >= limit) break;
        }
        rows = deduped;
      }

      if (format === 'json') {
        return jsonResult({
          query: args.query,
          count: rows.length,
          grouped_by_conversation: groupByConv,
          results: rows.map((r) => ({
            conversation_id: r.conversation_id,
            title: r.conversation_title || null,
            source: r.source,
            ts: r.ts || null,
            date: fmtDateTime(r.ts),
            sender: r.sender || r.role,
            role: r.role,
            snippet: r.snippet,
            text: truncate(r.text, 360),
            match_count: groupByConv ? r.match_count : undefined,
            archived: !!r.archived_at,
          })),
        });
      }

      const formatted = rows
        .map((r, i) => {
          const date = fmtDateTime(r.ts) || '???';
          const matchSuffix =
            groupByConv && r.match_count > 1 ? ` · ${r.match_count} matches in this chat` : '';
          return [
            `### Result ${i + 1} · ${r.source} · ${date}${matchSuffix}`,
            `**${r.sender || r.role}** in ${r.conversation_title || r.conversation_id}`,
            `> ${r.snippet}`,
            `_full text:_ ${truncate(r.text, 360)}`,
            `_conversation_id:_ \`${r.conversation_id}\``,
          ].join('\n');
        })
        .join('\n\n---\n\n');

      const headerSuffix = groupByConv ? ' (one hit per conversation)' : '';
      return textResult(
        `Found ${rows.length} result(s)${headerSuffix} for "${args.query}":\n\n${formatted}`
      );
    }

    if (name === 'memex_recent') {
      const limit = Math.min(100, Math.max(1, args.limit || 20));
      const includeArchived = args.include_archived === true;
      const format = pickFormat(args);
      const filters = [];
      const params = [];
      if (args.source) {
        filters.push('m.source = ?');
        params.push(args.source);
      }
      if (!includeArchived) {
        filters.push('(c.archived_at IS NULL OR c.archived_at = 0)');
      }
      const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT m.id, m.source, m.conversation_id, m.sender, m.role, m.text, m.ts
             FROM messages m
        LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
             ${whereClause}
         ORDER BY m.ts DESC
            LIMIT ?`
        )
        .all(...params);

      if (rows.length === 0) {
        return format === 'json'
          ? jsonResult({ count: 0, messages: [] })
          : textResult('No messages stored yet.');
      }

      if (format === 'json') {
        return jsonResult({
          count: rows.length,
          messages: rows.map((r) => ({
            ts: r.ts || null,
            date: fmtDateTime(r.ts),
            sender: r.sender,
            role: r.role,
            source: r.source,
            conversation_id: r.conversation_id,
            text: truncate(r.text, 220),
          })),
        });
      }

      const formatted = rows
        .map((r) => {
          const date = fmtDateTime(r.ts) || '???';
          return `[${date}] **${r.sender}** (${r.source}): ${truncate(r.text, 220)}`;
        })
        .join('\n');
      return textResult(formatted);
    }

    if (name === 'memex_get_conversation') {
      const limit = Math.min(2000, Math.max(1, args.limit || 200));
      const format = pickFormat(args);
      const rows = db
        .prepare(
          `SELECT sender, role, text, ts
             FROM messages
            WHERE conversation_id = ?
         ORDER BY ts ASC
            LIMIT ?`
        )
        .all(args.conversation_id, limit);
      if (rows.length === 0) {
        return format === 'json'
          ? jsonResult({ conversation_id: args.conversation_id, count: 0, messages: [] })
          : textResult(`No messages found for ${args.conversation_id}.`);
      }
      if (format === 'json') {
        return jsonResult({
          conversation_id: args.conversation_id,
          count: rows.length,
          messages: rows.map((r) => ({
            ts: r.ts || null,
            date: fmtDateTime(r.ts),
            sender: r.sender,
            role: r.role,
            text: r.text,
          })),
        });
      }
      const formatted = rows
        .map((r) => `[${fmtDateTime(r.ts) || ''}] **${r.sender}**: ${r.text}`)
        .join('\n');
      return textResult(formatted);
    }

    if (name === 'memex_list_conversations') {
      const limit = Math.min(200, Math.max(1, args.limit || 20));
      const includeArchived = args.include_archived === true;
      const format = pickFormat(args);
      const where = [];
      const params = [];
      if (args.source) {
        where.push('source = ?');
        params.push(args.source);
      }
      if (args.since_ts) {
        where.push('last_ts >= ?');
        params.push(args.since_ts);
      }
      if (!includeArchived) {
        where.push('(archived_at IS NULL OR archived_at = 0)');
      }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);

      const rows = db
        .prepare(
          `SELECT conversation_id, source, title, first_ts, last_ts, message_count, archived_at
             FROM conversations
             ${whereClause}
         ORDER BY last_ts DESC
            LIMIT ?`
        )
        .all(...params);

      if (rows.length === 0) {
        return format === 'json'
          ? jsonResult({ count: 0, conversations: [] })
          : textResult('No conversations found.');
      }

      if (format === 'json') {
        return jsonResult({
          count: rows.length,
          include_archived: includeArchived,
          conversations: rows.map((r) => ({
            conversation_id: r.conversation_id,
            title: r.title || null,
            source: r.source,
            first_ts: r.first_ts || null,
            last_ts: r.last_ts || null,
            first_date: fmtDate(r.first_ts),
            last_date: fmtDate(r.last_ts),
            message_count: r.message_count,
            archived: !!r.archived_at,
            archived_at: r.archived_at || null,
          })),
        });
      }

      const lines = [`**${rows.length} conversation(s)** (most recent first):`, ''];
      for (const r of rows) {
        const first = fmtDate(r.first_ts) || '?';
        const last = fmtDate(r.last_ts) || '?';
        const range = first === last ? last : `${first} → ${last}`;
        const archMark = r.archived_at ? ' 🗄️' : '';
        lines.push(
          `- ${range} · **${r.source}**${archMark} · ${r.title || r.conversation_id} — ${r.message_count} msgs · \`${r.conversation_id}\``
        );
      }
      return textResult(lines.join('\n'));
    }

    if (name === 'memex_archive_conversation') {
      const archive = args.archive !== false; // default true
      const conversationId = String(args.conversation_id || '').trim();
      if (!conversationId) return textResult('conversation_id is required.');
      const ts = archive ? Math.floor(Date.now() / 1000) : null;
      const r = db
        .prepare('UPDATE conversations SET archived_at = ? WHERE conversation_id = ?')
        .run(ts, conversationId);
      if (r.changes === 0) return textResult(`Conversation not found: ${conversationId}`);
      const action = archive ? 'archived' : 'unarchived';
      return textResult(`✓ ${action}: \`${conversationId}\``);
    }

    if (name === 'memex_list_sources') {
      const format = pickFormat(args);
      const sources = db
        .prepare(
          `SELECT source, COUNT(*) AS msgs, COUNT(DISTINCT conversation_id) AS chats,
                  MIN(ts) AS first_ts, MAX(ts) AS last_ts
             FROM messages
         GROUP BY source
         ORDER BY msgs DESC`
        )
        .all();
      const total = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get().c;
      const archivedCount = db
        .prepare(`SELECT COUNT(*) AS c FROM conversations WHERE archived_at IS NOT NULL AND archived_at != 0`)
        .get().c;
      const imports = db
        .prepare(
          `SELECT file_name, source, message_count, imported_at
             FROM imports
         ORDER BY id DESC
            LIMIT 10`
        )
        .all();

      if (format === 'json') {
        return jsonResult({
          total_messages: total,
          archived_conversations: archivedCount,
          sources: sources.map((s) => ({
            source: s.source,
            messages: s.msgs,
            chats: s.chats,
            first_ts: s.first_ts || null,
            last_ts: s.last_ts || null,
            first_date: fmtDate(s.first_ts),
            last_date: fmtDate(s.last_ts),
          })),
          recent_imports: imports.map((i) => ({
            file_name: i.file_name,
            source: i.source,
            message_count: i.message_count,
            imported_at: i.imported_at,
            imported_at_date: fmtDateTime(i.imported_at),
          })),
          inbox_path: INBOX,
          db_path: DB_PATH,
        });
      }

      const lines = [`**Total messages:** ${total}`, ''];
      if (archivedCount > 0) lines.push(`**Archived conversations:** ${archivedCount}`, '');
      lines.push('### Sources');
      for (const s of sources) {
        const f = fmtDate(s.first_ts) || '?';
        const l = fmtDate(s.last_ts) || '?';
        lines.push(`- **${s.source}** — ${s.msgs} messages, ${s.chats} chat(s), from ${f} to ${l}`);
      }
      lines.push('');
      lines.push('### Recent imports');
      for (const i of imports) {
        const date = new Date(i.imported_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`- ${date} · ${i.file_name} (${i.source}) — ${i.message_count} msgs`);
      }
      lines.push('');
      lines.push(`_Inbox path:_ \`${INBOX}\``);
      lines.push(`_Database:_ \`${DB_PATH}\``);
      return textResult(lines.join('\n'));
    }

    return textResult(`Unknown tool: ${name}`);
  } catch (err) {
    log('tool error:', name, err.message);
    return textResult(`Error in ${name}: ${err.message}`);
  }
});

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}
function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function pickFormat(args) {
  return args.format === 'json' ? 'json' : 'markdown';
}
function fmtDate(ts) {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
}
function fmtDateTime(ts) {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : null;
}
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// -------------------- Start --------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log('memex MCP server started · inbox:', INBOX, '· db:', DB_PATH);

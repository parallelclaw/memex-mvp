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

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertConversation = db.prepare(`
  INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(conversation_id) DO UPDATE SET
    title = excluded.title,
    first_ts = MIN(first_ts, excluded.first_ts),
    last_ts = MAX(last_ts, excluded.last_ts),
    message_count = message_count + excluded.message_count
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
        firstUserText = msg.text.trim().replace(/\s+/g, ' ').slice(0, 80);
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
      },
    },
  },
  {
    name: 'memex_list_sources',
    description:
      'List which sources have been imported and how many messages are stored from each. Useful for diagnostics.',
    inputSchema: { type: 'object', properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === 'memex_search') {
      const limit = Math.min(50, Math.max(1, args.limit || 10));
      const groupByConv = args.group_by_conversation !== false; // default true
      // FTS5 needs special handling for non-alphanumeric input — quote tokens
      const query = String(args.query || '')
        .trim()
        .replace(/[^\p{L}\p{N}_\-\s"]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!query) return textResult('Empty query.');

      const sourceFilter = args.source ? `AND m.source = ?` : '';
      // When grouping, fetch wider so we have enough unique conversations after dedup.
      const fetchLimit = groupByConv ? Math.min(500, limit * 10) : limit;
      const matchParams = args.source ? [query, args.source] : [query];

      const sql = `
        SELECT m.id, m.source, m.conversation_id, m.sender, m.role,
               m.text, m.ts,
               snippet(messages_fts, 0, '<<', '>>', ' … ', 24) AS snippet,
               c.title AS conversation_title
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.rowid
     LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
         WHERE messages_fts MATCH ?
           ${sourceFilter}
      ORDER BY rank
         LIMIT ?
      `;
      let rows = db.prepare(sql).all(...matchParams, fetchLimit);
      if (rows.length === 0)
        return textResult(`No results for "${args.query}".`);

      if (groupByConv) {
        // Real per-conversation match counts across the whole corpus, not just the fetched window.
        const counts = new Map();
        const countSql = `
          SELECT m.conversation_id, COUNT(*) AS match_count
            FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
           WHERE messages_fts MATCH ?
             ${sourceFilter}
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

      const formatted = rows
        .map((r, i) => {
          const date = r.ts ? new Date(r.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '???';
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
      const sourceFilter = args.source ? `WHERE source = ?` : '';
      const params = args.source ? [args.source, limit] : [limit];
      const rows = db
        .prepare(
          `SELECT id, source, conversation_id, sender, role, text, ts
             FROM messages
             ${sourceFilter}
         ORDER BY ts DESC
            LIMIT ?`
        )
        .all(...params);

      if (rows.length === 0) return textResult('No messages stored yet.');
      const formatted = rows
        .map((r) => {
          const date = r.ts ? new Date(r.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '???';
          return `[${date}] **${r.sender}** (${r.source}): ${truncate(r.text, 220)}`;
        })
        .join('\n');
      return textResult(formatted);
    }

    if (name === 'memex_get_conversation') {
      const limit = Math.min(2000, Math.max(1, args.limit || 200));
      const rows = db
        .prepare(
          `SELECT sender, role, text, ts
             FROM messages
            WHERE conversation_id = ?
         ORDER BY ts ASC
            LIMIT ?`
        )
        .all(args.conversation_id, limit);
      if (rows.length === 0)
        return textResult(`No messages found for ${args.conversation_id}.`);
      const formatted = rows
        .map((r) => {
          const date = r.ts ? new Date(r.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
          return `[${date}] **${r.sender}**: ${r.text}`;
        })
        .join('\n');
      return textResult(formatted);
    }

    if (name === 'memex_list_conversations') {
      const limit = Math.min(200, Math.max(1, args.limit || 20));
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
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);

      const rows = db
        .prepare(
          `SELECT conversation_id, source, title, first_ts, last_ts, message_count
             FROM conversations
             ${whereClause}
         ORDER BY last_ts DESC
            LIMIT ?`
        )
        .all(...params);

      if (rows.length === 0) return textResult('No conversations found.');

      const fmtDate = (ts) =>
        ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '?';
      const lines = [`**${rows.length} conversation(s)** (most recent first):`, ''];
      for (const r of rows) {
        const first = fmtDate(r.first_ts);
        const last = fmtDate(r.last_ts);
        const range = first === last ? last : `${first} → ${last}`;
        lines.push(
          `- ${range} · **${r.source}** · ${r.title || r.conversation_id} — ${r.message_count} msgs · \`${r.conversation_id}\``
        );
      }
      return textResult(lines.join('\n'));
    }

    if (name === 'memex_list_sources') {
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
      const imports = db
        .prepare(
          `SELECT file_name, source, message_count, imported_at
             FROM imports
         ORDER BY id DESC
            LIMIT 10`
        )
        .all();

      const lines = [`**Total messages:** ${total}`, ''];
      lines.push('### Sources');
      for (const s of sources) {
        const f = s.first_ts ? new Date(s.first_ts * 1000).toISOString().slice(0, 10) : '?';
        const l = s.last_ts ? new Date(s.last_ts * 1000).toISOString().slice(0, 10) : '?';
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
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// -------------------- Start --------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log('memex MCP server started · inbox:', INBOX, '· db:', DB_PATH);

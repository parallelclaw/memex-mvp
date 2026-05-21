/**
 * SQLite layer for memex-openclaw.
 *
 * Opens the shared memex.db at ~/.memex/data/memex.db (override via
 * plugin config db_path), creates the schema if absent, exposes
 * insert/search/get operations.
 *
 * Schema parity with memex-mvp (Node) and memex-hermes (Python) — all
 * three write to the SAME memex.db using identical tables, columns,
 * and the UNIQUE(source, conversation_id, msg_id) constraint that
 * makes inserts idempotent.
 *
 * WAL mode → concurrent reads from memex CLI / MCP server are safe
 * while we write.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const DEFAULT_DB_PATH = '~/.memex/data/memex.db';

/**
 * Expand `~` and turn a possibly-relative path into an absolute one.
 */
export function resolveDbPath(p) {
  if (!p || typeof p !== 'string') p = DEFAULT_DB_PATH;
  let s = p.trim();
  if (s.startsWith('~/')) s = homedir() + s.slice(1);
  else if (s === '~') s = homedir();
  return resolve(s);
}

function safeAlter(db, sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!String(err.message).toLowerCase().includes('duplicate column')) throw err;
  }
}

/**
 * Apply the memex.db schema. Idempotent — every CREATE uses IF NOT
 * EXISTS, ALTERs swallow "duplicate column" errors. Safe to call
 * against an existing memex.db created by memex-mvp or memex-hermes.
 */
export function initialiseSchema(db) {
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

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id        TEXT PRIMARY KEY,
      source                 TEXT NOT NULL,
      title                  TEXT,
      first_ts               INTEGER,
      last_ts                INTEGER,
      message_count          INTEGER DEFAULT 0
    );
  `);

  safeAlter(db, 'ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  safeAlter(db, 'ALTER TABLE messages ADD COLUMN uuid TEXT');
  safeAlter(db, 'ALTER TABLE messages ADD COLUMN channel TEXT');
  safeAlter(db, 'ALTER TABLE conversations ADD COLUMN archived_at INTEGER');
  safeAlter(db, 'ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT');
  safeAlter(db, 'ALTER TABLE conversations ADD COLUMN project_path TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_uuid
      ON messages(uuid) WHERE uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(channel) WHERE channel IS NOT NULL;

    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
      WHEN new.role != 'summary' BEGIN
        INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
        VALUES (new.id, new.text, new.sender, new.conversation_id, new.source);
      END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
      INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
        SELECT new.id, new.text, new.sender, new.conversation_id, new.source
         WHERE new.role != 'summary';
    END;
  `);
}

export class MemexStore {
  constructor(dbPath) {
    this.dbPath = resolveDbPath(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    initialiseSchema(this.db);

    // Prepared statements (faster on the hot path).
    this._insertMsg = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (source, conversation_id, msg_id, role, sender, text, ts, metadata, channel)
      VALUES ('openclaw', @conversationId, @msgId, @role, @sender, @text, @ts, @metadata, @channel)
    `);

    this._upsertConv = this.db.prepare(`
      INSERT INTO conversations
        (conversation_id, source, title, first_ts, last_ts, message_count)
      VALUES (@conversationId, 'openclaw', @title, @firstTs, @lastTs, 0)
      ON CONFLICT(conversation_id) DO UPDATE SET
        title    = COALESCE(conversations.title, excluded.title),
        first_ts = MIN(COALESCE(conversations.first_ts, excluded.first_ts), excluded.first_ts),
        last_ts  = MAX(COALESCE(conversations.last_ts,  excluded.last_ts),  excluded.last_ts),
        message_count = (
          SELECT COUNT(*) FROM messages
           WHERE messages.conversation_id = conversations.conversation_id
        )
    `);

    this._searchStmt = this.db.prepare(`
      SELECT m.id, m.ts, m.role, m.conversation_id, m.channel,
             substr(m.text, 1, 100) AS preview
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
       WHERE f.text MATCH ? AND m.source = 'openclaw'
       ORDER BY m.ts DESC
       LIMIT ?
    `);

    this._getStmt = this.db.prepare(`
      SELECT id, ts, role, sender, conversation_id, channel, text, metadata
        FROM messages
       WHERE id = ? AND source = 'openclaw'
    `);

    this._countStmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages WHERE source = 'openclaw'
    `);
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /**
   * Insert one verbatim message. Returns true if a new row was created,
   * false if the UNIQUE constraint deduped it (idempotent).
   */
  insertMessage({ conversationId, msgId, role, text, ts, channel, sender, metadata }) {
    if (!text || !String(text).trim()) return false;
    const senderNorm = sender || (role === 'user' ? 'me' : 'openclaw');
    const result = this._insertMsg.run({
      conversationId,
      msgId,
      role,
      sender: senderNorm,
      text: String(text),
      ts: ts || Math.floor(Date.now() / 1000),
      metadata: JSON.stringify(metadata || {}),
      channel: channel ?? null,
    });
    return result.changes > 0;
  }

  upsertConversation({ conversationId, title, firstTs, lastTs }) {
    this._upsertConv.run({
      conversationId,
      title: title || conversationId,
      firstTs: firstTs ?? null,
      lastTs: lastTs ?? null,
    });
  }

  /**
   * FTS5 search restricted to source='openclaw'. Returns abbreviated rows
   * (id + ts + role + 100-char preview) — full text is fetched via getById()
   * to support the progressive-disclosure pattern.
   */
  search(query, limit = 10) {
    if (!query || !String(query).trim()) return [];
    try {
      return this._searchStmt.all(String(query).trim(), Math.min(Math.max(Number(limit) || 10, 1), 50));
    } catch (err) {
      // Malformed FTS5 syntax — return empty rather than crash.
      return [];
    }
  }

  getById(id) {
    const row = this._getStmt.get(Number(id));
    if (!row) return null;
    try { row.metadata = JSON.parse(row.metadata || '{}'); }
    catch { row.metadata = {}; }
    return row;
  }

  count() {
    return this._countStmt.get().n;
  }
}

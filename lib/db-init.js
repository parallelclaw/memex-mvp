/**
 * Schema-init for memex.db, factored out of server.js so the daemon
 * (memex-sync install) and any other entry point can create the DB
 * idempotently before the MCP server is ever spawned.
 *
 * Why: on a clean machine the MCP server is the first writer that opens
 * the DB. If a user runs `memex-sync install` + `memex-sync scan` then
 * tries `memex overview` BEFORE restarting their MCP client, the CLI
 * (which opens the DB in read-only mode) errors with "memex.db not
 * found". Fix: have the daemon initialise the DB at install-time —
 * empty tables, but openable.
 *
 * Public:
 *   initializeDb(dbPath) → Database
 *      Opens the DB (creating the file if missing), runs every migration
 *      in the right order, and returns the better-sqlite3 handle. Caller
 *      is responsible for closing it.
 *
 * Idempotent — safe to call against an existing DB with content. Every
 * CREATE / ALTER / DROP+CREATE is wrapped to swallow "already exists"
 * style errors.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Create or open ~/.memex/data/memex.db, apply all schema migrations,
 * return the handle. Same code path that server.js used to run inline
 * — extracted so memex-sync (and tests, and tooling) can run it too.
 */
export function initializeDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Base tables + indices + FTS5 virtual table. CREATE IF NOT EXISTS
  // makes this safe against existing DBs.
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

  // ALTER-style migrations — these run idempotently by swallowing the
  // "duplicate column" error. Same set + same order as server.js.
  const safeAlter = (sql) => {
    try { db.exec(sql); }
    catch (err) {
      if (!String(err.message).includes('duplicate column name')) throw err;
    }
  };
  safeAlter(`ALTER TABLE conversations ADD COLUMN archived_at INTEGER`);
  safeAlter(`ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT`);
  safeAlter(`ALTER TABLE conversations ADD COLUMN project_path TEXT`);
  safeAlter(`ALTER TABLE conversations ADD COLUMN pending_parent_uuid TEXT`);
  safeAlter(`ALTER TABLE messages ADD COLUMN edited_at INTEGER`);
  safeAlter(`ALTER TABLE messages ADD COLUMN uuid TEXT`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_project
             ON conversations(project_path) WHERE project_path IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_uuid
             ON messages(uuid) WHERE uuid IS NOT NULL`);

  // Pre-0.4 imports tables could have duplicate rows from re-running the
  // server. Collapse before installing the UNIQUE index.
  db.exec(`
    DELETE FROM imports
     WHERE id NOT IN (
       SELECT MAX(id) FROM imports GROUP BY file_name, source, message_count
     )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_imports_unique
             ON imports(file_name, source, message_count)`);

  // FTS5 triggers (rewritten 0.6) — exclude role IN ('boundary','summary')
  // from messages_fts so synthetic compaction summaries don't double-count
  // against the original raw turns. Drop+create is idempotent.
  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
      WHEN new.role NOT IN ('boundary', 'summary')
    BEGIN
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
         WHERE new.role NOT IN ('boundary', 'summary');
    END;
  `);

  return db;
}

// Smoke test for the memex_search `sort` parameter.
//
// Verifies that the three ORDER BY variants used in server.js's
// memex_search handler (relevance-with-boost, date_asc, date_desc)
// produce valid SQL against the real messages_fts schema and order
// rows the way the spec says.
//
// We can't import server.js (it boots an MCP server and opens the
// user's DB on import), so we replicate the schema and the ORDER BY
// clauses verbatim. If the SQL strings drift in server.js, this test
// won't catch that drift — but it does catch syntax errors and
// validates the row-ordering behaviour the schema relies on.
//
// Run: node test/search-sort.test.js

import Database from 'better-sqlite3';

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assertEq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
  }
}

// Build an in-memory DB with the minimum schema memex_search reads.
function buildDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      source TEXT,
      conversation_id TEXT,
      sender TEXT,
      role TEXT,
      text TEXT,
      ts INTEGER
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      project_path TEXT,
      archived_at INTEGER
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id',
      tokenize='unicode61'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // Three "Q2 launch deck" versions across different dates + one with no ts.
  const ins = db.prepare(`
    INSERT INTO messages (id, source, conversation_id, sender, role, text, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  ins.run(1, 'telegram', 'c1', 'me', 'user', 'Q2 launch deck v1 — first draft of the launch slides', 1700000000);
  ins.run(2, 'telegram', 'c2', 'me', 'user', 'Q2 launch deck v2 — revised launch numbers', 1710000000);
  ins.run(3, 'telegram', 'c3', 'me', 'user', 'Q2 launch deck final — shipping launch version', 1720000000);
  ins.run(4, 'telegram', 'c4', 'me', 'user', 'Q2 launch deck stray copy with no timestamp', 0);

  db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('c1', 'v1', null);
  db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('c2', 'v2', null);
  db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('c3', 'final', null);
  db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('c4', 'stray', null);

  return db;
}

// These ORDER BY strings MUST match the ones in server.js memex_search.
const ORDER_BY = {
  relevance_with_boost: `bm25(messages_fts) * exp(-(CAST(strftime('%s','now') AS REAL) - COALESCE(NULLIF(m.ts, 0), CAST(strftime('%s','now') AS REAL))) / 86400.0 / ?)`,
  date_asc: 'CASE WHEN m.ts IS NULL OR m.ts = 0 THEN 1 ELSE 0 END, m.ts ASC',
  date_desc: 'CASE WHEN m.ts IS NULL OR m.ts = 0 THEN 1 ELSE 0 END, m.ts DESC',
};

function buildSql(orderBy) {
  return `
    SELECT m.id, m.ts
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
 LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE messages_fts MATCH ?
       AND (c.archived_at IS NULL OR c.archived_at = 0)
  ORDER BY ${orderBy}
     LIMIT ?
  `;
}

console.log('memex_search sort modes:\n');

const db = buildDb();

test('relevance + recency boost: SQL is valid, returns hits', () => {
  const sql = buildSql(ORDER_BY.relevance_with_boost);
  const rows = db.prepare(sql).all('launch', 30, 10);
  assertEq(rows.length, 4, 'should match all four rows');
});

test('date_asc: oldest first, ts=0 row pushed to the end', () => {
  const sql = buildSql(ORDER_BY.date_asc);
  const rows = db.prepare(sql).all('launch', 10);
  assertEq(rows.map(r => r.id), [1, 2, 3, 4], 'ascending real-dated rows, then the ts=0 stray');
});

test('date_desc: newest first, ts=0 row pushed to the end', () => {
  const sql = buildSql(ORDER_BY.date_desc);
  const rows = db.prepare(sql).all('launch', 10);
  assertEq(rows.map(r => r.id), [3, 2, 1, 4], 'descending real-dated rows, then the ts=0 stray');
});

test('date sort still respects FTS5 MATCH filter', () => {
  const sql = buildSql(ORDER_BY.date_asc);
  const rows = db.prepare(sql).all('final', 10);
  assertEq(rows.map(r => r.id), [3], 'only the row containing "final" survives the MATCH');
});

// ---------- chat filter (matches the same LOWER(c.title) LIKE LOWER(?) clause
// memex_search builds in server.js — see the filterClause section.) ----------

console.log('\nmemex_search chat filter:\n');

// Seed three additional rows in distinctly-titled conversations to verify
// that LOWER(...) LIKE LOWER('%text%') narrows results to the right chat.
const insExtra = db.prepare(`
  INSERT INTO messages (id, source, conversation_id, sender, role, text, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insExtra.run(10, 'telegram', 'tg-memex-bot-12345', 'me', 'user', 'mobile idea about launch', 1730000000);
insExtra.run(11, 'telegram', 'tg-12345',             'me', 'user', 'launch reminder from Saved Messages',  1730000100);
insExtra.run(12, 'telegram', 'tg-wife',              'me', 'user', 'launch dinner reminder',               1730000200);
db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('tg-memex-bot-12345', 'Memex Bot', null);
db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('tg-12345',            'Saved Messages', null);
db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run('tg-wife',             'Wife', null);

function buildSqlWithChat(orderBy) {
  return `
    SELECT m.id, c.title
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
 LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE messages_fts MATCH ?
       AND (c.archived_at IS NULL OR c.archived_at = 0)
       AND LOWER(c.title) LIKE LOWER(?)
  ORDER BY ${orderBy}
     LIMIT ?
  `;
}

test('chat="Memex Bot" returns only the bot thread, NOT Saved Messages', () => {
  const sql = buildSqlWithChat(ORDER_BY.date_desc);
  const rows = db.prepare(sql).all('launch', '%Memex Bot%', 50);
  assertEq(rows.map(r => r.id), [10], 'only msg 10 (bot chat) — msg 11 lives in Saved Messages and must be excluded');
});

test('chat filter is case-insensitive ("memex bot" matches "Memex Bot")', () => {
  const sql = buildSqlWithChat(ORDER_BY.date_desc);
  const rows = db.prepare(sql).all('launch', '%memex bot%', 50);
  assertEq(rows.map(r => r.id), [10], 'lowercase query still hits the titled chat');
});

test('chat filter substring-matches partial titles ("wife" matches "Wife")', () => {
  const sql = buildSqlWithChat(ORDER_BY.date_desc);
  const rows = db.prepare(sql).all('launch', '%wife%', 50);
  assertEq(rows.map(r => r.id), [12]);
});

test('chat filter without a match returns empty', () => {
  const sql = buildSqlWithChat(ORDER_BY.date_desc);
  const rows = db.prepare(sql).all('launch', '%no-such-chat%', 50);
  assertEq(rows.length, 0);
});

db.close();

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

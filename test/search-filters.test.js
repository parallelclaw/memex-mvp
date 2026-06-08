// Regression test for memex_search Tier-1 retrieval filters:
//   - conversation_id  (exact within-session keyword search)
//   - since_ts/until_ts (date-range WINDOW, not just sort/boost)
//
// Motivation: agents (OpenClaw) couldn't scope a keyword search to one big
// session, nor filter "topic in June" — search only had sort + recency boost,
// never a date filter. These params add both. Like search-sort.test.js we
// replicate the exact filter SQL the handler builds (server.js memex_search);
// if those clauses drift this won't catch it, but it locks in the behaviour.
//
// Run: node test/search-filters.test.js

import Database from 'better-sqlite3';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assertEq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
  }
}

function buildDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, source TEXT, conversation_id TEXT,
      sender TEXT, role TEXT, text TEXT, ts INTEGER
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, title TEXT, project_path TEXT, archived_at INTEGER
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, content='messages', content_rowid='id', tokenize='unicode61'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);
  const ins = db.prepare(
    `INSERT INTO messages (id, source, conversation_id, sender, role, text, ts) VALUES (?,?,?,?,?,?,?)`
  );
  const JUN1 = 1780272000;  // 2026-06-01T00:00:00Z (approx, fixed constant for the test)
  const DAY = 86400;
  // Session A — "tunnel" mentioned on May, June 2, June 7
  ins.run(1, 'openclaw', 'sessA', 'me', 'user', 'tunnel notes from may',  JUN1 - 10 * DAY);
  ins.run(2, 'openclaw', 'sessA', 'me', 'user', 'tunnel fix june second', JUN1 + 1 * DAY);
  ins.run(3, 'openclaw', 'sessA', 'me', 'user', 'tunnel watchdog june 7', JUN1 + 6 * DAY);
  // Session B — also mentions "tunnel", but a different session + a no-ts row
  ins.run(4, 'openclaw', 'sessB', 'me', 'user', 'tunnel idea other session', JUN1 + 2 * DAY);
  ins.run(5, 'openclaw', 'sessB', 'me', 'user', 'tunnel with no timestamp', 0);
  for (const id of ['sessA', 'sessB'])
    db.prepare('INSERT INTO conversations (conversation_id, title, archived_at) VALUES (?,?,?)').run(id, id, null);
  return { db, JUN1, DAY };
}

// Mirror the handler's filter clauses (server.js memex_search).
function search(db, { since, until, convId } = {}) {
  const filters = [];
  const params = ['tunnel'];
  if (convId) { filters.push('m.conversation_id = ?'); params.push(convId); }
  if (Number.isFinite(since)) { filters.push('m.ts >= ?'); params.push(Math.floor(since)); }
  if (Number.isFinite(until)) { filters.push('m.ts <= ?'); params.push(Math.floor(until)); }
  const clause = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT m.id FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
 LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE messages_fts MATCH ? ${clause}
  ORDER BY m.ts ASC LIMIT 50`;
  return db.prepare(sql).all(...params).map(r => r.id);
}

console.log('memex_search Tier-1 filters:\n');
const { db, JUN1, DAY } = buildDb();

test('no filters: matches every "tunnel" row across both sessions', () => {
  assertEq(search(db).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('conversation_id: scopes keyword search to ONE session', () => {
  assertEq(search(db, { convId: 'sessA' }), [1, 2, 3]);
});

test('since_ts: excludes the May row (older than the bound)', () => {
  // June 1 onward → drops id 1 (May). id 5 has ts=0, excluded by numeric bound.
  assertEq(search(db, { since: JUN1 }), [2, 4, 3]); // ts order: J+1(2), J+2(4), J+6(3)
});

test('until_ts: excludes rows after the upper bound', () => {
  // up to June 3 → keeps May(1), J+1(2), J+2(4); drops J+6(3). id5 ts=0 kept? 0<=until → yes.
  assertEq(search(db, { until: JUN1 + 3 * DAY }).sort((a, b) => a - b), [1, 2, 4, 5]);
});

test('since_ts + until_ts: a bounded window (June 1–3)', () => {
  assertEq(search(db, { since: JUN1, until: JUN1 + 3 * DAY }), [2, 4]);
});

test('date window excludes ts=0 rows (numeric lower bound)', () => {
  // since present → id5 (ts=0) must NOT appear
  const ids = search(db, { since: JUN1 });
  assertEq(ids.includes(5), false, 'ts=0 row must be excluded when since_ts is set');
});

test('conversation_id + date window compose (sessA, June 1–3)', () => {
  assertEq(search(db, { convId: 'sessA', since: JUN1, until: JUN1 + 3 * DAY }), [2]);
});

db.close();
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

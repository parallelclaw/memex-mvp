// Regression test for memex_get_conversation paging (offset + order + total).
//
// The bug: the handler did `ORDER BY ts ASC LIMIT ?` with no offset and no
// order option. A 2962-message session could only ever return its FIRST N
// (oldest) messages — the freshest tail was unreachable. (Found live when
// OpenClaw on VPS1 could not show June messages of a 2951-msg Claude Code
// session.) Fix: add `offset`, `order` ('asc'|'desc'), and report `total`.
//
// We can't import server.js (it boots an MCP server on import), so — like
// search-sort.test.js — we replicate the exact SQL the handler builds. If the
// SQL drifts in server.js this won't catch it, but it locks in the paging
// behaviour the fix relies on.
//
// Run: node test/get-conversation-paging.test.js

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

function buildDb(n) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, source TEXT, conversation_id TEXT,
    sender TEXT, role TEXT, text TEXT, ts INTEGER
  );`);
  const ins = db.prepare(
    `INSERT INTO messages (id, source, conversation_id, sender, role, text, ts) VALUES (?,?,?,?,?,?,?)`
  );
  // n messages in the target conv (ts = i so order is unambiguous) + noise in another conv.
  for (let i = 1; i <= n; i++) ins.run(i, 'claude-code', 'big', 'me', 'user', `msg ${i}`, 1700000000 + i);
  ins.run(9001, 'claude-code', 'other', 'me', 'user', 'unrelated', 1700000000);
  return db;
}

// SQL clauses MUST mirror the memex_get_conversation handler in server.js.
const totalSql = `SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (?)`;
const pageSql = (order) =>
  `SELECT id, ts FROM messages WHERE conversation_id IN (?) ORDER BY ts ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`;

console.log('memex_get_conversation paging:\n');

const N = 2962;                         // mirrors the live session that exposed the bug
const db = buildDb(N);

test('total counts the whole conversation, not the returned window', () => {
  assertEq(db.prepare(totalSql).get('big').n, N);
});

test('total excludes other conversations', () => {
  // 'other' has exactly 1 row; 'big' must not absorb it.
  assertEq(db.prepare(totalSql).get('other').n, 1);
});

test('asc offset 0: returns the OLDEST window (the old broken-only behaviour)', () => {
  const rows = db.prepare(pageSql('asc')).all('big', 3, 0);
  assertEq(rows.map(r => r.id), [1, 2, 3]);
});

test('desc offset 0: returns the FRESHEST window (the fix) — newest first', () => {
  const rows = db.prepare(pageSql('desc')).all('big', 3, 0);
  assertEq(rows.map(r => r.id), [N, N - 1, N - 2]);
});

test('asc offset (total-2): tail via paging equals the last 2 messages', () => {
  const rows = db.prepare(pageSql('asc')).all('big', 200, N - 2);
  assertEq(rows.map(r => r.id), [N - 1, N]);
});

test('desc tail == asc tail reversed (consistency of the two paths)', () => {
  const asc = db.prepare(pageSql('asc')).all('big', 2, N - 2).map(r => r.id);   // [N-1, N]
  const desc = db.prepare(pageSql('desc')).all('big', 2, 0).map(r => r.id);     // [N, N-1]
  assertEq([...asc].reverse(), desc);
});

test('offset past the end returns an empty window (caller must not crash)', () => {
  const rows = db.prepare(pageSql('asc')).all('big', 200, N + 100);
  assertEq(rows.length, 0);
});

test('middle page is contiguous and correctly offset', () => {
  const rows = db.prepare(pageSql('asc')).all('big', 5, 1000);
  assertEq(rows.map(r => r.id), [1001, 1002, 1003, 1004, 1005]);
});

db.close();
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

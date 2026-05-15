// Tests for lib/parse-telegram-html.js — Telegram Desktop HTML export
// parser. Uses the fixture at test/fixtures/telegram-html/ChatExport_Test/
// plus an in-memory DB integration test that runs the parsed output
// through the same importTelegram logic server.js uses.

import {
  detectTelegramHtml,
  parseTelegramHtmlExport,
} from '../lib/parse-telegram-html.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'telegram-html', 'ChatExport_Test');
const FIXTURE_FILE = join(FIXTURE_DIR, 'messages.html');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 3).join('\n'));
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
  }
}

console.log('detectTelegramHtml:\n');

test('directory with messages.html → type=dir', () => {
  const r = detectTelegramHtml(FIXTURE_DIR);
  assertEq(r.type, 'dir');
  assert(r.htmlFiles.length === 1);
  assert(r.htmlFiles[0].endsWith('messages.html'));
});

test('bare messages.html file → type=file', () => {
  const r = detectTelegramHtml(FIXTURE_FILE);
  assertEq(r.type, 'file');
  assertEq(r.htmlFiles.length, 1);
});

test('random directory → null', () => {
  const r = detectTelegramHtml(REPO_ROOT);
  assertEq(r.type, null);
});

test('non-existent path → null, empty list', () => {
  const r = detectTelegramHtml('/tmp/__does_not_exist__');
  assertEq(r.type, null);
  assertEq(r.htmlFiles, []);
});

test('JSON file (not HTML) → null', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-html-test-'));
  try {
    const f = join(tmp, 'result.json');
    writeFileSync(f, '{"chats":{"list":[]}}');
    const r = detectTelegramHtml(f);
    assertEq(r.type, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('non-Telegram HTML (random page) is rejected', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-html-test-'));
  try {
    const f = join(tmp, 'messages.html');
    writeFileSync(f, '<html><body>Some random page, not Telegram</body></html>');
    const r = detectTelegramHtml(f);
    assertEq(r.type, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log('\nparseTelegramHtmlExport:\n');

test('extracts chat title from <title> tag', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  assertEq(r.chats.list[0].name, 'Alice Test');
});

test('extracts all 6 non-service messages', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  assertEq(msgs.length, 6, `expected 6 messages, got ${msgs.length}`);
});

test('skips service messages (joined/left/name change)', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  // Fixture has a service message with id 1005 — should NOT appear
  assert(!msgs.some((m) => m.id === 1005), 'service message 1005 should be filtered');
});

test('joined message inherits sender from previous', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  const msg1002 = msgs.find((m) => m.id === 1002);
  assertEq(msg1002.from, 'Alice', 'joined message should inherit Alice as sender');
});

test('different sender breaks joined chain', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  const msg1003 = msgs.find((m) => m.id === 1003);
  assertEq(msg1003.from, 'Bob');
});

test('forwarded message has forwarded_from field', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  const fwd = msgs.find((m) => m.id === 1006);
  assert(fwd.forwarded_from, `expected forwarded_from on msg 1006`);
  assert(fwd.forwarded_from.includes('Channel X'), `got: ${fwd.forwarded_from}`);
});

test('reply is captured as text prefix', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  const reply = msgs.find((m) => m.id === 1004);
  assert(reply.text.startsWith('↩ Reply:'), `expected reply prefix, got: ${reply.text}`);
  assert(reply.text.includes('Got it, thanks Bob'), 'main message body should follow');
});

test('photo-only message → "[photo]" placeholder', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msgs = r.chats.list[0].messages;
  const photo = msgs.find((m) => m.id === 1007);
  assertEq(photo.text, '[photo]');
});

test('dates parsed to unix timestamps', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  const msg1001 = r.chats.list[0].messages.find((m) => m.id === 1001);
  // 2024-01-15 10:23:45 UTC+03:00 = 2024-01-15 07:23:45 UTC = 1705303425
  assertEq(msg1001.date_unixtime, '1705303425');
});

test('output shape is compatible with importTelegram', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  assert(r.personal_information, 'has personal_information');
  assert(Array.isArray(r.chats.list), 'has chats.list array');
  for (const msg of r.chats.list[0].messages) {
    assert(typeof msg.id === 'number', 'msg.id is number');
    assertEq(msg.type, 'message');
    assert(typeof msg.date_unixtime === 'string', 'date_unixtime is string');
    assert(typeof msg.text === 'string', 'text is string');
  }
});

test('non-Telegram path returns null', () => {
  const r = parseTelegramHtmlExport(REPO_ROOT);
  assertEq(r, null);
});

// ---------- Integration: parse → importTelegram round-trip ----------
console.log('\nintegration with importTelegram shape:\n');

test('parsed output ingests cleanly into in-memory DB via same importTelegram logic', () => {
  const r = parseTelegramHtmlExport(FIXTURE_DIR);
  // Replicate the importTelegram function's minimal logic against an
  // in-memory DB. If the shape is right, all 6 messages land.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, conversation_id TEXT, msg_id TEXT,
      role TEXT, sender TEXT, text TEXT, ts INTEGER,
      UNIQUE(source, conversation_id, msg_id)
    );
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages (source, conversation_id, msg_id, role, sender, text, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const chat of r.chats.list) {
    const convId = `tg-${chat.id}`;
    for (const m of chat.messages) {
      insert.run('telegram', convId, String(m.id), 'user', m.from, m.text, parseInt(m.date_unixtime, 10) || 0);
    }
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  assertEq(count, 6, `expected 6 inserted, got ${count}`);
  db.close();
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

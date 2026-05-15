// Tests for lib/cli/* — the terminal-mode subcommands.
//
// We spin up an in-memory copy of memex.db schema, seed it with a few
// rows, point MEMEX_DIR at a temp dir, and invoke the CLI via
// child_process to confirm the user-visible behaviour:
//   - Each subcommand prints expected output
//   - --json produces parseable JSON
//   - --help and --version run without crashing
//   - Unknown subcommands fail with exit 2
//   - The `memex` binary still boots into MCP mode when called with
//     no args (we don't fully test the MCP protocol here — that's
//     covered by manual smoke + the existing handler tests — but we
//     confirm that the dispatch logic doesn't accidentally short-
//     circuit MCP mode).
//
// The CLI doesn't touch the production DB at ~/.memex/data/memex.db
// because we override MEMEX_DIR via env.

import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SERVER_JS = join(REPO_ROOT, 'server.js');

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

// ---------- Set up an isolated MEMEX_DIR with a seeded DB ----------
const TEST_DIR = mkdtempSync(join(tmpdir(), 'memex-cli-test-'));
const DATA_DIR = join(TEST_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, 'memex.db');

function seedDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, conversation_id TEXT, msg_id TEXT,
      role TEXT, sender TEXT, text TEXT, ts INTEGER, metadata TEXT,
      edited_at INTEGER, uuid TEXT,
      UNIQUE(source, conversation_id, msg_id)
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      source TEXT, title TEXT,
      first_ts INTEGER, last_ts INTEGER, message_count INTEGER,
      parent_conversation_id TEXT, project_path TEXT,
      archived_at INTEGER
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, sender, conversation_id, source,
      content='messages', content_rowid='id', tokenize='unicode61'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
        VALUES (new.id, new.text, new.sender, new.conversation_id, new.source);
    END;
  `);

  const insM = db.prepare(`
    INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insC = db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Three conversations, mixed sources, easy to grep by content
  insC.run('chat-tg-1',  'telegram',    'Wife',         1700000000, 1700001000, 2, null);
  insM.run('telegram',   'chat-tg-1', '1', 'user', 'me', 'разговор про launch ужина',         1700000000);
  insM.run('telegram',   'chat-tg-1', '2', 'user', 'me', 'договорились на 7 вечера в Пушкине', 1700001000);

  insC.run('chat-cc-1',  'claude-code', 'Postgres migration session', 1710000000, 1710002000, 1, '/home/user/proj-a');
  insM.run('claude-code','chat-cc-1', '1', 'user', 'me', 'разберись с Postgres миграцией для launch', 1710000000);

  insC.run('chat-web-1', 'web',         'Article about memex Bush',    1720000000, 1720000000, 1, null);
  insM.run('web',        'chat-web-1', '1', 'document', 'wikipedia.org', 'Vannevar Bush proposed the memex in 1945 as a means to enhance human thought.', 1720000000);

  db.close();
}
seedDb();

// ---------- Helper: invoke server.js as the user would ----------
function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [SERVER_JS, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, MEMEX_DIR: TEST_DIR },
    timeout: 10000,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

console.log('memex CLI dispatch:\n');

test('--version prints package version', () => {
  const r = runCli(['--version']);
  assertEq(r.code, 0, '--version should exit 0');
  assert(/^memex-mvp \d+\.\d+\.\d+/.test(r.stdout.trim()), `unexpected: ${r.stdout}`);
});

test('--help prints command reference', () => {
  const r = runCli(['--help']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('USAGE'), 'should have USAGE section');
  assert(r.stdout.includes('search "<query>"'), 'should mention search');
  assert(r.stdout.includes('memex-sync'), 'should reference the daemon binary');
});

test('-h is alias for --help', () => {
  const r = runCli(['-h']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('USAGE'));
});

test('overview shows seeded corpus snapshot', () => {
  const r = runCli(['overview']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('4 messages'), `expected 4 messages, got: ${r.stdout}`);
  assert(r.stdout.includes('3 conversations'), `expected 3 conversations, got: ${r.stdout}`);
  assert(r.stdout.includes('telegram'));
  assert(r.stdout.includes('claude-code'));
  assert(r.stdout.includes('web'));
});

test('overview --json returns parseable structured output', () => {
  const r = runCli(['overview', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.total_messages, 4);
  assertEq(parsed.total_conversations, 3);
  assert(Array.isArray(parsed.sources));
});

test('search finds messages by FTS5 keyword', () => {
  const r = runCli(['search', 'Postgres']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('Postgres'), 'should highlight match');
  assert(r.stdout.includes('claude-code'), 'should show source');
});

test('search with --source filter narrows results', () => {
  const r = runCli(['search', 'launch', '--source', 'telegram']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('telegram'));
  // The claude-code chat also has "launch" but should be filtered out
  assert(!r.stdout.includes('claude-code'), `claude-code should be filtered: ${r.stdout}`);
});

test('search --json returns structured results', () => {
  const r = runCli(['search', 'Bush', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.query, 'Bush');
  assert(parsed.results.length >= 1);
  assert(parsed.results[0].snippet.includes('Bush'));
});

test('search with empty query exits 2', () => {
  const r = runCli(['search', '']);
  assertEq(r.code, 2);
});

test('search with --chat filter matches by conversation title', () => {
  const r = runCli(['search', 'launch', '--chat', 'Wife']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('Wife') || r.stdout.includes('telegram'));
});

test('recent shows newest first', () => {
  const r = runCli(['recent', '--limit', '2']);
  assertEq(r.code, 0);
  // Most recent ts is 1720000000 (Bush article)
  assert(r.stdout.includes('Bush'), `expected web doc first, got: ${r.stdout}`);
});

test('recent --json structured', () => {
  const r = runCli(['recent', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.count > 0);
});

test('list shows all conversations', () => {
  const r = runCli(['list']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('3 conversation'), `expected count, got: ${r.stdout}`);
  assert(r.stdout.includes('Wife'));
  assert(r.stdout.includes('Postgres'));
});

test('list --source filter', () => {
  const r = runCli(['list', '--source', 'web']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('Bush'));
  assert(!r.stdout.includes('Wife'));
});

test('get returns full conversation transcript', () => {
  const r = runCli(['get', 'chat-tg-1']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('launch ужина'), 'msg 1');
  assert(r.stdout.includes('Пушкине'), 'msg 2');
});

test('get with non-existent id exits 1', () => {
  const r = runCli(['get', 'no-such-id']);
  assertEq(r.code, 1);
});

test('get --json returns conversation + messages array', () => {
  const r = runCli(['get', 'chat-tg-1', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.conversation.conversation_id, 'chat-tg-1');
  assert(parsed.messages.length === 2);
});

test('projects lists distinct project_paths', () => {
  const r = runCli(['projects']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('proj-a'), `expected proj-a in: ${r.stdout}`);
});

test('unknown subcommand fails with exit 2', () => {
  const r = runCli(['fooooooo']);
  assertEq(r.code, 2);
  assert(r.stderr.includes('Unknown subcommand'));
});

test('search supports --sort date_desc', () => {
  const r = runCli(['search', 'launch', '--sort', 'date_desc', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  // 'launch' appears in two messages — at ts 1700000000 (telegram) and ts 1710000000 (claude-code).
  // date_desc → claude-code first.
  if (parsed.results.length >= 2) {
    assert(parsed.results[0].ts >= parsed.results[1].ts, 'should be sorted newest-first');
  }
});

// ---------- v0.8.1 — D8 search --as-of ----------

test('search --as-of filters out newer messages', () => {
  // Seed messages span 1700000000 (Nov 2023) → 1720000000 (Jul 2024).
  // --as-of 2024-01-01 (~1704067200 UTC) should keep only the oldest.
  const r = runCli(['search', 'launch', '--as-of', '2024-01-01', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  // ts 1700000000 (Nov 14, 2023) is BEFORE Jan 1, 2024 cutoff → kept
  // ts 1710000000 (Mar 9, 2024) is AFTER cutoff → filtered out
  for (const result of parsed.results) {
    assert(result.ts < 1704067200, `expected ts < 2024-01-01 unix, got ${result.ts}`);
  }
});

test('search --as-of with invalid date exits 2', () => {
  const r = runCli(['search', 'foo', '--as-of', 'tomorrow']);
  assertEq(r.code, 2);
  assert(r.stderr.includes('Invalid --as-of'), `got: ${r.stderr}`);
});

// ---------- v0.8.1 — D5 memex when ----------

test('when: chronological list of conversations matching keyword', () => {
  const r = runCli(['when', 'launch']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('mentioned in'));
  // Should aggregate by conversation, not raw message hits
  // Two distinct chats touch "launch": chat-tg-1 (telegram) + chat-cc-1 (claude-code)
  assert(r.stdout.includes('telegram') && r.stdout.includes('claude-code'),
    `expected both sources: ${r.stdout}`);
});

test('when --json returns structured per-conversation aggregation', () => {
  const r = runCli(['when', 'launch', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.count >= 2);
  assert(parsed.results[0].match_count >= 1);
  assert(parsed.results[0].latest_ts, 'should have latest_ts');
});

test('when: no results exits 0 with friendly message', () => {
  // Use single word to avoid FTS5 treating hyphens as NOT operators
  const r = runCli(['when', 'xyzqqnoresult']);
  assertEq(r.code, 0);
  assert(r.stdout.includes('No mentions'));
});

test('when: empty query exits 2', () => {
  const r = runCli(['when', '']);
  assertEq(r.code, 2);
});

// ---------- v0.8.1 — D6 capture streak ----------

test('overview includes capture streak when there is recent activity', () => {
  // Need a message with ts ≈ now for streak to register
  const db = new Database(DB_PATH);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('telegram', 'chat-streak', 'streak-1', 'user', 'me', 'streak ping', now - 100);
  db.close();

  const r = runCli(['overview', '--json']);
  assertEq(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.streak, 'streak block should be present');
  assert(parsed.streak.streakDays >= 1, `expected streak >= 1, got: ${JSON.stringify(parsed.streak)}`);
  assert(parsed.streak.todayMessages >= 1);
});

// ---------- Cleanup ----------
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

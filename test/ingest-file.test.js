// Tests for lib/ingest-file.js — single-call ingest of arbitrary file paths.
//
// Telegram-import flow (needs_consent / skipped) is covered via the bash
// smoke test in scripts/test-ingest-file.sh because the privacy gate
// resolves DECISIONS_PATH via homedir() at module load — we'd need a
// child-process to test hermetically. For unit-level coverage here we test:
//   - resolvePath / detectFormat helpers (pure, no I/O state)
//   - ingestFile error paths (missing file, unknown format)
//   - ingestFile Claude/Cowork JSONL (no decisions involvement)

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ingestFile, detectFormat, resolvePath } from '../lib/ingest-file.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}\n${e.stack || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m = '') {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
}

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), 'memex-ingest-'));
  const dbPath = join(root, 'memex.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, conversation_id TEXT NOT NULL, msg_id TEXT,
      role TEXT, sender TEXT, text TEXT, ts INTEGER,
      metadata TEXT, edited_at INTEGER, uuid TEXT,
      UNIQUE(source, conversation_id, msg_id)
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, source TEXT NOT NULL,
      title TEXT, first_ts INTEGER, last_ts INTEGER, message_count INTEGER DEFAULT 0,
      archived_at INTEGER, parent_conversation_id TEXT, project_path TEXT,
      pending_parent_uuid TEXT
    );
  `);
  return { db, root, dbPath };
}

console.log('ingest-file:\n');

await test('resolvePath: expands ~', () => {
  const home = process.env.HOME || '';
  assert(resolvePath('~/foo').startsWith(home));
  assert(resolvePath('~').toLowerCase() === home.toLowerCase());
});

await test('resolvePath: keeps absolute paths', () => {
  assertEq(resolvePath('/tmp/x'), '/tmp/x');
});

await test('resolvePath: empty input → null', () => {
  assertEq(resolvePath(''), null);
  assertEq(resolvePath(null), null);
});

await test('detectFormat: missing file → null', () => {
  assertEq(detectFormat('/nonexistent/x.json'), null);
});

await test('detectFormat: Telegram JSON content', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const p = join(root, 'export.json');
  writeFileSync(p, '{"chats":{"list":[]},"messages":[]}');
  assertEq(detectFormat(p), 'telegram-json');
  rmSync(root, { recursive: true, force: true });
});

await test('detectFormat: random .json without TG markers → null', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const p = join(root, 'random.json');
  writeFileSync(p, '{"foo": "bar"}');
  assertEq(detectFormat(p), null);
  rmSync(root, { recursive: true, force: true });
});

await test('detectFormat: .jsonl → claude-jsonl', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const p = join(root, 'session.jsonl');
  writeFileSync(p, '{"type":"user"}\n');
  assertEq(detectFormat(p), 'claude-jsonl');
  rmSync(root, { recursive: true, force: true });
});

await test('detectFormat: cowork-*.jsonl → cowork-jsonl', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const p = join(root, 'cowork-abc.jsonl');
  writeFileSync(p, '{}\n');
  assertEq(detectFormat(p), 'cowork-jsonl');
  rmSync(root, { recursive: true, force: true });
});

await test('detectFormat: directory with messages.html → telegram-html', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const dir = join(root, 'ChatExport_x');
  mkdirSync(dir);
  writeFileSync(join(dir, 'messages.html'), '<html/>');
  assertEq(detectFormat(dir), 'telegram-html');
  rmSync(root, { recursive: true, force: true });
});

await test('detectFormat: directory with nested result.json → telegram-json-in-dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const dir = join(root, 'ChatExport_y');
  mkdirSync(dir);
  writeFileSync(join(dir, 'result.json'), '{}');
  assertEq(detectFormat(dir), 'telegram-json-in-dir');
  rmSync(root, { recursive: true, force: true });
});

await test('ingestFile: missing path → error', async () => {
  const { db, root } = freshDb();
  try {
    const r = await ingestFile(db, '/nonexistent/file.json');
    assertEq(r.status, 'error');
    assert(r.error.includes('not found'));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('ingestFile: Claude JSONL → imported', async () => {
  const { db, root } = freshDb();
  const p = join(root, 'session.jsonl');
  writeFileSync(p,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'first prompt' }, timestamp: '2026-05-17T10:00:00Z', uuid: 'a1' }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply' }, timestamp: '2026-05-17T10:00:01Z', uuid: 'a2', parentUuid: 'a1' }) + '\n'
  );
  try {
    const r = await ingestFile(db, p);
    assertEq(r.status, 'imported');
    assertEq(r.format, 'claude-jsonl');
    assert(r.total_imported >= 2, `expected >= 2, got ${r.total_imported}`);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    assertEq(rows, 2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('ingestFile: Cowork JSONL via filename prefix', async () => {
  const { db, root } = freshDb();
  const p = join(root, 'cowork-abc.jsonl');
  writeFileSync(p,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'cowork prompt' }, timestamp: '2026-05-17T10:00:00Z', uuid: 'b1' }) + '\n'
  );
  try {
    const r = await ingestFile(db, p);
    assertEq(r.status, 'imported');
    assertEq(r.format, 'cowork-jsonl');
    const rows = db.prepare("SELECT source, COUNT(*) AS n FROM messages GROUP BY source").get();
    assertEq(rows.source, 'claude-cowork');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('ingestFile: re-importing JSONL is idempotent (UNIQUE dedup)', async () => {
  const { db, root } = freshDb();
  const p = join(root, 'session.jsonl');
  writeFileSync(p,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' }, timestamp: '2026-05-17T10:00:00Z', uuid: 'c1' }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'two' }, timestamp: '2026-05-17T10:00:01Z', uuid: 'c2', parentUuid: 'c1' }) + '\n'
  );
  try {
    await ingestFile(db, p);
    await ingestFile(db, p);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    assertEq(rows, 2, 'second import should not duplicate');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('ingestFile: unsupported format (.txt) → error', async () => {
  const { db, root } = freshDb();
  const p = join(root, 'note.txt');
  writeFileSync(p, 'hello world');
  try {
    const r = await ingestFile(db, p);
    assertEq(r.status, 'error');
    assert(r.error.toLowerCase().includes('detect'));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('ingestFile: explicit format= override works for .txt', async () => {
  const { db, root } = freshDb();
  const p = join(root, 'unlabeled');
  writeFileSync(p,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'overridden' }, timestamp: '2026-05-17T10:00:00Z', uuid: 'd1' }) + '\n'
  );
  try {
    const r = await ingestFile(db, p, { format: 'claude-jsonl' });
    assertEq(r.status, 'imported');
    assert(r.total_imported >= 1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

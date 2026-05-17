// End-to-end test: a fresh server.js process must pick up an inbox file
// AND its subsequent overwrites, with all records landing in the DB.
// This is the integration counterpart to test/inbox-watcher.test.js
// (which only verifies chokidar emits events) — here we actually spin up
// server.js, write inbox files like the ingest daemon does, and assert
// the database catches up.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');

let passed = 0, failed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }
function fail(name, e) { console.error(`  ❌ ${name}: ${e.message}\n${e.stack || ''}`); failed++; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withSession(fn) {
  const root = mkdtempSync(join(tmpdir(), 'memex-e2e-'));
  const dataDir = join(root, 'data');
  const inboxDir = join(root, 'inbox');
  const stagingDir = join(root, 'staging');
  const archiveDir = join(root, 'archive');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  // Pre-create the DB so we can poll it from this process while server.js writes.
  const dbPath = join(dataDir, 'memex.db');

  // Spin up server.js as a child. Run as MCP-stdio mode (no subcommand).
  // We never speak MCP to it; we only need its inbox watcher.
  const env = { ...process.env, MEMEX_DIR: root, HOME: root };
  // server.js writes its own log to ~/.memex/data/server.log — fine.
  const child = spawn('node', [SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for the server to settle (DB created, watcher up).
  // Poll until DB exists AND has the messages table.
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const r = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get();
        db.close();
        if (r) break;
      } catch (_) { /* not ready */ }
    }
    await sleep(120);
  }
  // chokidar needs another moment to attach to inbox/
  await sleep(500);

  try {
    await fn({ root, dataDir, inboxDir, stagingDir, archiveDir, dbPath, stderr: () => stderr });
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { rmSync(root, { recursive: true, force: true }); } catch (_) { /* ok */ }
  }
}

function makeRecord(role, text, ts, uuid, parentUuid) {
  // Daemon snapshot format (lib/web ... wait, no — inbox snapshot format
  // from ingest.js emitToInbox):
  return JSON.stringify({
    role, content: text, timestamp: ts,
    uuid: uuid || null,
    parentUuid: parentUuid || null,
    id: 'code-fake-' + (uuid || ts).slice(0, 16),
  });
}

function dropInboxSnapshot(stagingDir, inboxDir, name, records) {
  const stagePath = join(stagingDir, name);
  const inboxPath = join(inboxDir, name);
  writeFileSync(stagePath, records.join('\n') + '\n');
  renameSync(stagePath, inboxPath);
}

async function pollCount(dbPath, conversationId, expectedMin, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const r = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(conversationId);
      db.close();
      if (r && r.n >= expectedMin) return r.n;
    } catch (_) { /* DB might be locked or partial */ }
    await sleep(150);
  }
  throw new Error(`timeout waiting for >=${expectedMin} rows in ${conversationId}`);
}

console.log('e2e-inbox:\n');

await withSession(async ({ inboxDir, stagingDir, archiveDir, dbPath }) => {
  try {
    // ----- Step 1: first snapshot lands -----
    const conv = 'claude-code-code-fake';
    dropInboxSnapshot(stagingDir, inboxDir, 'code-fake.jsonl', [
      makeRecord('user', 'first user msg', '2026-05-17T10:00:00Z', 'u1'.padEnd(36, '-'), null),
      makeRecord('assistant', 'first assistant', '2026-05-17T10:00:01Z', 'a1'.padEnd(36, '-'), 'u1'.padEnd(36, '-')),
    ]);

    const c1 = await pollCount(dbPath, conv, 2);
    if (c1 < 2) throw new Error(`step 1: expected >= 2, got ${c1}`);
    ok(`step 1: first snapshot → ${c1} rows in DB`);
    // Inbox file should be archived
    if (existsSync(join(inboxDir, 'code-fake.jsonl'))) {
      throw new Error('step 1: inbox file should have been archived but still exists');
    }
    ok('step 1: file archived from inbox');

    // ----- Step 2: daemon overwrites with grown snapshot — THE BUG CASE -----
    // Because we always archive (Fix 2), the inbox is now empty. Next snapshot
    // is a fresh 'add'. But let's still test the 'change' path: re-drop into
    // the inbox WHILE another file with same name might be there.
    dropInboxSnapshot(stagingDir, inboxDir, 'code-fake.jsonl', [
      makeRecord('user', 'first user msg', '2026-05-17T10:00:00Z', 'u1'.padEnd(36, '-'), null),
      makeRecord('assistant', 'first assistant', '2026-05-17T10:00:01Z', 'a1'.padEnd(36, '-'), 'u1'.padEnd(36, '-')),
      makeRecord('user', 'second user', '2026-05-17T10:00:02Z', 'u2'.padEnd(36, '-'), 'a1'.padEnd(36, '-')),
      makeRecord('assistant', 'second assistant', '2026-05-17T10:00:03Z', 'a2'.padEnd(36, '-'), 'u2'.padEnd(36, '-')),
    ]);

    const c2 = await pollCount(dbPath, conv, 4);
    if (c2 < 4) throw new Error(`step 2: expected >= 4, got ${c2}`);
    ok(`step 2: rewrite with 2 new records → ${c2} rows in DB`);

    // ----- Step 3: immediate second rewrite (test 'change' path specifically) -----
    // Manually create the file in inbox to make the next drop a true overwrite.
    writeFileSync(join(inboxDir, 'code-fake.jsonl'), 'dummy content that will be replaced\n');
    await sleep(300);

    dropInboxSnapshot(stagingDir, inboxDir, 'code-fake.jsonl', [
      makeRecord('user', 'first user msg', '2026-05-17T10:00:00Z', 'u1'.padEnd(36, '-'), null),
      makeRecord('assistant', 'first assistant', '2026-05-17T10:00:01Z', 'a1'.padEnd(36, '-'), 'u1'.padEnd(36, '-')),
      makeRecord('user', 'second user', '2026-05-17T10:00:02Z', 'u2'.padEnd(36, '-'), 'a1'.padEnd(36, '-')),
      makeRecord('assistant', 'second assistant', '2026-05-17T10:00:03Z', 'a2'.padEnd(36, '-'), 'u2'.padEnd(36, '-')),
      makeRecord('user', 'third user', '2026-05-17T10:00:04Z', 'u3'.padEnd(36, '-'), 'a2'.padEnd(36, '-')),
    ]);

    const c3 = await pollCount(dbPath, conv, 5);
    if (c3 < 5) throw new Error(`step 3 (true overwrite): expected >= 5, got ${c3}`);
    ok(`step 3: overwrite-after-overwrite → ${c3} rows in DB`);

    // ----- Step 4: imported=0 case (re-send same content) -----
    dropInboxSnapshot(stagingDir, inboxDir, 'code-fake.jsonl', [
      makeRecord('user', 'third user', '2026-05-17T10:00:04Z', 'u3'.padEnd(36, '-'), 'a2'.padEnd(36, '-')),
    ]);
    // Wait a moment for the watcher to process
    await sleep(1500);

    // Count should be unchanged (all dupes)
    const dbRO = new Database(dbPath, { readonly: true });
    const c4 = dbRO.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(conv).n;
    dbRO.close();
    if (c4 !== c3) throw new Error(`step 4: count should stay at ${c3}, got ${c4}`);
    ok(`step 4: full-dupe snapshot → no growth, still ${c4} rows`);
    if (existsSync(join(inboxDir, 'code-fake.jsonl'))) {
      throw new Error('step 4: even imported=0 file should be archived');
    }
    ok('step 4: imported=0 file archived (Fix 2)');

  } catch (e) { fail('e2e flow', e); }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

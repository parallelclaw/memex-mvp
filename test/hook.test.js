// Tests for lib/hook/install.js + the `memex context` and `memex hook` CLI commands.
//
// We isolate writes by pointing the hook module at a temp directory via the
// HOME env var (the module reads $HOME at import time, so we set it before
// requiring the module via dynamic import in an isolated test process).
//
// For CLI subcommand tests (memex context, memex hook *), we spawn server.js
// as a child process with MEMEX_DIR + HOME overrides — same pattern as cli.test.js.

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

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

// ---------- Isolated HOME per test ----------
function makeTestHome() {
  const home = mkdtempSync(join(tmpdir(), 'memex-hook-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

// Spawn server.js as CLI with HOME and MEMEX_DIR overridden
function runCli(home, args) {
  const res = spawnSync(process.execPath, [SERVER_JS, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, MEMEX_DIR: join(home, '.memex') },
    timeout: 10000,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// Seed minimal memex.db so `memex context` doesn't fail to open DB
function seedDb(home) {
  const dataDir = join(home, '.memex', 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'memex.db'));
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
  // Seed: 2 convs in /test-project, 1 in /other-project, 1 with fuzzy title match
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('chat-1', 'claude-code', 'Direct work on test-project',  now - 86400, now - 3600, 5, '/tmp/test-project');
  db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('chat-2', 'claude-cowork', 'Subagent in test-project', now - 7200, now - 1800, 3, '/tmp/test-project');
  db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('chat-3', 'claude-code', 'Unrelated work', now - 86400, now - 7200, 2, '/tmp/other-project');
  db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('chat-4', 'telegram', 'Chat about test-project budget', now - 14400, now - 900, 4, null);
  db.close();
}

// =============================================================
console.log('hook install/uninstall/status:\n');

test('status on fresh home: file does not exist', () => {
  const home = makeTestHome();
  try {
    const r = runCli(home, ['hook', 'status']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('file does not exist'), `got: ${r.stdout}`);
    assert(r.stdout.includes('NOT installed'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install: writes settings.json with SessionStart entry', () => {
  const home = makeTestHome();
  try {
    const r = runCli(home, ['hook', 'install']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('installed'), `got: ${r.stdout}`);

    const settingsPath = join(home, '.claude', 'settings.json');
    assert(existsSync(settingsPath), 'settings.json not created');
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert(Array.isArray(data.hooks?.SessionStart), 'SessionStart array missing');
    assertEq(data.hooks.SessionStart.length, 1);
    const entry = data.hooks.SessionStart[0];
    assert(entry.matcher, 'matcher missing');
    assert(Array.isArray(entry.hooks) && entry.hooks.length === 1);
    const inner = entry.hooks[0];
    assertEq(inner.type, 'command');
    assert(inner.command.includes('memex context'), `command should include 'memex context': ${inner.command}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install is idempotent: re-running detects existing entry', () => {
  const home = makeTestHome();
  try {
    runCli(home, ['hook', 'install']);
    const r = runCli(home, ['hook', 'install']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('already installed'), `got: ${r.stdout}`);

    const data = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assertEq(data.hooks.SessionStart.length, 1, 'should not duplicate entries');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install preserves existing OTHER hooks (e.g. gstack)', () => {
  const home = makeTestHome();
  try {
    // Pre-populate settings.json with a non-memex hook (mimicking gstack)
    const settingsPath = join(home, '.claude', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '.*', hooks: [{ type: 'command', command: '/path/to/gstack/preamble.sh' }] }
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/path/to/other-tool.sh' }] }
        ]
      }
    }, null, 2));

    const r = runCli(home, ['hook', 'install']);
    assertEq(r.code, 0);

    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // gstack hook should still be there
    assertEq(data.hooks.SessionStart.length, 2, `SessionStart entries should be gstack + memex, got ${data.hooks.SessionStart.length}`);
    const gstackEntry = data.hooks.SessionStart.find((e) =>
      e.hooks.some((h) => h.command.includes('gstack'))
    );
    assert(gstackEntry, 'gstack entry was removed');
    // PreToolUse should be completely untouched
    assertEq(data.hooks.PreToolUse.length, 1);
    assert(data.hooks.PreToolUse[0].hooks[0].command.includes('other-tool'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('status: shows INSTALLED after install', () => {
  const home = makeTestHome();
  try {
    runCli(home, ['hook', 'install']);
    const r = runCli(home, ['hook', 'status']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('INSTALLED'), `expected INSTALLED, got: ${r.stdout}`);
    assert(r.stdout.includes('memex context'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall: removes only memex entry, preserves others', () => {
  const home = makeTestHome();
  try {
    // Set up: gstack hook + then memex hook
    const settingsPath = join(home, '.claude', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '.*', hooks: [{ type: 'command', command: '/path/to/gstack/preamble.sh' }] }
        ]
      }
    }, null, 2));
    runCli(home, ['hook', 'install']);

    // Now uninstall
    const r = runCli(home, ['hook', 'uninstall']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('removed'), `got: ${r.stdout}`);

    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assertEq(data.hooks.SessionStart.length, 1, 'gstack entry should remain');
    assert(data.hooks.SessionStart[0].hooks[0].command.includes('gstack'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall on fresh home: no-op, exits 0', () => {
  const home = makeTestHome();
  try {
    const r = runCli(home, ['hook', 'uninstall']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('not installed') || r.stdout.includes('nothing to remove'),
      `got: ${r.stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall: when memex is the only hook, removes empty containers', () => {
  const home = makeTestHome();
  try {
    runCli(home, ['hook', 'install']);
    runCli(home, ['hook', 'uninstall']);

    const data = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    // hooks key should be gone entirely (no empty {SessionStart:[]} detritus)
    assert(!data.hooks, `expected hooks to be removed, got: ${JSON.stringify(data)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('json output: hook install --json returns structured result', () => {
  const home = makeTestHome();
  try {
    const r = runCli(home, ['hook', 'install', '--json']);
    assertEq(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assertEq(parsed.installed, true);
    assert(parsed.command.includes('memex context'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// =============================================================
console.log('\nmemex context:\n');

test('context: empty DB returns empty-message markdown', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const r = runCli(home, ['context', '--pwd', '/non/existent/path']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('No recent activity'), `got: ${r.stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('context: finds direct project_path matches', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const r = runCli(home, ['context', '--pwd', '/tmp/test-project']);
    assertEq(r.code, 0);
    assert(r.stdout.includes('Direct work on test-project'), `expected direct match: ${r.stdout}`);
    assert(r.stdout.includes('Subagent in test-project'), `expected second direct match: ${r.stdout}`);
    // Should NOT include the other-project chat
    assert(!r.stdout.includes('Unrelated work'), `should NOT include other project: ${r.stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('context: fuzzy-matches title when no project_path', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const r = runCli(home, ['context', '--pwd', '/tmp/test-project']);
    assertEq(r.code, 0);
    // The telegram chat has "test-project" in title — should appear as fuzzy match
    assert(r.stdout.includes('budget'), `expected fuzzy/title match: ${r.stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('context: --no-source telegram excludes telegram fuzzy match', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const r = runCli(home, ['context', '--pwd', '/tmp/test-project', '--no-source', 'telegram']);
    assertEq(r.code, 0);
    assert(!r.stdout.includes('budget'), `telegram should be filtered: ${r.stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('context: --json returns structured payload', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const r = runCli(home, ['context', '--pwd', '/tmp/test-project', '--json']);
    assertEq(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assertEq(parsed.project, 'test-project');
    assertEq(parsed.direct_matches, 2);
    assert(parsed.conversations.length >= 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('context: $CLAUDE_PROJECT_DIR env var overrides cwd', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const res = spawnSync(process.execPath, [SERVER_JS, 'context', '--json'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        MEMEX_DIR: join(home, '.memex'),
        CLAUDE_PROJECT_DIR: '/tmp/test-project',
      },
      timeout: 5000,
    });
    assertEq(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assertEq(parsed.pwd, '/tmp/test-project');
    assertEq(parsed.direct_matches, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('context: --budget-tokens caps output size', () => {
  const home = makeTestHome();
  try {
    seedDb(home);
    const r = runCli(home, ['context', '--pwd', '/tmp/test-project', '--budget-tokens', '50']);
    assertEq(r.code, 0);
    assert(r.stdout.length < 50 * 4 + 100, `expected ≤200ish chars, got ${r.stdout.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

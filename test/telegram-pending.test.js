// Tests for lib/telegram-pending.js — pending/ staging.

import {
  stageExport,
  listPending,
  removePending,
} from '../lib/telegram-pending.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
function assertEq(a, b, m = '') {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
}

// Redirect HOME so PENDING_DIR points into a tmp dir for the test run.
// We do this by setting process.env.HOME BEFORE module use, but since the
// module already resolved the path... we instead test via a clean tmp HOME
// each test that uses os.homedir directly.
//
// Simpler approach: just snapshot/clear ~/.memex/pending/ for each test
// and restore at the end. But that risks clobbering real data. So we use
// a fresh process.env.HOME for the whole file.

const realHome = process.env.HOME;
const tmpHome = mkdtempSync(join(tmpdir(), 'memex-pending-test-'));
process.env.HOME = tmpHome;
mkdirSync(join(tmpHome, '.memex', 'pending'), { recursive: true });

// We need to re-import after HOME change. ESM cache makes that tricky;
// instead, the lib uses homedir() which reads process.env.HOME at call time
// on macOS (per Node docs). So we can use it directly.

const PENDING_DIR = join(tmpHome, '.memex', 'pending');

function tearDown() {
  process.env.HOME = realHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
}

// Build a minimal valid Telegram HTML export
const FIXTURE_DIR_TEMPLATE = `<html><head><title>Exported Data</title></head><body>
  <div class="page_header"><div class="text bold">__TITLE__</div></div>
  <div class="history">
    <div class="message default" id="message1">
      <div class="body">
        <div class="pull_right date details" title="20.03.2026 14:08:43 UTC+00:00"></div>
        <div class="from_name">Alice</div>
        <div class="text">hi there</div>
      </div>
    </div>
    <div class="message default" id="message2">
      <div class="body">
        <div class="pull_right date details" title="21.03.2026 09:12:00 UTC+00:00"></div>
        <div class="from_name">Bob</div>
        <div class="text">yo</div>
      </div>
    </div>
  </div>
</body></html>`;

function makeExport(title, baseDir) {
  const dir = join(baseDir, 'ChatExport_' + title.replace(/\s+/g, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'messages.html'), FIXTURE_DIR_TEMPLATE.replace('__TITLE__', title));
  return dir;
}

console.log('telegram-pending:\n');

try {
  test('stageExport: moves directory into pending/', () => {
    const src = makeExport('Test Chat A', tmpHome);
    const dest = stageExport(src, { moveOrCopy: 'move' });
    assert(!existsSync(src), 'source should be gone after move');
    assert(existsSync(dest), 'dest should exist');
    assert(dest.startsWith(PENDING_DIR), 'dest must be inside PENDING_DIR');
  });

  // v0.11.6 — preserve user's original export in ~/Downloads/Telegram Desktop/.
  // The live daemon watcher MUST use moveOrCopy='copy' (regression guard for
  // ingest.js scheduleTelegramStaging). See ingest.js around line 1938.
  test('stageExport: copy leaves source intact', () => {
    const src = makeExport('Copy-Preserve Chat', tmpHome);
    const dest = stageExport(src, { moveOrCopy: 'copy' });
    assert(existsSync(src), 'source MUST still exist after copy (v0.11.6+ behavior)');
    assert(existsSync(dest), 'dest copy should exist');
    assert(dest.startsWith(PENDING_DIR), 'dest must be inside PENDING_DIR');
    // Sanity: the copied directory has the same messages.html content
    const srcHtml = readFileSync(join(src, 'messages.html'), 'utf8');
    const destHtml = readFileSync(join(dest, 'messages.html'), 'utf8');
    assertEq(srcHtml, destHtml);
  });

  test('listPending: returns preview with chat name + msg count + dates', () => {
    const list = listPending();
    const e = list.find((x) => x.chat_title === 'Test Chat A');
    assert(e, 'should find Test Chat A in pending');
    assertEq(e.message_count, 2);
    assert(e.date_first && e.date_first.startsWith('2026-03-20'));
    assert(e.date_last && e.date_last.startsWith('2026-03-21'));
    assertEq(e.chat_type, 'personal_chat');
    assert(e.senders_sample.includes('Alice'));
    assert(e.senders_sample.includes('Bob'));
  });

  test('stageExport: collision adds numeric suffix preserving extension', () => {
    const src = makeExport('Test Chat A', tmpHome);
    const dest = stageExport(src, { moveOrCopy: 'move' });
    // First was ChatExport_Test_Chat_A, second collides → ChatExport_Test_Chat_A__1
    assert(dest.endsWith('__1') || dest.endsWith('__2'), `dest should have collision suffix, got: ${dest}`);
  });

  test('stageExport: JSON file collision preserves .json extension', () => {
    const src = join(tmpHome, 'result.json');
    writeFileSync(src, '{"name":"Some","type":"personal_chat","id":1,"messages":[]}');
    const dest1 = stageExport(src, { moveOrCopy: 'move' });

    const src2 = join(tmpHome, 'result.json');
    writeFileSync(src2, '{"name":"Other","type":"personal_chat","id":2,"messages":[]}');
    const dest2 = stageExport(src2, { moveOrCopy: 'move' });

    assert(dest1.endsWith('.json'), `first should end .json: ${dest1}`);
    assert(dest2.endsWith('.json'), `second collision should still end .json: ${dest2}`);
    assert(dest2.includes('__'), `second should have collision suffix: ${dest2}`);
  });

  test('listPending: indices are 1-based and stable within a process', () => {
    const list = listPending();
    assert(list.length > 0);
    for (let i = 0; i < list.length; i++) assertEq(list[i].index, i + 1);
  });

  test('removePending: deletes the entry from disk', () => {
    const list = listPending();
    const target = list[0];
    removePending(target.path);
    assert(!existsSync(target.path), 'should be gone from disk');
    const newList = listPending();
    assert(!newList.some((e) => e.path === target.path), 'should be absent from listPending');
  });

  test('listPending: empty dir returns []', () => {
    // Clean everything in pending
    for (const e of readdirSync(PENDING_DIR)) {
      try { rmSync(join(PENDING_DIR, e), { recursive: true, force: true }); } catch (_) {}
    }
    assertEq(listPending(), []);
  });

  // v0.10.2 regression — Telegram Desktop JSON exports come as a
  // ChatExport_* DIRECTORY with the JSON file inside (result.json or
  // custom-named). Previously these came back as "(unparseable)" because
  // detectTelegramHtml only handled HTML directories.
  test('json-in-dir: ChatExport_*/result.json detected and previewed', () => {
    const dir = join(PENDING_DIR, 'ChatExport_TestJson');
    mkdirSync(dir);
    writeFileSync(join(dir, 'result.json'), JSON.stringify({
      name: 'Test JSON Chat',
      type: 'personal_chat',
      id: 12345,
      messages: [
        { id: 1, type: 'message', date: '2026-03-20T14:00:00', date_unixtime: '1774004400', from: 'Alice', text: 'hi' },
        { id: 2, type: 'message', date: '2026-03-21T15:00:00', date_unixtime: '1774094400', from: 'Bob',   text: 'yo' },
      ],
    }));
    const list = listPending();
    const e = list.find((x) => x.basename === 'ChatExport_TestJson');
    assert(e, 'should find the json-in-dir entry');
    assertEq(e.chat_title, 'Test JSON Chat');
    assertEq(e.message_count, 2);
    assertEq(e.kind, 'json-in-dir');
    assert(e.inner_json_path && e.inner_json_path.endsWith('result.json'));
    assert(e.senders_sample.includes('Alice'));
    assert(e.senders_sample.includes('Bob'));
  });

  test('json-in-dir: custom JSON name (kimi.json) also detected', () => {
    const dir = join(PENDING_DIR, 'ChatExport_Kimi');
    mkdirSync(dir);
    writeFileSync(join(dir, 'kimi.json'), JSON.stringify({
      name: 'KIMI',
      type: 'bot_chat',
      id: 99,
      messages: [
        { id: 1, type: 'message', date: '2026-04-01T10:00:00', date_unixtime: '1775292000', from: 'Oleg', text: 'q' },
      ],
    }));
    const list = listPending();
    const e = list.find((x) => x.basename === 'ChatExport_Kimi');
    assert(e, 'should find the custom-named json');
    assertEq(e.chat_title, 'KIMI');
    assertEq(e.kind, 'json-in-dir');
  });

} finally {
  tearDown();
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

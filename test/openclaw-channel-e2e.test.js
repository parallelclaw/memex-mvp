// End-to-end smoke test for v0.11 channel-aware OpenClaw ingest.
//
// Builds a synthetic OpenClaw session JSONL with a MIX of:
//   • Kimi-web user messages       (User Message From Kimi: …)
//   • Telegram batched record      ([Queued messages …] with 2 Queued #N blocks)
//   • Telegram single record       (Conversation info + sender_id, no Queued)
//   • System output                (System: …)
// Then runs ingestFile() and asserts:
//   • Each channel lands in its OWN conversation_id (no co-mingling)
//   • Telegram batched expanded into 2 messages
//   • channel column populated correctly
//   • Conversation titles tagged [Telegram] / [Kimi-web] / [System]

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFile } from '../lib/ingest-file.js';
import { initializeDb } from '../lib/db-init.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m = '') {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
}

console.log('openclaw-channel-e2e:\n');

// Build an OpenClaw JSONL with one of each channel
// File name uses the 8-char base UUID convention.
const root = mkdtempSync(join(tmpdir(), 'memex-oce2e-'));
const dbPath = join(root, 'memex.db');
const filePath = join(root, 'openclaw-3824f87a.jsonl');

// Single Kimi-web user message
const kimiRec = {
  type: 'message',
  id: 'kimi-msg-1',
  timestamp: '2026-05-19T14:00:00Z',
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: 'User Message From Kimi:\n[Time: [2026-05-19 22:00:00 GMT+8]]\nпривет, как дела?',
    }],
  },
};

// Telegram batched — 2 messages from same sender
const tgBatchedRec = {
  type: 'message',
  id: 'tg-batched-1',
  timestamp: '2026-05-19T14:05:00Z',
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: [
        '[Queued messages while agent was busy]',
        '',
        '---',
        'Queued #1',
        'Conversation info (untrusted metadata):',
        '```json',
        '{',
        '  "message_id": "2001",',
        '  "sender_id": "97592799",',
        '  "sender": "Oleg",',
        '  "timestamp": "Tue 2026-05-19 22:05 GMT+8"',
        '}',
        '```',
        '',
        'Sender (untrusted metadata):',
        '```json',
        '{',
        '  "id": "97592799",',
        '  "name": "Oleg",',
        '  "username": "Oleg_Sedelev"',
        '}',
        '```',
        '',
        'Первое сообщение в очереди',
        '',
        '---',
        'Queued #2',
        'Conversation info (untrusted metadata):',
        '```json',
        '{',
        '  "message_id": "2002",',
        '  "sender_id": "97592799",',
        '  "sender": "Oleg",',
        '  "timestamp": "Tue 2026-05-19 22:06 GMT+8"',
        '}',
        '```',
        '',
        'Второе сообщение, тоже в очереди',
      ].join('\n'),
    }],
  },
};

// Telegram single (different sender to test routing)
const tgSingleRec = {
  type: 'message',
  id: 'tg-single-1',
  timestamp: '2026-05-19T14:10:00Z',
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: [
        'Conversation info (untrusted metadata):',
        '```json',
        '{',
        '  "message_id": "2003",',
        '  "sender_id": "11111111",',
        '  "sender": "Other",',
        '  "timestamp": "Tue 2026-05-19 22:10 GMT+8"',
        '}',
        '```',
        '',
        'привет это другой юзер',
      ].join('\n'),
    }],
  },
};

// System output
const systemRec = {
  type: 'message',
  id: 'sys-1',
  timestamp: '2026-05-19T14:15:00Z',
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: 'System: [exec] command completed with exit code 0',
    }],
  },
};

// Assistant reply (Kimi channel — should join the kimi-web conv)
const assistantRec = {
  type: 'message',
  id: 'assistant-1',
  timestamp: '2026-05-19T14:01:00Z',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Привет! Всё хорошо, чем помочь?' }],
  },
};

writeFileSync(
  filePath,
  [kimiRec, assistantRec, tgBatchedRec, tgSingleRec, systemRec].map(JSON.stringify).join('\n'),
);

const db = initializeDb(dbPath);

try {
  const r = await ingestFile(db, filePath, { format: 'openclaw-jsonl' });

  test('ingest succeeds', () => {
    assertEq(r.status, 'imported');
    assert(r.total_imported > 0, `expected imported > 0, got ${r.total_imported}`);
  });

  test('Telegram batched → 2 unpacked messages', () => {
    const rows = db.prepare(
      `SELECT msg_id, text, channel, conversation_id, sender FROM messages
       WHERE source='openclaw' AND conversation_id='openclaw-tg-97592799'
       ORDER BY ts`,
    ).all();
    assertEq(rows.length, 2, `expected 2 rows for Oleg's TG conv`);
    assertEq(rows[0].text, 'Первое сообщение в очереди');
    assertEq(rows[1].text, 'Второе сообщение, тоже в очереди');
    assertEq(rows[0].channel, 'telegram');
    assertEq(rows[0].sender, 'Oleg');
  });

  test('Telegram single → separate conv (by sender_id)', () => {
    const rows = db.prepare(
      `SELECT text, channel FROM messages
       WHERE source='openclaw' AND conversation_id='openclaw-tg-11111111'`,
    ).all();
    assertEq(rows.length, 1);
    assertEq(rows[0].text, 'привет это другой юзер');
    assertEq(rows[0].channel, 'telegram');
  });

  test('Kimi-web user + assistant in own conv', () => {
    const rows = db.prepare(
      `SELECT role, text, channel FROM messages
       WHERE source='openclaw' AND conversation_id='openclaw-kimi-3824f87a'
       ORDER BY ts`,
    ).all();
    // assistant ts is 14:01 (after kimi 14:00) so order is user, assistant
    assertEq(rows.length, 2);
    assertEq(rows[0].role, 'user');
    assertEq(rows[0].text, 'привет, как дела?'); // Kimi header stripped
    assertEq(rows[0].channel, 'kimi-web');
    assertEq(rows[1].role, 'assistant');
  });

  test('System message → openclaw-sys conv', () => {
    const rows = db.prepare(
      `SELECT text, channel FROM messages
       WHERE source='openclaw' AND conversation_id='openclaw-sys-3824f87a'`,
    ).all();
    assertEq(rows.length, 1);
    assertEq(rows[0].channel, 'system');
    assert(rows[0].text.includes('System:'), 'system text preserved');
  });

  test('NO co-mingling: 4 distinct conversations created', () => {
    const rows = db.prepare(
      `SELECT conversation_id FROM conversations
       WHERE source='openclaw' ORDER BY conversation_id`,
    ).all();
    const ids = rows.map((r) => r.conversation_id);
    assertEq(ids, [
      'openclaw-kimi-3824f87a',
      'openclaw-sys-3824f87a',
      'openclaw-tg-11111111',
      'openclaw-tg-97592799',
    ]);
  });

  test('Conversation titles tagged with channel', () => {
    const rows = db.prepare(
      `SELECT conversation_id, title FROM conversations WHERE source='openclaw'`,
    ).all();
    const byId = Object.fromEntries(rows.map((r) => [r.conversation_id, r.title]));
    assert(byId['openclaw-tg-97592799'].startsWith('[Telegram]'), `TG title: ${byId['openclaw-tg-97592799']}`);
    assert(byId['openclaw-kimi-3824f87a'].startsWith('[Kimi-web]'), `Kimi title: ${byId['openclaw-kimi-3824f87a']}`);
    assert(byId['openclaw-sys-3824f87a'].startsWith('[System]'), `Sys title: ${byId['openclaw-sys-3824f87a']}`);
  });

  test('Re-ingest is idempotent (UNIQUE constraint)', async () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE source='openclaw'`).get().n;
    const r2 = await ingestFile(db, filePath, { format: 'openclaw-jsonl' });
    assertEq(r2.status, 'imported');
    const after = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE source='openclaw'`).get().n;
    assertEq(after, before, 'row count must not grow on re-ingest');
  });

  test('Metadata preserves sender_id + message_id for Telegram', () => {
    const row = db.prepare(
      `SELECT metadata FROM messages
       WHERE source='openclaw' AND conversation_id='openclaw-tg-97592799'
       ORDER BY ts LIMIT 1`,
    ).get();
    const meta = JSON.parse(row.metadata);
    assertEq(meta.sender_id, '97592799');
    assertEq(meta.telegram_message_id, '2001');
    assertEq(meta.username, 'Oleg_Sedelev');
  });
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

// ============ v0.11.1: sticky pointer holds through tool_results ============
//
// Pattern from real OpenClaw VPS diagnostic:
//   1. Kimi-web user message (detected)
//   2. assistant reply (no marker, inherits)
//   3. tool_result (role='user', no marker — would have orphaned in v0.11.0)
//   4. assistant follow-up (would have orphaned because sticky=null after #3)
//
// All four should land in `openclaw-kimi-<file8>`, not in a fallback bucket.

const root2 = mkdtempSync(join(tmpdir(), 'memex-sticky-'));
const dbPath2 = join(root2, 'memex.db');
const filePath2 = join(root2, 'openclaw-aabbccdd.jsonl');

const records = [
  {
    type: 'message', id: 'r1',
    timestamp: '2026-05-19T10:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'User Message From Kimi:\nприветик' }] },
  },
  {
    type: 'message', id: 'r2',
    timestamp: '2026-05-19T10:00:05Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'привет! чем помочь?' }] },
  },
  {
    type: 'message', id: 'r3',
    timestamp: '2026-05-19T10:00:10Z',
    // Synthetic tool_result-style: role=user, long text, no channel marker
    message: { role: 'user', content: [{
      type: 'text',
      text: '[Bash output] /tmp/foo/bar:\nfile1.txt 123\nfile2.txt 456\n... (long output continues, far longer than any chat reply)',
    }]},
  },
  {
    type: 'message', id: 'r4',
    timestamp: '2026-05-19T10:00:15Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'вижу что у тебя 2 файла' }] },
  },
  {
    type: 'message', id: 'r5',
    timestamp: '2026-05-19T10:00:20Z',
    message: { role: 'user', content: [{ type: 'text', text: 'User Message From Kimi:\nспасибо' }] },
  },
];

writeFileSync(filePath2, records.map(JSON.stringify).join('\n'));

const db2 = initializeDb(dbPath2);
try {
  const r = await ingestFile(db2, filePath2, { format: 'openclaw-jsonl' });
  test('sticky-pointer: ingest succeeds', () => {
    assertEq(r.status, 'imported');
  });

  test('sticky-pointer: all 5 records land in openclaw-kimi-aabbccdd', () => {
    const rows = db2.prepare(
      `SELECT id, role, channel, conversation_id, substr(text,1,30) AS preview
         FROM messages WHERE source='openclaw' ORDER BY ts`,
    ).all();
    assertEq(rows.length, 5);
    for (const row of rows) {
      assertEq(row.conversation_id, 'openclaw-kimi-aabbccdd', `record ${row.id} (${row.role}) routed wrong: ${row.preview}`);
      assertEq(row.channel, 'kimi-web', `record ${row.id} channel wrong`);
    }
  });

  test('sticky-pointer: zero fallback bucket conversations', () => {
    const fallback = db2.prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE source='openclaw' AND conversation_id='openclaw-aabbccdd'`,
    ).get().n;
    assertEq(fallback, 0, 'tool_result should NOT orphan into fallback bucket');
  });

  test('sticky-pointer: Kimi-strip works on short messages (no Time block)', () => {
    const row = db2.prepare(
      `SELECT text FROM messages
        WHERE source='openclaw' AND id IN (
          SELECT MIN(id) FROM messages WHERE source='openclaw' GROUP BY msg_id
        ) AND msg_id='r1'`,
    ).get();
    assertEq(row.text, 'приветик', `Kimi header should be stripped, got: ${row.text}`);
  });
} finally {
  db2.close();
  rmSync(root2, { recursive: true, force: true });
}

// ============ v0.11.1: auto-discovery for self-hosted custom channel ============
//
// Simulates a self-hosted OpenClaw VPS with `channel: "discord"` in
// sessions.json. memex has no built-in 'discord' handler, but should
// still route correctly via auto-registration.

const root3 = mkdtempSync(join(tmpdir(), 'memex-auto-'));
const dbPath3 = join(root3, 'memex.db');
// Mimic real layout: sessions/ subdir holds the session file + sessions.json
const sessDir = join(root3, 'agents', 'main', 'sessions');
mkdirSync(sessDir, { recursive: true });
const filePath3 = join(sessDir, 'beefdead.jsonl');
const sessionsJsonPath = join(sessDir, 'sessions.json');

writeFileSync(sessionsJsonPath, JSON.stringify({
  'agent:main:main': {
    deliveryContext: { channel: 'discord' },
    sessionFile: filePath3,
  },
}));

writeFileSync(filePath3, [
  {
    type: 'message', id: 'd1',
    timestamp: '2026-05-19T11:00:00Z',
    // No channel marker — relies on sessions.json fallback (auto-registered)
    message: { role: 'user', content: [{ type: 'text', text: 'hey bot, what time is it?' }] },
  },
  {
    type: 'message', id: 'd2',
    timestamp: '2026-05-19T11:00:05Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'It is 11:00 UTC.' }] },
  },
].map(JSON.stringify).join('\n'));

const db3 = initializeDb(dbPath3);
try {
  const r = await ingestFile(db3, filePath3, { format: 'openclaw-jsonl' });
  test('auto-discovery: ingest succeeds', () => {
    assertEq(r.status, 'imported');
  });

  test('auto-discovery: unknown channel routed to openclaw-discord-<file8>', () => {
    const rows = db3.prepare(
      `SELECT role, channel, conversation_id, text FROM messages
         WHERE source='openclaw' ORDER BY ts`,
    ).all();
    assertEq(rows.length, 2);
    assertEq(rows[0].conversation_id, 'openclaw-discord-beefdead');
    assertEq(rows[1].conversation_id, 'openclaw-discord-beefdead');
    assertEq(rows[0].channel, 'discord');
    assertEq(rows[1].channel, 'discord');
  });

  test('auto-discovery: conv title has [discord] prefix', () => {
    const conv = db3.prepare(
      `SELECT title FROM conversations WHERE source='openclaw' LIMIT 1`,
    ).get();
    assert(conv.title.startsWith('[discord]'), `title should start with [discord], got: ${conv.title}`);
  });

  test('auto-discovery: metadata flags auto_channel=true', () => {
    const row = db3.prepare(
      `SELECT metadata FROM messages WHERE source='openclaw' LIMIT 1`,
    ).get();
    const meta = JSON.parse(row.metadata);
    assertEq(meta.auto_channel, true);
  });
} finally {
  db3.close();
  rmSync(root3, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

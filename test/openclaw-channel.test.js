// Tests for lib/openclaw-channel.js — OpenClaw channel detection,
// Telegram batch unpacking, and conv_id derivation.

import {
  detectChannel,
  parseBatchedTelegram,
  parseSingleTelegram,
  parseTelegramTimestamp,
  stripKimiHeader,
  loadSessionsJsonChannelMap,
  findSessionsJson,
  deriveOpenclawConvId,
  baseUuid8,
} from '../lib/openclaw-channel.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

console.log('openclaw-channel:\n');

// ============ detectChannel ============

test('detectChannel: Kimi-web preamble', () => {
  const text = 'User Message From Kimi:\n[Time: [2026-05-20 02:41:22 GMT+8]]\nпривет';
  assertEq(detectChannel(text), 'kimi-web');
});

test('detectChannel: Telegram batched (Queued header)', () => {
  const text = '[Queued messages while agent was busy]\n\n---\nQueued #1\n...';
  assertEq(detectChannel(text), 'telegram');
});

test('detectChannel: Telegram single (Conversation info marker)', () => {
  const text = 'Conversation info (untrusted metadata):\n```json\n{"sender_id": "97592799"}\n```\n\nhi';
  assertEq(detectChannel(text), 'telegram');
});

test('detectChannel: System output', () => {
  const text = 'System: [exec] command completed';
  assertEq(detectChannel(text), 'system');
});

test('detectChannel: unknown → fallback', () => {
  assertEq(detectChannel('Some random text', 'kimi-web'), 'kimi-web');
});

test('detectChannel: unknown + no fallback → null', () => {
  assertEq(detectChannel('Some random text'), null);
});

test('detectChannel: empty/null text', () => {
  assertEq(detectChannel(''), null);
  assertEq(detectChannel(null), null);
  assertEq(detectChannel(undefined, 'kimi-web'), 'kimi-web');
});

// ============ parseSingleTelegram ============

test('parseSingleTelegram: extracts metadata + text', () => {
  const block = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "1997",
  "sender_id": "97592799",
  "sender": "Oleg",
  "timestamp": "Fri 2026-05-01 20:03 GMT+8"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "label": "Oleg (97592799)",
  "id": "97592799",
  "name": "Oleg",
  "username": "Oleg_Sedelev"
}
\`\`\`

Прочитай материал изучи`;
  const r = parseSingleTelegram(block);
  assert(r);
  assertEq(r.message_id, '1997');
  assertEq(r.sender_id, '97592799');
  assertEq(r.sender, 'Oleg');
  assertEq(r.username, 'Oleg_Sedelev');
  assertEq(r.text, 'Прочитай материал изучи');
});

test('parseSingleTelegram: extracts reply_to_id when present', () => {
  const block = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "2003",
  "reply_to_id": "1995",
  "sender_id": "97592799",
  "sender": "Oleg",
  "timestamp": "Fri 2026-05-01 20:04 GMT+8"
}
\`\`\`

ok`;
  const r = parseSingleTelegram(block);
  assertEq(r.reply_to_id, '1995');
});

test('parseSingleTelegram: returns null when no metadata blocks', () => {
  assertEq(parseSingleTelegram('plain text without metadata'), null);
});

// ============ parseBatchedTelegram ============

test('parseBatchedTelegram: unpacks 2 batched messages', () => {
  const text = `[Queued messages while agent was busy]

---
Queued #1
Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "1997",
  "sender_id": "97592799",
  "sender": "Oleg",
  "timestamp": "Fri 2026-05-01 20:03 GMT+8"
}
\`\`\`

Прочитай материал изучи

---
Queued #2
Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "1998",
  "sender_id": "97592799",
  "sender": "Oleg",
  "timestamp": "Fri 2026-05-01 20:04 GMT+8"
}
\`\`\`

И ещё одно`;
  const r = parseBatchedTelegram(text);
  assertEq(r.length, 2);
  assertEq(r[0].message_id, '1997');
  assertEq(r[0].text, 'Прочитай материал изучи');
  assertEq(r[1].message_id, '1998');
  assertEq(r[1].text, 'И ещё одно');
});

test('parseBatchedTelegram: empty input → []', () => {
  assertEq(parseBatchedTelegram(''), []);
  assertEq(parseBatchedTelegram(null), []);
});

// ============ parseTelegramTimestamp ============

test('parseTelegramTimestamp: GMT+8 → unix seconds', () => {
  // "Fri 2026-05-01 20:03 GMT+8" = 2026-05-01 12:03 UTC = ...
  const ts = parseTelegramTimestamp('Fri 2026-05-01 20:03 GMT+8');
  const expected = Math.floor(Date.UTC(2026, 4, 1, 12, 3) / 1000);
  assertEq(ts, expected);
});

test('parseTelegramTimestamp: malformed → 0', () => {
  assertEq(parseTelegramTimestamp('not a date'), 0);
  assertEq(parseTelegramTimestamp(''), 0);
  assertEq(parseTelegramTimestamp(null), 0);
});

// ============ stripKimiHeader ============

test('stripKimiHeader: removes canonical preamble', () => {
  const text = 'User Message From Kimi:\n[Time: [2026-05-20 02:41:22 GMT+8]]\nпосмотри что обсуждали';
  assertEq(stripKimiHeader(text), 'посмотри что обсуждали');
});

test('stripKimiHeader: text without header passes through', () => {
  assertEq(stripKimiHeader('plain text'), 'plain text');
});

// ============ deriveOpenclawConvId ============

test('deriveOpenclawConvId: telegram with sender_id', () => {
  assertEq(deriveOpenclawConvId('telegram', '97592799', '3824f87a'), 'openclaw-tg-97592799');
});

test('deriveOpenclawConvId: kimi-web', () => {
  assertEq(deriveOpenclawConvId('kimi-web', null, '3824f87a'), 'openclaw-kimi-3824f87a');
});

test('deriveOpenclawConvId: system', () => {
  assertEq(deriveOpenclawConvId('system', null, '3824f87a'), 'openclaw-sys-3824f87a');
});

test('deriveOpenclawConvId: null channel → default', () => {
  assertEq(deriveOpenclawConvId(null, null, '3824f87a'), 'openclaw-3824f87a');
});

test('deriveOpenclawConvId: telegram without sender_id → default', () => {
  assertEq(deriveOpenclawConvId('telegram', null, '3824f87a'), 'openclaw-3824f87a');
});

// ============ baseUuid8 ============

test('baseUuid8: openclaw-<base8>.jsonl', () => {
  assertEq(baseUuid8('openclaw-3824f87a.jsonl'), '3824f87a');
});

test('baseUuid8: openclaw-<base8>-ckpt-<chkpt8>.jsonl', () => {
  assertEq(baseUuid8('openclaw-3824f87a-ckpt-e6c37ac7.jsonl'), '3824f87a');
});

test('baseUuid8: full uuid (source file)', () => {
  assertEq(baseUuid8('3824f87a-ea6e-4e08-a83a-c596288bcfe3.jsonl'), '3824f87a');
});

test('baseUuid8: <base>.checkpoint.<chkpt>.jsonl (source file)', () => {
  assertEq(
    baseUuid8('3824f87a-ea6e-4e08-a83a-c596288bcfe3.checkpoint.e6c37ac7-64d2-49cd-ba5e-5858fe98bddc.jsonl'),
    '3824f87a',
  );
});

// ============ loadSessionsJsonChannelMap ============

test('loadSessionsJsonChannelMap: maps sessionFile → channel', () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-ses-'));
  try {
    const p = join(root, 'sessions.json');
    writeFileSync(p, JSON.stringify({
      'agent:main:main': {
        deliveryContext: { channel: 'kimi-claw' },
        sessionFile: '/root/.openclaw/agents/main/sessions/3824f87a.jsonl',
      },
      'agent:main:subagent:xyz': {
        deliveryContext: { channel: 'telegram' },
        sessionFile: '/root/.openclaw/agents/main/sessions/778e300b.jsonl',
      },
    }));
    const m = loadSessionsJsonChannelMap(p);
    assertEq(m.size, 2);
    assertEq(m.get('/root/.openclaw/agents/main/sessions/3824f87a.jsonl'), 'kimi-web'); // normalised
    assertEq(m.get('/root/.openclaw/agents/main/sessions/778e300b.jsonl'), 'telegram');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadSessionsJsonChannelMap: missing file → empty Map', () => {
  const m = loadSessionsJsonChannelMap('/nonexistent/sessions.json');
  assertEq(m.size, 0);
});

test('findSessionsJson: walks up to find sibling', () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-fnd-'));
  try {
    const sessionDir = join(root, 'agents', 'main', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionsJson = join(root, 'agents', 'main', 'sessions', 'sessions.json');
    writeFileSync(sessionsJson, '{}');
    const sessionFile = join(sessionDir, 'abc.jsonl');
    writeFileSync(sessionFile, '');
    assertEq(findSessionsJson(sessionFile), sessionsJson);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

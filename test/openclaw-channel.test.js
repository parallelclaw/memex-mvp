// Tests for lib/openclaw-channel.js — OpenClaw channel detection,
// Telegram batch unpacking, and conv_id derivation.

import {
  CHANNELS,
  detectChannel,
  findChannelDef,
  getOrAutoRegister,
  parseBatchedTelegram,
  parseSingleTelegram,
  parseTelegramTimestamp,
  stripKimiHeader,
  loadSessionsJsonChannelMap,
  findSessionsJson,
  lookupChannel,
  detectSessionType,
  detectSessionTypeFromContent,
  isCheckpointFile,
  isResetFile,
  deriveOpenclawConvId,
  titlePrefixFor,
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

// v0.11.1: production OpenClaw omits [Time:] block for short messages —
// the v0.11.0 regex required it and silently failed for everything else.
test('stripKimiHeader: NO Time block (real production format)', () => {
  assertEq(stripKimiHeader('User Message From Kimi:\nтут?'), 'тут?');
  assertEq(
    stripKimiHeader('User Message From Kimi:\nсколько у тебя килобайт?'),
    'сколько у тебя килобайт?',
  );
});

test('stripKimiHeader: extra whitespace before newline', () => {
  assertEq(stripKimiHeader('User Message From Kimi:   \nhi'), 'hi');
});

// ============ CHANNELS registry ============

test('CHANNELS: built-in channels exposed', () => {
  const names = CHANNELS.map((c) => c.name);
  assert(names.includes('telegram'));
  assert(names.includes('kimi-web'));
  assert(names.includes('system'));
});

test('findChannelDef: by canonical name', () => {
  assertEq(findChannelDef('telegram')?.name, 'telegram');
  assertEq(findChannelDef('kimi-web')?.name, 'kimi-web');
});

test('findChannelDef: by sessions.json alias (kimi-claw → kimi-web)', () => {
  assertEq(findChannelDef('kimi-claw')?.name, 'kimi-web');
});

test('findChannelDef: unknown → null', () => {
  assertEq(findChannelDef('discord'), null);
  assertEq(findChannelDef(null), null);
});

// ============ getOrAutoRegister (self-hosted channels) ============

test('getOrAutoRegister: known channel returns existing def', () => {
  const def = getOrAutoRegister('telegram');
  assertEq(def?.name, 'telegram');
  assertEq(def?.isAutoRegistered, undefined); // built-in, not auto
});

test('getOrAutoRegister: alias resolves to existing def', () => {
  const def = getOrAutoRegister('kimi-claw');
  assertEq(def?.name, 'kimi-web');
});

test('getOrAutoRegister: unknown channel → synthesized def', () => {
  const def = getOrAutoRegister('discord');
  assertEq(def?.name, 'discord');
  assertEq(def?.isAutoRegistered, true);
  assertEq(def?.titlePrefix, '[discord]');
  // conv_id falls back to fileUuid8 when no sender info
  assertEq(def.convIdFor({}, { fileUuid8: '3824f87a' }), 'openclaw-discord-3824f87a');
  // routes per-account when accountId is provided
  assertEq(
    def.convIdFor({ accountId: 'user-42' }, { fileUuid8: '3824f87a' }),
    'openclaw-discord-user-42',
  );
});

test('getOrAutoRegister: sanitises hostile channel names', () => {
  // Should strip spaces/slashes — these would corrupt conv_id values
  const def = getOrAutoRegister('My Custom/Web UI');
  assertEq(def?.name, 'mycustomwebui');
  assertEq(def?.titlePrefix, '[mycustomwebui]');
});

test('getOrAutoRegister: empty/invalid → null', () => {
  assertEq(getOrAutoRegister(''), null);
  assertEq(getOrAutoRegister(null), null);
  assertEq(getOrAutoRegister('!!!'), null); // no valid chars → null
});

// ============ titlePrefixFor ============

test('titlePrefixFor: built-in channels', () => {
  assertEq(titlePrefixFor('telegram'), '[Telegram]');
  assertEq(titlePrefixFor('kimi-web'), '[Kimi-web]');
  assertEq(titlePrefixFor('system'), '[System]');
});

test('titlePrefixFor: auto-discovered channel', () => {
  assertEq(titlePrefixFor('discord'), '[discord]');
});

test('titlePrefixFor: null/empty → ""', () => {
  assertEq(titlePrefixFor(null), '');
  assertEq(titlePrefixFor(''), '');
});

// ============ deriveOpenclawConvId — v0.11.1 additions ============

test('deriveOpenclawConvId: unknown channel auto-routes per-file', () => {
  assertEq(
    deriveOpenclawConvId('discord', null, '3824f87a'),
    'openclaw-discord-3824f87a',
  );
});

test('deriveOpenclawConvId: unknown channel + accountId routes per-user', () => {
  assertEq(
    deriveOpenclawConvId('matrix', { accountId: 'mara-42' }, '3824f87a'),
    'openclaw-matrix-mara-42',
  );
});

test('deriveOpenclawConvId: kimi-claw alias → kimi conv', () => {
  // Pre-normalised value from sessions.json should route the same as canonical
  assertEq(
    deriveOpenclawConvId('kimi-claw', null, '3824f87a'),
    'openclaw-kimi-3824f87a',
  );
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

test('loadSessionsJsonChannelMap: maps sessionFile → channel (multi-key)', () => {
  // v0.11.2: map is indexed by 3 keys per entry — full path, basename,
  // and uuid8:<base-uuid>. The lookupChannel helper picks whichever
  // matches. Verify all three are present.
  const root = mkdtempSync(join(tmpdir(), 'memex-ses-'));
  try {
    const p = join(root, 'sessions.json');
    writeFileSync(p, JSON.stringify({
      'agent:main:main': {
        deliveryContext: { channel: 'kimi-claw' },
        sessionFile: '/root/.openclaw/agents/main/sessions/3824f87a-ea6e-4e08-a83a-c596288bcfe3.jsonl',
      },
      'agent:main:subagent:xyz': {
        deliveryContext: { channel: 'telegram' },
        sessionFile: '/root/.openclaw/agents/main/sessions/778e300b-aa11-bb22-cc33-dd44ee55ff66.jsonl',
      },
    }));
    const m = loadSessionsJsonChannelMap(p);
    // 2 entries × 3 keys each = 6 (assuming all three keys are distinct)
    assertEq(m.size, 6);
    // Full path key
    assertEq(m.get('/root/.openclaw/agents/main/sessions/3824f87a-ea6e-4e08-a83a-c596288bcfe3.jsonl'), 'kimi-web');
    // Basename key
    assertEq(m.get('3824f87a-ea6e-4e08-a83a-c596288bcfe3.jsonl'), 'kimi-web');
    // uuid8 key
    assertEq(m.get('uuid8:3824f87a'), 'kimi-web');
    // Same for the telegram entry
    assertEq(m.get('uuid8:778e300b'), 'telegram');
    assertEq(m.get('778e300b-aa11-bb22-cc33-dd44ee55ff66.jsonl'), 'telegram');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadSessionsJsonChannelMap: missing file → empty Map', () => {
  const m = loadSessionsJsonChannelMap('/nonexistent/sessions.json');
  assertEq(m.size, 0);
});

// ============ v0.11.2: lookupChannel + detectSessionType + isCheckpointFile ============

test('lookupChannel: matches by full path', () => {
  const map = new Map([['/path/to/abc.jsonl', 'telegram']]);
  assertEq(lookupChannel(map, '/path/to/abc.jsonl'), 'telegram');
});

test('lookupChannel: matches by basename', () => {
  const map = new Map([['abc.jsonl', 'telegram']]);
  assertEq(lookupChannel(map, '/different/dir/abc.jsonl'), 'telegram');
});

test('lookupChannel: matches by uuid8 (archive-staged file)', () => {
  // Critical v0.11.2 case: archive file is named openclaw-3824f87a.jsonl
  // but sessions.json key is uuid8:3824f87a (set by loadSessionsJsonChannelMap).
  const map = new Map([['uuid8:3824f87a', 'telegram']]);
  assertEq(lookupChannel(map, '/archive/openclaw-3824f87a.jsonl'), 'telegram');
});

test('lookupChannel: no match → null', () => {
  const map = new Map([['uuid8:3824f87a', 'telegram']]);
  assertEq(lookupChannel(map, '/archive/openclaw-deadbeef.jsonl'), null);
});

test('lookupChannel: end-to-end via loadSessionsJsonChannelMap', () => {
  // Simulate the real flow: sessions.json -> map -> archive-file lookup
  const root = mkdtempSync(join(tmpdir(), 'memex-lkp-'));
  try {
    const p = join(root, 'sessions.json');
    writeFileSync(p, JSON.stringify({
      'agent:main:main': {
        deliveryContext: { channel: 'telegram' },
        sessionFile: '/home/user/.openclaw/agents/main/sessions/3824f87a-ea6e-4e08-a83a-c596288bcfe3.jsonl',
      },
    }));
    const m = loadSessionsJsonChannelMap(p);
    // Archive-staged name (different from sessionFile in sessions.json)
    assertEq(lookupChannel(m, '/home/user/.memex/archive/openclaw/openclaw-3824f87a.jsonl'), 'telegram');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSessionType: kimi-web channel → kimi-claw', () => {
  const map = new Map([['uuid8:3824f87a', 'kimi-web']]);
  assertEq(detectSessionType('/archive/openclaw-3824f87a.jsonl', map), 'kimi-claw');
});

test('detectSessionType: telegram channel → self-hosted', () => {
  const map = new Map([['uuid8:3824f87a', 'telegram']]);
  assertEq(detectSessionType('/archive/openclaw-3824f87a.jsonl', map), 'self-hosted');
});

test('detectSessionType: custom channel → self-hosted', () => {
  const map = new Map([['uuid8:3824f87a', 'webchat']]);
  assertEq(detectSessionType('/archive/openclaw-3824f87a.jsonl', map), 'self-hosted');
});

test('detectSessionType: no channel → unknown', () => {
  const map = new Map();
  assertEq(detectSessionType('/archive/openclaw-deadbeef.jsonl', map), 'unknown');
});

test('isCheckpointFile: classic .checkpoint. format', () => {
  assert(isCheckpointFile('3824f87a-ea6e-4e08-a83a-c596288bcfe3.checkpoint.e6c37ac7-64d2-49cd-ba5e-5858fe98bddc.jsonl'));
});

test('isCheckpointFile: inbox-staged -ckpt- format', () => {
  assert(isCheckpointFile('openclaw-3824f87a-ckpt-e6c37ac7.jsonl'));
});

test('isCheckpointFile: main session file → false', () => {
  assertEq(isCheckpointFile('openclaw-3824f87a.jsonl'), false);
  assertEq(isCheckpointFile('3824f87a-ea6e-4e08-a83a-c596288bcfe3.jsonl'), false);
});

test('isCheckpointFile: empty/null → false', () => {
  assertEq(isCheckpointFile(''), false);
  assertEq(isCheckpointFile(null), false);
});

// v0.11.4: reset files — full pre-reset session archives.
test('isResetFile: source .reset.<uuid> format', () => {
  assert(isResetFile('3824f87a-ea6e-4e08-a83a-c596288bcfe3.reset.deadbeef-aaaa-bbbb-cccc-ddddeeee0000.jsonl'));
});

test('isResetFile: inbox-staged -reset- format', () => {
  assert(isResetFile('openclaw-3824f87a-reset-deadbeef.jsonl'));
});

test('isResetFile: checkpoint file is NOT reset', () => {
  assertEq(isResetFile('openclaw-3824f87a-ckpt-deadbeef.jsonl'), false);
  assertEq(isResetFile('3824f87a-ea6e-4e08-a83a-c596288bcfe3.checkpoint.e6c37ac7-64d2-49cd-ba5e-5858fe98bddc.jsonl'), false);
});

test('isResetFile: main file is NOT reset', () => {
  assertEq(isResetFile('openclaw-3824f87a.jsonl'), false);
});

test('isResetFile: empty/null → false', () => {
  assertEq(isResetFile(''), false);
  assertEq(isResetFile(null), false);
});

test('baseUuid8: openclaw-<base8>-reset-<reset8>.jsonl', () => {
  assertEq(baseUuid8('openclaw-3824f87a-reset-deadbeef.jsonl'), '3824f87a');
});

test('baseUuid8: <base>.reset.<reset>.jsonl (source format)', () => {
  assertEq(
    baseUuid8('3824f87a-ea6e-4e08-a83a-c596288bcfe3.reset.deadbeef-aaaa-bbbb-cccc-ddddeeee0000.jsonl'),
    '3824f87a',
  );
});

// v0.11.5: real production reset format is "<uuid>.jsonl.reset.<ISO-timestamp>".
// Note the file ends in the timestamp (e.g. ".833Z"), NOT in ".jsonl".
test('baseUuid8: real reset format (jsonl-in-middle + timestamp suffix)', () => {
  assertEq(
    baseUuid8('722c711b-ea6e-4e08-a83a-c596288bcfe3.jsonl.reset.2026-05-05T19-37-01.833Z'),
    '722c711b',
  );
});

test('isResetFile: real production format (.jsonl in middle, timestamp tail)', () => {
  assert(isResetFile('722c711b-ea6e-4e08-a83a-c596288bcfe3.jsonl.reset.2026-05-05T19-37-01.833Z'));
});

// ============ v0.11.3: content-based session-type detection ============
//
// Critical for backfill from archive: sessions.json only tracks CURRENT
// active sessions. After main-session rotation, archived files have no
// entry → lookup fails. Without content fallback, every old archive
// looks 'unknown' → defaults to self-hosted → checkpoints are skipped
// even for Kimi-Claw users. Confirmed empirically on a Kimi-Claw VPS
// 2026-05-20: archive contained 3824f87a files, sessions.json only knew
// about ac39cfb2 (the new main session).

test('detectSessionTypeFromContent: Kimi + TG markers → kimi-claw', () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-content-'));
  try {
    const p = join(root, 'merged.jsonl');
    writeFileSync(p, [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'User Message From Kimi:\nпривет' }] } }),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: '[Queued messages while agent was busy]\n---\nQueued #1' }] } }),
    ].join('\n'));
    assertEq(detectSessionTypeFromContent(p), 'kimi-claw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSessionTypeFromContent: only Kimi marker → self-hosted', () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-content-'));
  try {
    const p = join(root, 'kimi-only.jsonl');
    writeFileSync(p, JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: 'User Message From Kimi:\nтекст' }] },
    }));
    assertEq(detectSessionTypeFromContent(p), 'self-hosted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSessionTypeFromContent: only Telegram marker → self-hosted', () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-content-'));
  try {
    const p = join(root, 'tg-only.jsonl');
    writeFileSync(p, JSON.stringify({
      message: { role: 'user', content: [{
        type: 'text',
        text: 'Conversation info (untrusted metadata):\n```json\n{"sender_id":"42"}\n```',
      }]},
    }));
    assertEq(detectSessionTypeFromContent(p), 'self-hosted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSessionTypeFromContent: no markers → unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-content-'));
  try {
    const p = join(root, 'empty-content.jsonl');
    writeFileSync(p, JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: 'just some random text' }] },
    }));
    assertEq(detectSessionTypeFromContent(p), 'unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSessionTypeFromContent: missing file → unknown', () => {
  assertEq(detectSessionTypeFromContent('/nonexistent/file.jsonl'), 'unknown');
  assertEq(detectSessionTypeFromContent(null), 'unknown');
});

test('detectSessionType: content-fallback when sessions.json has no entry', () => {
  // Reproduces the Kimi-Claw archive scenario from 2026-05-20.
  // sessions.json knows about ac39cfb2 (current main) but the archive
  // contains 3824f87a (old main, rotated out). Content fallback should
  // detect kimi-claw from the file body.
  const root = mkdtempSync(join(tmpdir(), 'memex-cfb-'));
  try {
    const p = join(root, 'openclaw-3824f87a.jsonl');
    writeFileSync(p, [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'User Message From Kimi:\nпривет' }] } }),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: '[Queued messages while agent was busy]\n---\nQueued #1' }] } }),
    ].join('\n'));
    // channelMap knows nothing about this file (other session ID)
    const map = new Map([['uuid8:ac39cfb2', 'kimi-web']]);
    assertEq(detectSessionType(p, map), 'kimi-claw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSessionType: checkpoint hops to main file for classification', () => {
  // When the checkpoint contains only TG (no Kimi marker), naive
  // content scan would say "self-hosted" and the checkpoint would be
  // skipped. Hopping to the main file (same uuid8) reveals the merged
  // Kimi-Claw nature and rescues the checkpoint.
  const root = mkdtempSync(join(tmpdir(), 'memex-hop-'));
  try {
    const mainP = join(root, 'openclaw-3824f87a.jsonl');
    const ckptP = join(root, 'openclaw-3824f87a-ckpt-deadbeef.jsonl');
    writeFileSync(mainP, [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'User Message From Kimi:\nпривет' }] } }),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: '[Queued messages while agent was busy]\n---\nQueued #1' }] } }),
    ].join('\n'));
    writeFileSync(ckptP, JSON.stringify({
      message: { role: 'user', content: [{
        type: 'text',
        text: '[Queued messages while agent was busy]\n---\nQueued #1\nlate TG message',
      }]},
    }));
    // channelMap empty — force content path
    const map = new Map();
    assertEq(detectSessionType(ckptP, map), 'kimi-claw');
  } finally { rmSync(root, { recursive: true, force: true }); }
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

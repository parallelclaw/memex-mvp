// Standalone smoke test for extractMessageFromRecord.
// Run: node test/parser.test.js
//
// Imports lib/parse.js which has no side effects (no SQLite, no MCP boot).

import {
  extractMessageFromRecord,
  extractCompactBoundary,
} from '../lib/parse.js';

// -----------------------------------------------------------------------------

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assertEq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
  }
}

console.log('extractMessageFromRecord:\n');

test('flat format — user with string content', () => {
  const r = extractMessageFromRecord({ role: 'user', content: 'fix auth bug', timestamp: '2026-05-07T10:42:46Z' });
  assertEq(r, {
    role: 'user',
    text: 'fix auth bug',
    id: null,
    timestamp: '2026-05-07T10:42:46Z',
    uuid: null,
    parentUuid: null,
  });
});

test('nested format — Claude Code user prompt', () => {
  const r = extractMessageFromRecord({
    parentUuid: null,
    type: 'user',
    timestamp: '2026-04-22T06:40:06.500Z',
    message: { role: 'user', content: 'установи себе superpowers' },
  });
  assertEq(r.role, 'user');
  assertEq(r.text, 'установи себе superpowers');
  assertEq(r.timestamp, '2026-04-22T06:40:06.500Z');
});

test('nested format — assistant with text + tool_use blocks', () => {
  const r = extractMessageFromRecord({
    parentUuid: 'x',
    timestamp: '2026-04-22T06:40:30Z',
    message: {
      role: 'assistant', id: 'msg_01XYZ', model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', name: 'Bash', id: 't1' },
      ],
    },
  });
  assertEq(r.role, 'assistant');
  assertEq(r.text, 'Working on it.');
  assertEq(r.id, 'msg_01XYZ');
});

test('nested format — assistant with thinking + signature blob is filtered', () => {
  const r = extractMessageFromRecord({
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'EpsMClkIDRgC...' + 'A'.repeat(2000) },
        { type: 'text', text: 'answer' },
      ],
    },
  });
  assertEq(r.text, 'answer');
  if (r.text.includes('EpsM')) throw new Error('thinking signature leaked');
});

test('queue-operation events are skipped', () => {
  const r = extractMessageFromRecord({
    type: 'queue-operation', operation: 'enqueue',
    timestamp: '2026-04-22T06:40:06.202Z', sessionId: 's', content: 'duplicate text',
  });
  assertEq(r, null);
});

test('ai-title events are skipped', () => {
  const r = extractMessageFromRecord({ type: 'ai-title', aiTitle: 'Build superpowers', sessionId: 's' });
  assertEq(r, null);
});

test('attachment-only records are skipped', () => {
  const r = extractMessageFromRecord({ parentUuid: 'x', attachment: { type: 'deferred_tools_delta' } });
  assertEq(r, null);
});

test('user message with only tool_result blocks → null (no dialogue text)', () => {
  const r = extractMessageFromRecord({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }],
    },
  });
  assertEq(r, null);
});

test('null content → null', () => {
  assertEq(extractMessageFromRecord({ role: 'assistant', content: null }), null);
});

test('non-object input → null', () => {
  assertEq(extractMessageFromRecord(null), null);
  assertEq(extractMessageFromRecord('string'), null);
});

test('mixed content array — keeps text, drops everything else', () => {
  const r = extractMessageFromRecord({
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First' },
        { type: 'tool_use', name: 'Edit' },
        { type: 'text', text: 'Second' },
        { type: 'image', source: { data: 'BIG_BASE64' } },
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
      ],
    },
  });
  assertEq(r.text, 'First\nSecond');
});

test('legacy flat tool_result with string content stays in extract (filter happens later)', () => {
  // The extract function preserves tool_result; the import loop filters by role.
  const r = extractMessageFromRecord({
    role: 'tool_result', content: 'patch applied', timestamp: '2026-05-07T10:43:01Z',
  });
  assertEq(r.role, 'tool_result');
  assertEq(r.text, 'patch applied');
});

test('timestamp resolution prefers top-level over nested.timestamp', () => {
  const r = extractMessageFromRecord({
    timestamp: 'TOP',
    message: { role: 'user', content: 'hi', timestamp: 'NESTED' },
  });
  assertEq(r.timestamp, 'TOP');
});

test('uuid + parentUuid are passed through for stitching', () => {
  const r = extractMessageFromRecord({
    uuid: 'u1',
    parentUuid: 'p0',
    type: 'user',
    timestamp: '2026-05-11T11:00:00Z',
    message: { role: 'user', content: 'hello' },
  });
  assertEq(r.uuid, 'u1');
  assertEq(r.parentUuid, 'p0');
});

test('isCompactSummary message gets role=summary', () => {
  const r = extractMessageFromRecord({
    parentUuid: 'boundary-uuid',
    type: 'user',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    timestamp: '2026-05-11T11:17:36.500Z',
    message: { role: 'user', content: 'Summary:\n1. The user was...' },
  });
  assertEq(r.role, 'summary');
  assertEq(r.text.startsWith('Summary:'), true);
});

test('isVisibleInTranscriptOnly alone also flips role to summary', () => {
  const r = extractMessageFromRecord({
    type: 'user',
    isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: 'fed back into context' },
  });
  assertEq(r.role, 'summary');
});

console.log('\nextractCompactBoundary:\n');

test('raw compact_boundary record is extracted', () => {
  const r = extractCompactBoundary({
    parentUuid: null,
    logicalParentUuid: 'lp1',
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: '2026-05-11T11:17:36.086Z',
    uuid: 'ca962c54',
    compactMetadata: {
      trigger: 'auto',
      preTokens: 970197,
      postTokens: 8394,
      durationMs: 85292,
    },
  });
  if (!r) throw new Error('expected boundary, got null');
  assertEq(r.uuid, 'ca962c54');
  assertEq(r.timestamp, '2026-05-11T11:17:36.086Z');
  assertEq(r.metadata.trigger, 'auto');
  assertEq(r.metadata.preTokens, 970197);
  assertEq(r.metadata.postTokens, 8394);
  assertEq(r.logicalParentUuid, 'lp1');
});

test('daemon-emitted compact-boundary record is also extracted', () => {
  const r = extractCompactBoundary({
    type: 'compact-boundary',
    timestamp: '2026-05-11T11:17:36.086Z',
    uuid: 'ca962c54',
    parentUuid: null,
    metadata: { trigger: 'manual', preTokens: 100, postTokens: 10 },
    id: 'code-58c40180-abc123',
  });
  if (!r) throw new Error('expected boundary, got null');
  assertEq(r.uuid, 'ca962c54');
  assertEq(r.metadata.trigger, 'manual');
  assertEq(r.id, 'code-58c40180-abc123');
});

test('non-boundary record returns null from extractCompactBoundary', () => {
  assertEq(extractCompactBoundary({ type: 'user', message: { role: 'user', content: 'hi' } }), null);
  assertEq(extractCompactBoundary({ type: 'system', subtype: 'other' }), null);
  assertEq(extractCompactBoundary(null), null);
  assertEq(extractCompactBoundary('string'), null);
});

test('extractMessageFromRecord skips system/compact_boundary (no role)', () => {
  // The boundary record has no role/content — extractMessageFromRecord must
  // not try to dialogue-ify it. Use extractCompactBoundary instead.
  const r = extractMessageFromRecord({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 10 },
    timestamp: '2026-05-11T11:17:36Z',
    uuid: 'b1',
  });
  assertEq(r, null);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

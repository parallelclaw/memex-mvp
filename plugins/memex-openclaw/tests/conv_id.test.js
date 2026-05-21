/**
 * Unit tests for conv_id + msg_id derivation.
 * Run: `node --test tests/conv_id.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveConvId,
  deriveMsgId,
  extractText,
} from '../lib/conv_id.js';

// ----- deriveConvId -----

test('conv_id: telegram with channelId → per-chat thread', () => {
  assert.equal(
    deriveConvId({ messageProvider: 'telegram', channelId: '97592799' }),
    'openclaw-telegram-97592799',
  );
});

test('conv_id: discord with channelId', () => {
  assert.equal(
    deriveConvId({ messageProvider: 'discord', channelId: 'D123ABC' }),
    'openclaw-discord-D123ABC',
  );
});

test('conv_id: cli with no channelId falls back to session8', () => {
  assert.equal(
    deriveConvId({ messageProvider: 'cli', sessionId: 'abc12345-ea6e-4e08-a83a-c596288bcfe3' }),
    'openclaw-cli-abc12345',
  );
});

test('conv_id: cron with no channelId', () => {
  assert.equal(
    deriveConvId({ messageProvider: 'cron', sessionId: 'deadbeef-1111-2222-3333-444455556666' }),
    'openclaw-cron-deadbeef',
  );
});

test('conv_id: no platform falls back to session-only', () => {
  assert.equal(
    deriveConvId({ sessionId: 'abc12345-ea6e-4e08' }),
    'openclaw-abc12345',
  );
});

test('conv_id: empty inputs', () => {
  assert.equal(deriveConvId({}), 'openclaw-unknown');
  assert.equal(deriveConvId(), 'openclaw-unknown');
});

test('conv_id: platform normalised to lowercase', () => {
  assert.equal(
    deriveConvId({ messageProvider: 'Telegram', channelId: '42' }),
    'openclaw-telegram-42',
  );
});

test('conv_id: channelId coerced to string', () => {
  // ctx.channelId can be number-typed; we coerce.
  assert.equal(
    deriveConvId({ messageProvider: 'telegram', channelId: 97592799 }),
    'openclaw-telegram-97592799',
  );
});

test('conv_id: empty channelId string is treated as missing', () => {
  assert.equal(
    deriveConvId({ messageProvider: 'cli', channelId: '', sessionId: 'abc12345' }),
    'openclaw-cli-abc12345',
  );
});

// ----- deriveMsgId -----

test('msg_id: same input → same id (stable)', () => {
  const a = deriveMsgId({ role: 'user', text: 'hello', convId: 'c-1' });
  const b = deriveMsgId({ role: 'user', text: 'hello', convId: 'c-1' });
  assert.equal(a, b);
});

test('msg_id: role change → different id', () => {
  const u = deriveMsgId({ role: 'user', text: 'hi', convId: 'c-1' });
  const a = deriveMsgId({ role: 'assistant', text: 'hi', convId: 'c-1' });
  assert.notEqual(u, a);
});

test('msg_id: conv change → different id', () => {
  const a = deriveMsgId({ role: 'user', text: 'hi', convId: 'c-1' });
  const b = deriveMsgId({ role: 'user', text: 'hi', convId: 'c-2' });
  assert.notEqual(a, b);
});

test('msg_id: text change → different id', () => {
  const a = deriveMsgId({ role: 'user', text: 'hi', convId: 'c-1' });
  const b = deriveMsgId({ role: 'user', text: 'hi!', convId: 'c-1' });
  assert.notEqual(a, b);
});

test('msg_id: format is openclaw-<16hex>', () => {
  const id = deriveMsgId({ role: 'user', text: 'x', convId: 'c' });
  assert.match(id, /^openclaw-[0-9a-f]{16}$/);
});

// ----- extractText -----

test('extractText: plain string content', () => {
  assert.equal(extractText({ role: 'user', content: 'hello world' }), 'hello world');
});

test('extractText: array of content parts', () => {
  const msg = {
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', url: 'x' },
      { type: 'text', text: 'world' },
    ],
  };
  assert.equal(extractText(msg), 'hello\nworld');
});

test('extractText: object with .text field', () => {
  assert.equal(extractText({ role: 'user', content: { text: 'nested' } }), 'nested');
});

test('extractText: empty / missing → empty string', () => {
  assert.equal(extractText({ role: 'user', content: null }), '');
  assert.equal(extractText({}), '');
  assert.equal(extractText(null), '');
});

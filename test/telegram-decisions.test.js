// Tests for lib/telegram-decisions.js — per-chat allow/skip/block decisions
// stored at ~/.memex/telegram-decisions.json.

import {
  loadDecisions,
  saveDecisions,
  isAllowed,
  isSkipped,
  isBlocked,
  decideForChat,
  allowChat,
  skipChat,
  unskipChat,
  blockPattern,
  unblockPattern,
  setMode,
  VALID_MODES,
} from '../lib/telegram-decisions.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

console.log('telegram-decisions:\n');

test('loadDecisions: empty file returns default state', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-dec-'));
  try {
    const path = join(tmp, 'decisions.json');
    const state = loadDecisions(path);
    assertEq(state.mode, 'pick');
    assertEq(state.allowed_chats, []);
    assertEq(state.skipped_chats, []);
    assertEq(state.blocked_patterns, []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('saveDecisions + loadDecisions round-trip', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-dec-'));
  try {
    const path = join(tmp, 'decisions.json');
    const state = loadDecisions(path);
    allowChat(state, 'Family');
    skipChat(state, 'Bank');
    blockPattern(state, '*Tinder*', 'no dating');
    setMode(state, 'auto');
    saveDecisions(state, path);

    const reloaded = loadDecisions(path);
    assertEq(reloaded.mode, 'auto');
    assert(reloaded.allowed_chats.length === 1);
    assert(reloaded.skipped_chats.length === 1);
    assert(reloaded.blocked_patterns.length === 1);
    assert(reloaded.allowed_chats[0].title === 'Family');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('isAllowed: case-insensitive match', () => {
  const state = loadDecisions('/nonexistent');
  allowChat(state, 'Family');
  assert(isAllowed(state, 'Family'));
  assert(isAllowed(state, 'family'));
  assert(isAllowed(state, 'FAMILY'));
  assert(!isAllowed(state, 'Friends'));
});

test('isBlocked: substring pattern', () => {
  const state = loadDecisions('/nonexistent');
  blockPattern(state, 'bank');
  assert(isBlocked(state, 'Sberbank notifications'));
  assert(isBlocked(state, 'My Bank'));
  assert(!isBlocked(state, 'Family'));
});

test('isBlocked: glob pattern with *', () => {
  const state = loadDecisions('/nonexistent');
  blockPattern(state, '*bot');
  assert(isBlocked(state, 'KIMI bot'));
  assert(isBlocked(state, 'Notification bot'));
  assert(!isBlocked(state, 'Family chat'));
});

test('decideForChat: block beats skip beats allow beats default', () => {
  const state = loadDecisions('/nonexistent');
  allowChat(state, 'Family');
  skipChat(state, 'Bank');
  blockPattern(state, '*Tinder*');

  assertEq(decideForChat(state, 'Family'), 'import');
  assertEq(decideForChat(state, 'Bank'), 'skip');
  assertEq(decideForChat(state, 'Tinder dates'), 'block');
  assertEq(decideForChat(state, 'New chat'), 'pending');
});

test('allowChat moves from skipped to allowed', () => {
  const state = loadDecisions('/nonexistent');
  skipChat(state, 'Maybe');
  assertEq(decideForChat(state, 'Maybe'), 'skip');

  allowChat(state, 'Maybe');
  assertEq(decideForChat(state, 'Maybe'), 'import');
  // Skipped list no longer contains it
  assert(state.skipped_chats.every((c) => c.title.toLowerCase() !== 'maybe'));
});

test('skipChat moves from allowed to skipped', () => {
  const state = loadDecisions('/nonexistent');
  allowChat(state, 'Changed');
  skipChat(state, 'Changed');
  assertEq(decideForChat(state, 'Changed'), 'skip');
  assert(state.allowed_chats.every((c) => c.title.toLowerCase() !== 'changed'));
});

test('unskipChat: removes from skipped', () => {
  const state = loadDecisions('/nonexistent');
  skipChat(state, 'Bank');
  assert(isSkipped(state, 'Bank'));
  unskipChat(state, 'Bank');
  assert(!isSkipped(state, 'Bank'));
});

test('unblockPattern removes pattern', () => {
  const state = loadDecisions('/nonexistent');
  blockPattern(state, 'spam');
  assert(isBlocked(state, 'Spam channel'));
  unblockPattern(state, 'spam');
  assert(!isBlocked(state, 'Spam channel'));
});

test('setMode validates input', () => {
  const state = loadDecisions('/nonexistent');
  setMode(state, 'auto');
  assertEq(state.mode, 'auto');
  let threw = false;
  try { setMode(state, 'banana'); } catch (e) { threw = true; }
  assert(threw, 'invalid mode should throw');
});

test('VALID_MODES exports the expected set', () => {
  assertEq(VALID_MODES, ['pick', 'auto', 'manual']);
});

test('idempotent: allowChat on already-allowed is a no-op', () => {
  const state = loadDecisions('/nonexistent');
  allowChat(state, 'Family');
  allowChat(state, 'Family');
  assertEq(state.allowed_chats.length, 1);
});

test('idempotent: skipChat on already-skipped is a no-op', () => {
  const state = loadDecisions('/nonexistent');
  skipChat(state, 'Bank');
  skipChat(state, 'Bank');
  assertEq(state.skipped_chats.length, 1);
});

test('atomic save: corrupt JSON file falls back to default', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-dec-'));
  try {
    const path = join(tmp, 'decisions.json');
    writeFileSync(path, '{ corrupt');
    const state = loadDecisions(path);
    assertEq(state.mode, 'pick');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

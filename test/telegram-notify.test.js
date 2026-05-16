// Tests for lib/telegram-notify.js — cross-channel notification + dedup state.

import {
  loadNotifyState,
  saveNotifyState,
  cliTipDue,
  markCliTipShown,
  notifIdFor,
  notifShownFor,
  markNotifShown,
  setNotificationsEnabled,
  setClickTarget,
  formatTelegramTip,
  VALID_CLICK_TARGETS,
} from '../lib/telegram-notify.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

console.log('telegram-notify:\n');

test('loadNotifyState: empty file returns defaults', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-notify-'));
  try {
    const p = join(tmp, '.tg-tip-state.json');
    const s = loadNotifyState(p);
    assertEq(s.cli_tip_last_shown_at, null);
    assertEq(s.notif_shown_for_ids, []);
    assertEq(s.notifications.enabled, false);
    assertEq(s.notifications.show_titles, false);
    assertEq(s.notifications.click_target, 'auto');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('saveNotifyState + loadNotifyState round-trip', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-notify-'));
  try {
    const p = join(tmp, '.tg-tip-state.json');
    const s = loadNotifyState(p);
    markCliTipShown(s);
    markNotifShown(s, ['/path/to/export']);
    setNotificationsEnabled(s, true, true);
    saveNotifyState(s, p);

    const r = loadNotifyState(p);
    assert(r.cli_tip_last_shown_at, 'cli_tip should be set');
    assert(r.notif_shown_for_ids.length === 1);
    assertEq(r.notifications.enabled, true);
    assertEq(r.notifications.show_titles, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('cliTipDue: returns true when never shown', () => {
  const s = loadNotifyState('/nonexistent');
  assert(cliTipDue(s, 6) === true);
});

test('cliTipDue: returns false within cooldown', () => {
  const s = loadNotifyState('/nonexistent');
  markCliTipShown(s);
  assert(cliTipDue(s, 6) === false);
});

test('cliTipDue: returns true after cooldown elapsed', () => {
  const s = loadNotifyState('/nonexistent');
  s.cli_tip_last_shown_at = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  assert(cliTipDue(s, 6) === true);
});

test('cliTipDue: handles invalid ISO string', () => {
  const s = loadNotifyState('/nonexistent');
  s.cli_tip_last_shown_at = 'banana';
  assert(cliTipDue(s, 6) === true);
});

test('notifIdFor: stable hash of path', () => {
  const a = notifIdFor('/Users/me/foo');
  const b = notifIdFor('/Users/me/foo');
  const c = notifIdFor('/Users/me/bar');
  assert(a === b, 'same path → same id');
  assert(a !== c, 'different paths → different ids');
  assert(a.length === 16, 'id is 16 hex chars');
});

test('notifShownFor: dedup by path', () => {
  const s = loadNotifyState('/nonexistent');
  markNotifShown(s, ['/path/one', '/path/two']);
  assert(notifShownFor(s, '/path/one'));
  assert(notifShownFor(s, '/path/two'));
  assert(!notifShownFor(s, '/path/three'));
});

test('markNotifShown: idempotent', () => {
  const s = loadNotifyState('/nonexistent');
  markNotifShown(s, ['/path']);
  markNotifShown(s, ['/path']);
  markNotifShown(s, ['/path']);
  assertEq(s.notif_shown_for_ids.length, 1);
});

test('markNotifShown: caps memory at 200', () => {
  const s = loadNotifyState('/nonexistent');
  const paths = [];
  for (let i = 0; i < 250; i++) paths.push(`/path/${i}`);
  markNotifShown(s, paths);
  assert(s.notif_shown_for_ids.length === 200, `expected 200, got ${s.notif_shown_for_ids.length}`);
  // Most-recent should be kept
  assert(s.notif_shown_for_ids.includes(notifIdFor('/path/249')));
  // Oldest should be evicted
  assert(!s.notif_shown_for_ids.includes(notifIdFor('/path/0')));
});

test('setNotificationsEnabled: toggle ON without changing show_titles', () => {
  const s = loadNotifyState('/nonexistent');
  setNotificationsEnabled(s, true);
  assertEq(s.notifications.enabled, true);
  assertEq(s.notifications.show_titles, false);
  setNotificationsEnabled(s, false);
  assertEq(s.notifications.enabled, false);
  assertEq(s.notifications.show_titles, false);
});

test('setNotificationsEnabled: explicit show_titles', () => {
  const s = loadNotifyState('/nonexistent');
  setNotificationsEnabled(s, true, true);
  assertEq(s.notifications.show_titles, true);
});

test('formatTelegramTip: empty list returns empty string', () => {
  assertEq(formatTelegramTip([]), '');
  assertEq(formatTelegramTip(null), '');
});

test('formatTelegramTip: with titles includes names + count', () => {
  const tip = formatTelegramTip([
    { chat_title: 'Family', message_count: 1876 },
    { chat_title: 'Work', message_count: 3221 },
  ]);
  assert(tip.includes('2 Telegram exports'));
  assert(tip.includes('Family'));
  assert(tip.includes('Work'));
  assert(tip.includes('memex telegram pending'));
});

test('formatTelegramTip: hides titles when showTitles=false', () => {
  const tip = formatTelegramTip(
    [{ chat_title: 'Family', message_count: 100 }],
    { showTitles: false }
  );
  assert(!tip.includes('Family'));
  assert(tip.includes('1 Telegram export'));
});

test('formatTelegramTip: "and N more" for >3 entries', () => {
  const tip = formatTelegramTip([
    { chat_title: 'A', message_count: 1 },
    { chat_title: 'B', message_count: 2 },
    { chat_title: 'C', message_count: 3 },
    { chat_title: 'D', message_count: 4 },
    { chat_title: 'E', message_count: 5 },
  ]);
  assert(tip.includes('5 Telegram exports'));
  assert(tip.includes('and 2 more'));
  assert(!tip.includes('D'));
  assert(!tip.includes('E'));
});

test('formatTelegramTip: handles missing message_count', () => {
  const tip = formatTelegramTip([{ chat_title: 'X' }]);
  assert(tip.includes('X'));
  assert(tip.includes('?'));
});

// ---------- v0.10.4: click_target ----------

test('default state has click_target=auto', () => {
  const s = loadNotifyState('/nonexistent');
  assertEq(s.notifications.click_target, 'auto');
});

test('setClickTarget: accepts valid values', () => {
  const s = loadNotifyState('/nonexistent');
  for (const t of VALID_CLICK_TARGETS) {
    setClickTarget(s, t);
    assertEq(s.notifications.click_target, t);
  }
});

test('setClickTarget: throws on invalid value', () => {
  const s = loadNotifyState('/nonexistent');
  let threw = false;
  try { setClickTarget(s, 'banana'); } catch (e) { threw = true; }
  assert(threw, 'invalid target should throw');
});

test('VALID_CLICK_TARGETS exports the expected set', () => {
  assertEq(VALID_CLICK_TARGETS, ['auto', 'claude-cli', 'claude-desktop', 'terminal', 'none']);
});

test('saveNotifyState + loadNotifyState round-trip preserves click_target', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-notify-ct-'));
  try {
    const p = join(tmp, '.tg-tip-state.json');
    const s = loadNotifyState(p);
    setClickTarget(s, 'terminal');
    saveNotifyState(s, p);

    const r = loadNotifyState(p);
    assertEq(r.notifications.click_target, 'terminal');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Cross-channel notification + dedup state for the Telegram capture flow.
 *
 * State file: ~/.memex/.tg-tip-state.json — small JSON the daemon and CLI
 * both read/write to coordinate WHEN a message was last shown to the user.
 *
 *   {
 *     version: 1,
 *     cli_tip_last_shown_at: ISO-8601,           // throttle CLI tips to once/6h
 *     notif_shown_for_ids: ["sha256(path)", …],  // skip macOS notif we already fired
 *     notifications: { enabled: false, show_titles: false }
 *   }
 *
 * Public surface:
 *   • loadNotifyState()                          → state object (fresh on every call)
 *   • saveNotifyState(state)                     → atomic write
 *   • cliTipDue(state, cooldownHours=6)          → bool — should CLI tip render?
 *   • markCliTipShown(state)                     → record now() in state
 *   • notifShownFor(state, path)                 → bool — already sent macOS notif?
 *   • markNotifShown(state, paths[])             → record ids
 *   • fireMacosNotification(title, body)         → osascript shell-out (best-effort)
 *   • setNotificationsEnabled(state, enabled, showTitles?)
 *   • formatTelegramTip(entries, opts)           → markdown string (channel B)
 *
 * All of this is platform-tolerant — on Linux/Windows we don't fire native
 * notifications (osascript is macOS-only). The CLI tip + agent injection
 * still work everywhere.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';

const HOME = homedir();
export const STATE_PATH = join(HOME, '.memex', '.tg-tip-state.json');

const DEFAULT_STATE = () => ({
  version: 1,
  cli_tip_last_shown_at: null,
  notif_shown_for_ids: [],
  notifications: {
    enabled: false,    // privacy-first: opt-in for macOS notification
    show_titles: false, // even when on, don't leak chat names by default
  },
});

export function loadNotifyState(path = STATE_PATH) {
  if (!existsSync(path)) return DEFAULT_STATE();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE(),
      ...parsed,
      notifications: { ...DEFAULT_STATE().notifications, ...(parsed.notifications || {}) },
      notif_shown_for_ids: Array.isArray(parsed.notif_shown_for_ids)
        ? parsed.notif_shown_for_ids
        : [],
    };
  } catch (_) {
    return DEFAULT_STATE();
  }
}

export function saveNotifyState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// ---------------------- CLI tip throttle ----------------------

const ONE_HOUR_MS = 60 * 60 * 1000;

export function cliTipDue(state, cooldownHours = 6) {
  if (!state.cli_tip_last_shown_at) return true;
  const last = Date.parse(state.cli_tip_last_shown_at);
  if (isNaN(last)) return true;
  return Date.now() - last >= cooldownHours * ONE_HOUR_MS;
}

export function markCliTipShown(state, now = new Date()) {
  state.cli_tip_last_shown_at = now.toISOString();
  return state;
}

// ---------------------- Notification dedup ----------------------

export function notifIdFor(path) {
  return createHash('sha256').update(String(path)).digest('hex').slice(0, 16);
}

export function notifShownFor(state, path) {
  return state.notif_shown_for_ids.includes(notifIdFor(path));
}

export function markNotifShown(state, paths) {
  const ids = (Array.isArray(paths) ? paths : [paths]).map(notifIdFor);
  for (const id of ids) {
    if (!state.notif_shown_for_ids.includes(id)) state.notif_shown_for_ids.push(id);
  }
  // Cap memory — keep last 200
  if (state.notif_shown_for_ids.length > 200) {
    state.notif_shown_for_ids = state.notif_shown_for_ids.slice(-200);
  }
  return state;
}

// ---------------------- macOS native notification ----------------------

/**
 * Fire a native macOS notification via osascript. Best-effort — silently
 * no-ops on Linux/Windows. On macOS we may hit the user's notification-
 * permission gate; we don't care to handle that synchronously.
 *
 * Returns true if we tried (macOS), false if we skipped (other platforms).
 */
export function fireMacosNotification(title, body, opts = {}) {
  if (platform() !== 'darwin') return false;
  // Escape double quotes for AppleScript string literals
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const subtitle = opts.subtitle ? ` subtitle "${esc(opts.subtitle)}"` : '';
  const sound = opts.silent ? '' : ` sound name "Pop"`;
  const script = `display notification "${esc(body)}" with title "${esc(title)}"${subtitle}${sound}`;
  try {
    // Non-blocking — fire and forget
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------- Mutators for notifications config ----------------------

export function setNotificationsEnabled(state, enabled, showTitles = null) {
  state.notifications.enabled = !!enabled;
  if (showTitles !== null) state.notifications.show_titles = !!showTitles;
  return state;
}

// ---------------------- Channel B formatter ----------------------

/**
 * Render the CLI tip block (printed at the end of any non-telegram
 * memex CLI command, suppressed if pending=0 or recently shown).
 *
 *   💡 3 Telegram export(s) ready to review:
 *      • Family (1,876 msgs)
 *      • Work team (3,221 msgs)
 *      • … and 1 more
 *      Run: memex telegram pending
 *
 * Always shows count + up to 3 chat titles + "and N more" tail. Honors
 * `show_titles=false` setting by hiding titles entirely (just count).
 */
export function formatTelegramTip(entries, opts = {}) {
  if (!entries || entries.length === 0) return '';
  const showTitles = opts.showTitles !== false;
  const count = entries.length;
  const lines = [];
  lines.push('');
  lines.push(`💡 ${count} Telegram export${count === 1 ? '' : 's'} ready to review:`);
  if (showTitles) {
    const preview = entries.slice(0, 3);
    for (const e of preview) {
      const t = e.chat_title || '(untitled)';
      const n = e.message_count ? `${e.message_count.toLocaleString()} msgs` : '?';
      lines.push(`   • ${t} (${n})`);
    }
    if (entries.length > 3) lines.push(`   • … and ${entries.length - 3} more`);
  }
  lines.push('   Run: memex telegram pending');
  return lines.join('\n');
}

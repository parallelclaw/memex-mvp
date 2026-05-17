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
  statSync,
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
  // v0.10.10: dashboard discovery throttle. Three-strike pattern so the tip
  // appears on a few different terminal sessions in the first days after
  // install, then quiets down. Becomes permanently silent once the user
  // actually opens the dashboard at least once.
  dashboard_tip_shown_count: 0,
  dashboard_tip_last_shown_at: null,
  dashboard_ever_opened: false,
  notifications: {
    enabled: false,    // privacy-first: opt-in for macOS notification
    show_titles: false, // even when on, don't leak chat names by default
    // v0.10.4+: which app to open when the user clicks the banner.
    //   'auto'           → priority: claude-cli > claude-desktop > terminal
    //   'claude-cli'     → force open Claude Code CLI in a new Terminal tab
    //   'claude-desktop' → force open Claude Desktop GUI
    //   'terminal'       → force open Terminal with `memex telegram pending`
    //   'none'           → banner not clickable
    // If terminal-notifier is not installed, click is impossible — banner
    // text falls back to "Run: memex telegram pending".
    click_target: 'auto',
  },
});

export const VALID_CLICK_TARGETS = ['auto', 'claude-cli', 'claude-desktop', 'terminal', 'none'];

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

// ---------------------- Dashboard discovery tip (v0.10.10) ----------------------

/**
 * Whether the "try memex web" tip should fire on the next CLI command.
 *
 *   - Hard-stop once the user has actually run `memex web` (any duration)
 *   - Cap at maxShows (default 3) total reveals
 *   - Cooldown cooldownHours (default 12) between reveals so it doesn't
 *     stack with the TG-pending tip on the same minute
 */
export function dashboardTipDue(state, opts = {}) {
  const { maxShows = 3, cooldownHours = 12 } = opts;
  if (state.dashboard_ever_opened) return false;
  if ((state.dashboard_tip_shown_count || 0) >= maxShows) return false;
  if (!state.dashboard_tip_last_shown_at) return true;
  const last = Date.parse(state.dashboard_tip_last_shown_at);
  if (isNaN(last)) return true;
  return Date.now() - last >= cooldownHours * ONE_HOUR_MS;
}

export function markDashboardTipShown(state, now = new Date()) {
  state.dashboard_tip_shown_count = (state.dashboard_tip_shown_count || 0) + 1;
  state.dashboard_tip_last_shown_at = now.toISOString();
  return state;
}

/**
 * Permanently silence the dashboard tip — call this the first time the user
 * actually runs `memex web`. They've discovered it; no need to keep nagging.
 */
export function markDashboardEverOpened(state) {
  state.dashboard_ever_opened = true;
  return state;
}

/**
 * The tip text itself. Plain string (no ANSI) — the caller decides whether
 * to dim it. Returns null if there is genuinely nothing to say (defensive).
 */
export function formatDashboardTip() {
  return '💡 New: try `memex web --open` — browse your memory in a browser (read-only, localhost only).';
}

// ---------------------- Notification dedup ----------------------

/**
 * Stable hash of a pending export for notification dedup.
 *
 * v0.10.5+: hash now incorporates the file's mtime in addition to path.
 *
 * Why: Telegram Desktop reuses the same folder name on same-day re-exports
 * (e.g. ChatExport_2026-05-16). After memex imports & removes that folder
 * from pending, a fresh export with the same date creates the same path
 * again. Path-only hash collided → notification was incorrectly deduped
 * as "already shown".
 *
 * Including mtime makes the hash content-aware: same path + different
 * mtime → fresh hash → notification fires. If the path doesn't exist
 * (file was deleted), we fall back to path-only — it's an edge case
 * (notifShownFor check before fire, file should exist).
 */
export function notifIdFor(path) {
  let mtimeKey = '';
  try { mtimeKey = String(Math.floor(statSync(path).mtimeMs)); } catch (_) { /* path missing — fall back to path-only */ }
  return createHash('sha256').update(String(path) + ':' + mtimeKey).digest('hex').slice(0, 16);
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

export function setClickTarget(state, target) {
  if (!VALID_CLICK_TARGETS.includes(target)) {
    throw new Error(`Invalid click_target '${target}'. Valid: ${VALID_CLICK_TARGETS.join(', ')}`);
  }
  state.notifications.click_target = target;
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

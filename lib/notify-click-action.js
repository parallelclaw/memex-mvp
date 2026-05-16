/**
 * Notification click-action picker for Telegram capture (v0.10.4+).
 *
 * macOS `osascript display notification` banners are NOT clickable — clicking
 * them opens the parent app (Script Editor), which is confusing. To get a real
 * click-action we use third-party `terminal-notifier` (brew install) which has
 * `-execute "<shell command>"` support.
 *
 * Click target priority (auto-detect):
 *   1. Claude Code CLI installed → open Terminal, launch `claude`
 *      → SessionStart hook (v0.8+) fires → agent leads with pending banner.
 *      This is the "Brian Chesky moment" — the wow case.
 *   2. Claude Desktop installed (no CLI) → `open -a Claude`
 *      MCP is connected, but no auto-context. User has to ask.
 *   3. Neither → open Terminal with `memex telegram pending` queued.
 *
 * User can override via `memex telegram notifications target <X>`:
 *   auto · claude-cli · claude-desktop · terminal · none
 *
 * This module is shell-out heavy; everything runs detached so we never
 * block the daemon's chokidar event loop.
 */

import { existsSync, accessSync, constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

// ------------------------- Binary detection -------------------------

/**
 * Is a binary available on PATH? Returns the absolute path or null.
 * We do this manually (vs `which`) so it's fast + cross-platform.
 */
export function findBin(name) {
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  // Also include common shell-rc-installed dirs that GUI daemons miss
  const extras = [
    join(homedir(), '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of [...pathDirs, ...extras]) {
    const full = join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch (_) { /* not here */ }
  }
  return null;
}

/**
 * Detect the user's notification + click-action environment.
 *
 * Returns an object describing what's available and what we'd pick if
 * `target === 'auto'`. Cached briefly — detection is cheap but we don't
 * want to fs.exists() on every fired notification.
 */
let _detectCache = null;
let _detectCacheAt = 0;
const DETECT_CACHE_MS = 30_000;

export function detectEnvironment(force = false) {
  if (!force && _detectCache && (Date.now() - _detectCacheAt) < DETECT_CACHE_MS) {
    return _detectCache;
  }
  const env = {
    platform: platform(),
    terminal_notifier: findBin('terminal-notifier'),
    claude_cli: findBin('claude'),
    claude_desktop: detectClaudeDesktop(),
    memex_bin: findBin('memex'),
  };
  _detectCache = env;
  _detectCacheAt = Date.now();
  return env;
}

function detectClaudeDesktop() {
  if (platform() !== 'darwin') return null;
  const candidates = [
    '/Applications/Claude.app',
    join(homedir(), 'Applications/Claude.app'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ------------------------- Target selection -------------------------

/**
 * Decide which click-action target to use given the user's preference
 * and detected environment.
 *
 * Returns one of: 'claude-cli', 'claude-desktop', 'terminal', 'none'.
 *
 *   preference = 'auto'           → priority: cli > desktop > terminal
 *   preference = 'claude-cli'     → use if installed, else fall through to auto
 *   preference = 'claude-desktop' → use if installed, else fall through to auto
 *   preference = 'terminal'       → always Terminal (user opted out of Claude)
 *   preference = 'none'           → no click action
 */
export function pickTarget(preference, env = detectEnvironment()) {
  if (preference === 'none') return 'none';
  if (preference === 'terminal') return 'terminal';
  if (preference === 'claude-cli' && env.claude_cli) return 'claude-cli';
  if (preference === 'claude-desktop' && env.claude_desktop) return 'claude-desktop';
  // auto (or explicit-but-not-installed) — fall through priority
  if (env.claude_cli) return 'claude-cli';
  if (env.claude_desktop) return 'claude-desktop';
  return 'terminal';
}

/**
 * Human-readable label for the chosen target — shown in `notifications status`
 * and used as the banner-text "call to action".
 */
export function targetLabel(target) {
  switch (target) {
    case 'claude-cli':     return 'Claude Code CLI (Brian Chesky moment)';
    case 'claude-desktop': return 'Claude Desktop';
    case 'terminal':       return 'Terminal with `memex telegram pending`';
    case 'none':           return 'no click action';
    default:               return target;
  }
}

/**
 * The call-to-action shown in the banner body. Depends on:
 *   • target (claude-cli / claude-desktop / terminal / none)
 *   • clickable (is terminal-notifier installed so the banner is actually clickable?)
 *
 * When NOT clickable, we drop the "Click to ..." phrasing and instead
 * show the literal shell command so users without terminal-notifier
 * still know exactly what to do.
 */
export function bannerCallToAction(target, clickable = true) {
  if (!clickable) {
    // No click possible — show concrete action user must take manually
    if (target === 'claude-cli')     return 'Run: claude (or memex telegram pending)';
    if (target === 'claude-desktop') return 'Open Claude Desktop, ask "what\'s pending in memex?"';
    return 'Run: memex telegram pending';
  }
  switch (target) {
    case 'claude-cli':     return 'Click to launch Claude';
    case 'claude-desktop': return 'Click to open Claude Desktop';
    case 'terminal':       return 'Click to open Terminal';
    case 'none':           return 'Run: memex telegram pending';
    default:               return 'memex telegram pending';
  }
}

// ------------------------- Build click-action shell command -------------------------

/**
 * Compose the shell command that `terminal-notifier -execute` will run when
 * the user clicks the banner.
 *
 * Returns null if target = 'none' (banner has no click action).
 *
 * Notes:
 *   • Each target is wrapped in `osascript` to invoke macOS' Terminal app,
 *     so the user lands in an interactive shell session (not a daemon-spawned
 *     headless process).
 *   • Quoting: we shell-escape the inner double quotes for AppleScript's
 *     `do script` parameter.
 */
export function buildClickCommand(target, env = detectEnvironment()) {
  if (target === 'none') return null;

  if (target === 'claude-cli') {
    // Open a fresh Terminal window, launch `claude` from $HOME so the
    // SessionStart hook injects pending Telegram exports into the
    // first message. The hook fires regardless of cwd; pending is always
    // surfaced when count > 0.
    const cliPath = env.claude_cli || 'claude';
    return `osascript -e 'tell application "Terminal" to activate' ` +
           `-e 'tell application "Terminal" to do script "cd ~ && ${escapeApple(cliPath)}"'`;
  }

  if (target === 'claude-desktop') {
    const appPath = env.claude_desktop || '/Applications/Claude.app';
    return `open ${shellQuote(appPath)}`;
  }

  if (target === 'terminal') {
    // Open Terminal and run `memex telegram pending` so user sees the list
    const memexBin = env.memex_bin || 'memex';
    return `osascript -e 'tell application "Terminal" to activate' ` +
           `-e 'tell application "Terminal" to do script "${escapeApple(memexBin)} telegram pending"'`;
  }

  return null;
}

// AppleScript "do script" takes a string — we need to escape backslash + dquote
function escapeApple(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Conservative shell quote — used for `open <path>` where path may contain spaces
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// ------------------------- Fire the notification -------------------------

/**
 * Fire a clickable notification via terminal-notifier (preferred) or fall
 * back to plain osascript (no click).
 *
 *   opts = {
 *     title, subtitle, message,
 *     target,    // 'auto' | 'claude-cli' | 'claude-desktop' | 'terminal' | 'none'
 *     env,       // optional override of detected env (for tests)
 *     dryRun,    // if true → compute backend+target+command but DON'T spawn.
 *                //   Used by unit tests so `npm test` doesn't spam real
 *                //   macOS notifications. Also honors env MEMEX_NO_FIRE=1.
 *   }
 *
 * Returns { backend: 'terminal-notifier' | 'osascript' | 'noop',
 *           target, click_command }
 */
export function fireClickableNotification(opts = {}) {
  const env = opts.env || detectEnvironment();
  if (env.platform !== 'darwin') return { backend: 'noop', target: 'none', click_command: null };

  const target = pickTarget(opts.target || 'auto', env);
  const click = buildClickCommand(target, env);
  const dryRun = opts.dryRun === true || process.env.MEMEX_NO_FIRE === '1';

  const title = opts.title || 'memex';
  const subtitle = opts.subtitle || '';
  const message = opts.message || '';

  if (env.terminal_notifier && click) {
    if (dryRun) return { backend: 'terminal-notifier', target, click_command: click };
    const args = [
      '-title', title,
      '-message', message,
      '-execute', click,
    ];
    if (subtitle) { args.push('-subtitle'); args.push(subtitle); }
    args.push('-sound', 'Pop');
    args.push('-sender', 'com.apple.Terminal');
    try {
      spawn(env.terminal_notifier, args, { detached: true, stdio: 'ignore' }).unref();
      return { backend: 'terminal-notifier', target, click_command: click };
    } catch (_) { /* fall through to osascript */ }
  }

  // Plain osascript fallback — banner is not clickable but text is informative
  if (dryRun) return { backend: 'osascript', target: 'none', click_command: null };
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sub = subtitle ? ` subtitle "${esc(subtitle)}"` : '';
  const script = `display notification "${esc(message)}" with title "${esc(title)}"${sub} sound name "Pop"`;
  try {
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    return { backend: 'osascript', target: 'none', click_command: null };
  } catch (_) {
    return { backend: 'noop', target: 'none', click_command: null };
  }
}

/**
 * Run the click-action directly (for `memex telegram open-pending` CLI).
 * Same target-resolution logic as the notification, just invoked from CLI.
 */
export function executeClickAction(preference = 'auto', env = detectEnvironment()) {
  const target = pickTarget(preference, env);
  const cmd = buildClickCommand(target, env);
  if (!cmd) return { ran: false, target, reason: 'no-action' };
  try {
    spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
    return { ran: true, target, command: cmd };
  } catch (e) {
    return { ran: false, target, reason: e.message };
  }
}

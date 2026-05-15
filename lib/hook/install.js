/**
 * Claude Code SessionStart hook installer for memex auto-context.
 *
 * When the user opens a new Claude Code session, Claude Code looks at
 * ~/.claude/settings.json for `hooks.SessionStart` entries and runs each
 * command before showing the user the first prompt. The stdout of those
 * commands gets injected into Claude's context as a system message.
 *
 * Memex's hook calls `memex context` which outputs a markdown summary of
 * recent memex activity relevant to the current pwd. End result: Claude
 * "knows" what you were doing in this project without you having to ask.
 *
 * Idempotency: install operations are safe to re-run. We detect our entry
 * by command-string match — if any SessionStart hook command starts with
 * MEMEX_COMMAND_MARKER, we treat it as ours and don't add another.
 *
 * Atomicity: we always write to a .tmp file first, then rename. Never
 * touch the user's existing hooks for other tools.
 *
 * Cross-client: only Claude Code and OpenClaw have SessionStart natively.
 * For Cursor/Cline/Continue/Zed, fallback strategies (MCP resource, skills,
 * system prompt) are tracked separately — not part of this module.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { execSync } from 'node:child_process';

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

// Command marker — every memex hook command starts with this. Used to
// detect our own entry for idempotency / uninstall, without collision
// risk against other tools' hooks (gstack, custom user hooks, etc.).
const MEMEX_COMMAND_MARKER = 'memex context';

/**
 * Returns the absolute path to the `memex` binary that should be used in
 * the hook command. Tries multiple strategies in order:
 *   1. `which memex` (npm-global install)
 *   2. process.execPath + this module's known location (current invocation)
 *   3. fallback to bare "memex" (relies on PATH at hook execution time)
 *
 * Returns the resolved path string.
 */
export function resolveMemexBinPath() {
  try {
    const which = execSync('which memex', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which && existsSync(which)) return which;
  } catch (_) {}
  // Fallback: rely on PATH at hook-execution time. Claude Code loads
  // user shell environment for hooks, so PATH usually works.
  return 'memex';
}

/**
 * Read ~/.claude/settings.json safely. Returns:
 *   { exists: bool, valid: bool, data: object, raw: string|null }
 */
export function readSettings() {
  if (!existsSync(SETTINGS_PATH)) {
    return { exists: false, valid: true, data: {}, raw: null };
  }
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return { exists: true, valid: true, data, raw };
  } catch (e) {
    return {
      exists: true,
      valid: false,
      data: {},
      raw: null,
      error: e.message,
    };
  }
}

/**
 * Find our memex SessionStart hook entry in the parsed settings.
 * Returns { found: bool, index: number, command: string|null }.
 *
 * Claude Code's hooks schema (as of 2026):
 *   settings.hooks.SessionStart = [
 *     { matcher: "...", hooks: [{ type: "command", command: "..." }] }
 *   ]
 *
 * We treat an outer entry as "ours" if any of its inner hooks has a
 * command string containing MEMEX_COMMAND_MARKER.
 */
export function findMemexHookEntry(settings) {
  const sessionStart = settings?.hooks?.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return { found: false, index: -1, command: null };
  }
  for (let i = 0; i < sessionStart.length; i++) {
    const entry = sessionStart[i];
    const inner = entry?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command === 'string' && h.command.includes(MEMEX_COMMAND_MARKER)) {
        return { found: true, index: i, command: h.command };
      }
    }
  }
  return { found: false, index: -1, command: null };
}

/**
 * Add the memex SessionStart hook entry to ~/.claude/settings.json.
 *
 * Idempotent: if a memex entry already exists, no-op (returns
 * alreadyPresent: true). If the user has OTHER SessionStart hooks (e.g.
 * from gstack), they are preserved untouched — we only append our entry
 * to the array.
 *
 * Returns:
 *   { installed: bool, alreadyPresent: bool, settingsPath: str,
 *     command: str, error: str|null }
 */
export function installHook(opts = {}) {
  const binPath = opts.binPath || resolveMemexBinPath();
  const command = `${binPath} context`;

  const settings = readSettings();
  if (settings.exists && !settings.valid) {
    return {
      installed: false,
      alreadyPresent: false,
      settingsPath: SETTINGS_PATH,
      command,
      error: `Could not parse ${SETTINGS_PATH}: ${settings.error}. Fix the file manually first.`,
    };
  }

  const data = settings.data || {};
  const existing = findMemexHookEntry(data);
  if (existing.found) {
    return {
      installed: false,
      alreadyPresent: true,
      settingsPath: SETTINGS_PATH,
      command: existing.command,
      error: null,
    };
  }

  // Build our entry. Use ".*" matcher (match any session) and the standard
  // {type: "command", command: ...} inner hook shape.
  const memexEntry = {
    matcher: '.*',
    hooks: [{ type: 'command', command }],
  };

  // Defensive nested-set: never clobber adjacent keys
  if (!data.hooks) data.hooks = {};
  if (!Array.isArray(data.hooks.SessionStart)) data.hooks.SessionStart = [];
  data.hooks.SessionStart.push(memexEntry);

  // Atomic write — temp file + rename
  try {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    const tmpPath = SETTINGS_PATH + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, SETTINGS_PATH);
  } catch (e) {
    return {
      installed: false,
      alreadyPresent: false,
      settingsPath: SETTINGS_PATH,
      command,
      error: `Failed to write ${SETTINGS_PATH}: ${e.message}`,
    };
  }

  return {
    installed: true,
    alreadyPresent: false,
    settingsPath: SETTINGS_PATH,
    command,
    error: null,
  };
}

/**
 * Remove the memex SessionStart hook entry. Preserves all other hooks.
 *
 * Returns: { removed: bool, wasPresent: bool, error: str|null }
 */
export function uninstallHook() {
  const settings = readSettings();
  if (!settings.exists) {
    return { removed: false, wasPresent: false, error: null };
  }
  if (!settings.valid) {
    return {
      removed: false,
      wasPresent: false,
      error: `Could not parse ${SETTINGS_PATH}: ${settings.error}`,
    };
  }

  const data = settings.data;
  const existing = findMemexHookEntry(data);
  if (!existing.found) {
    return { removed: false, wasPresent: false, error: null };
  }

  // Remove our entry from the SessionStart array
  data.hooks.SessionStart.splice(existing.index, 1);

  // Cleanup empty containers — don't leave behind `hooks: {SessionStart: []}`
  // detritus if memex was the only hook.
  if (data.hooks.SessionStart.length === 0) delete data.hooks.SessionStart;
  if (data.hooks && Object.keys(data.hooks).length === 0) delete data.hooks;

  try {
    const tmpPath = SETTINGS_PATH + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, SETTINGS_PATH);
  } catch (e) {
    return {
      removed: false,
      wasPresent: true,
      error: `Failed to write ${SETTINGS_PATH}: ${e.message}`,
    };
  }

  return { removed: true, wasPresent: true, error: null };
}

/**
 * Inspect current hook status. Returns:
 *   { installed: bool, settingsPath: str, command: str|null,
 *     otherSessionStartHooks: number, settingsExists: bool,
 *     settingsValid: bool }
 */
export function getHookStatus() {
  const settings = readSettings();
  const result = {
    installed: false,
    settingsPath: SETTINGS_PATH,
    command: null,
    otherSessionStartHooks: 0,
    settingsExists: settings.exists,
    settingsValid: settings.valid,
  };
  if (!settings.exists || !settings.valid) return result;

  const sessionStart = settings.data?.hooks?.SessionStart || [];
  const found = findMemexHookEntry(settings.data);
  result.installed = found.found;
  result.command = found.command;
  result.otherSessionStartHooks = found.found
    ? sessionStart.length - 1
    : sessionStart.length;
  return result;
}

export { MEMEX_COMMAND_MARKER, SETTINGS_PATH };

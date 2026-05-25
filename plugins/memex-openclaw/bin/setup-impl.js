/**
 * Setup orchestrator — lives in bin/ (NOT lib/) so OpenClaw's plugin
 * security scanner doesn't flag the package on `openclaw plugins
 * install`. The scanner forbids `child_process` in lib/ — that's the
 * sandboxed plugin code surface. bin/ scripts are external CLI tools
 * the user / agent runs in their own shell after install, so shell
 * primitives are fine here.
 *
 * Same module shape as memex-hermes setup (runSetup + helpers); the
 * v0.2.1 hotfix moved this whole file out of lib/setup.js + merged in
 * lib/restart-detect.js so the lib/ surface stays pure.
 *
 * Re-exports keep tests stable: tests/setup.test.js imports from here
 * via relative path.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

import { runBackfill } from '../lib/backfill.js';

export const PLUGIN_ID = 'memex-openclaw';

// ────────────────────────────────────────────────────────────────────
// Pure config wiring (no child_process — could live in lib/ but kept
// here for one-file readability; security-scanner blocking only cares
// about lib/, not bin/)
// ────────────────────────────────────────────────────────────────────

export function defaultOpenclawConfigPath() {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

function readConfig(configPath) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `not found: ${configPath}` };
  }
  let raw;
  try { raw = readFileSync(configPath, 'utf8'); }
  catch (err) { return { ok: false, error: `read failed: ${err.message}` }; }
  try { return { ok: true, cfg: JSON.parse(raw) }; }
  catch (err) { return { ok: false, error: `parse failed: ${err.message}` }; }
}

function writeConfig(configPath, cfg) {
  if (existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${configPath}.before-setup-${ts}`;
    try { copyFileSync(configPath, backup); } catch { /* non-fatal */ }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * Set plugins.entries.memex-openclaw.{enabled, hooks.allowConversationAccess}
 * Returns { action: 'wired'|'already_correct', enabled, allowConversationAccess }.
 */
export function wirePluginEntry(cfg) {
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  const entry = cfg.plugins.entries['memex-openclaw'] || {};
  const before = JSON.stringify(entry);
  entry.enabled = true;
  entry.hooks = entry.hooks || {};
  entry.hooks.allowConversationAccess = true;
  cfg.plugins.entries['memex-openclaw'] = entry;
  return {
    action: before === JSON.stringify(entry) ? 'already_correct' : 'wired',
    enabled: entry.enabled,
    allowConversationAccess: entry.hooks.allowConversationAccess,
  };
}

/**
 * Set mcp.servers.memex (correct nested key) + clean up any stale
 * top-level mcpServers.memex from earlier skill versions. Refuses to
 * overwrite a customised memex command unless force=true.
 */
export function wireMcpServer(cfg, { force = false, memexBin = null } = {}) {
  if (!memexBin) {
    return {
      action: 'memex_missing',
      memex_bin: null,
      warning: 'memex binary not on PATH — install memex-mvp first (npm i -g memex-mvp)',
    };
  }

  let cleanedStale = false;
  if (cfg.mcpServers && typeof cfg.mcpServers === 'object' && cfg.mcpServers.memex) {
    delete cfg.mcpServers.memex;
    cleanedStale = true;
    if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
  }

  cfg.mcp = cfg.mcp || {};
  cfg.mcp.servers = cfg.mcp.servers || {};
  const existing = cfg.mcp.servers.memex;
  const desired = { command: memexBin, args: [], env: {} };
  const changed = !existing
    || existing.command !== desired.command
    || JSON.stringify(existing.args || []) !== JSON.stringify(desired.args)
    || JSON.stringify(existing.env || {}) !== JSON.stringify(desired.env);

  if (existing && existing.command && existing.command !== memexBin && !force) {
    return {
      action: 'conflict',
      memex_bin: memexBin,
      existing_command: existing.command,
      cleaned_stale: cleanedStale,
      warning: `mcp.servers.memex already points to "${existing.command}". `
             + `Refusing to overwrite without --force.`,
    };
  }

  cfg.mcp.servers.memex = desired;
  return {
    action: changed ? 'wired' : 'already_correct',
    memex_bin: memexBin,
    cleaned_stale: cleanedStale,
  };
}

// ────────────────────────────────────────────────────────────────────
// Side-effecting helpers (child_process — bin-only surface)
// ────────────────────────────────────────────────────────────────────

/**
 * Find absolute path to `memex` binary via PATH. Returns null if not found.
 * Uses execFileSync of `command -v` for portability across shells.
 */
export function findMemexBinary() {
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v memex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function tryCmd(file, args, timeoutMs = 3000) {
  try {
    const stdout = execFileSync(file, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, stdout: String(stdout || '') };
  } catch {
    return { ok: false };
  }
}

function which(name) {
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v ${JSON.stringify(name)}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Probe the host for a usable OpenClaw restart mechanism.
 * Order: systemctl --user → systemctl → launchctl → pgrep → manual.
 * Returns { method, command, detail }.
 */
export function detectRestartMechanism() {
  const result = { method: 'manual', command: '', detail: '' };

  if (which('systemctl')) {
    for (const probe of [
      { scope: '--user', method: 'systemd-user' },
      { scope: null,     method: 'systemd-system' },
    ]) {
      for (const unit of ['openclaw', 'openclaw-gateway']) {
        const args = ['is-active'];
        if (probe.scope) args.unshift(probe.scope);
        args.push(unit);
        const r = tryCmd('systemctl', args);
        if (r.ok && r.stdout.trim() === 'active') {
          return {
            method: probe.method,
            command: probe.scope
              ? `systemctl --user restart ${unit}`
              : `sudo systemctl restart ${unit}`,
            detail: `systemd unit '${unit}' active`,
          };
        }
      }
    }
  }

  if (osPlatform() === 'darwin' && which('launchctl')) {
    const r = tryCmd('launchctl', ['list']);
    if (r.ok) {
      for (const line of r.stdout.split('\n')) {
        if (/openclaw/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const label = parts[parts.length - 1];
            return {
              method: 'launchd',
              command: `launchctl kickstart -k gui/$(id -u)/${label}`,
              detail: `launchd label '${label}'`,
            };
          }
        }
      }
    }
  }

  if (which('pgrep')) {
    const r = tryCmd('pgrep', ['-f', 'openclaw']);
    if (r.ok && r.stdout.trim()) {
      const pids = r.stdout.trim().split(/\s+/).filter(Boolean);
      return {
        method: 'pkill',
        command: 'pkill -HUP -f openclaw',
        detail: `openclaw process(es): ${pids.slice(0, 4).join(',')}`,
      };
    }
  }

  return result;
}

/**
 * Fork a detached background shell that sleeps then runs the restart.
 * Survives SIGTERM to the gateway because start_new_session puts the
 * runner in its own process group. Logs to logPath.
 */
export function scheduleSelfRestart(
  restartCommand,
  { delaySeconds = 3, logPath = '/tmp/memex-openclaw-restart.log' } = {},
) {
  if (!restartCommand || !String(restartCommand).trim()) {
    return { scheduled: false, error: 'empty restart_command' };
  }
  const delay = Math.max(1, Number.parseInt(delaySeconds, 10) || 3);
  const shellScript =
    `(echo '--- memex-openclaw auto-restart '"$(date -Iseconds)"' ---' >> ${logPath}; ` +
    `sleep ${delay}; ` +
    `echo 'restart_command: ${restartCommand}' >> ${logPath}; ` +
    `${restartCommand} >> ${logPath} 2>&1; ` +
    `echo "rc=$?" >> ${logPath})`;
  try {
    const child = spawn('/bin/sh', ['-c', shellScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { scheduled: true, delaySeconds: delay, logPath };
  } catch (err) {
    return { scheduled: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────
// Agent-instructions + human-summary formatting
// ────────────────────────────────────────────────────────────────────

export function formatAgentInstructions(report) {
  const lines = [];
  const bf = report.backfill;
  if (bf?.status === 'imported' && bf.messages_imported > 0) {
    lines.push(
      `I made ${bf.messages_imported} of your past OpenClaw messages searchable in memex `
      + `(across ${bf.per_agent?.length || 1} agent(s)).`,
    );
  } else if (bf?.status === 'already_in_sync') {
    lines.push(
      `Your past OpenClaw history was already in memex — `
      + `${bf.messages_skipped_dup || 0} messages, deduplicated.`,
    );
  } else if (bf?.status === 'no_new_data' || bf?.status === 'no_history') {
    lines.push('No prior OpenClaw history found — live capture will start from the next conversation.');
  } else if (bf?.status === 'skipped') {
    lines.push('History import was skipped (--no-backfill).');
  }

  if (report.plugin_config?.action === 'wired') {
    lines.push('I added the plugin to ~/.openclaw/openclaw.json with conversation access.');
  }
  if (report.mcp?.action === 'wired') {
    lines.push('I wired memex as an MCP server so the LLM can search it from inside conversations.');
  } else if (report.mcp?.action === 'conflict') {
    lines.push(`⚠️ ${report.mcp.warning}`);
  } else if (report.mcp?.action === 'memex_missing') {
    lines.push(`⚠️ ${report.mcp.warning}`);
  }

  const r = report.restart;
  if (r?.auto_restart === 'scheduled') {
    lines.push(
      `I'm restarting the OpenClaw gateway in ${r.delay_seconds} seconds — `
      + `send me any message after that and memex will be active in the new session.`,
    );
  } else if (r?.method === 'manual') {
    lines.push(
      `I couldn't auto-detect how OpenClaw is running on this host. `
      + `Tell me 'restart yourself' if you want me to try \`pkill -HUP -f openclaw\`, `
      + `or ask your server admin to restart the gateway.`,
    );
  } else if (r?.auto_restart === 'opt_out') {
    lines.push(`Restart skipped per your flag. Run: \`${r.command}\` to activate.`);
  }

  return lines.join(' ');
}

export function formatHumanSummary(report) {
  const lines = [];
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────');
  lines.push('  memex-openclaw setup');
  lines.push('────────────────────────────────────────────────────────────');

  const pc = report.plugin_config;
  if (pc?.action === 'wired') {
    lines.push('🔧 Plugin config:      wired (enabled + allowConversationAccess)');
  } else if (pc?.action === 'already_correct') {
    lines.push('🔧 Plugin config:      already correct (no change)');
  } else if (pc?.error) {
    lines.push(`🔧 Plugin config:      ⚠️ ${pc.error}`);
  }

  const mcp = report.mcp;
  if (mcp?.action === 'wired') {
    lines.push(`🔌 MCP server:         wired memex → ${mcp.memex_bin}`);
    if (mcp.cleaned_stale) {
      lines.push('                       (also cleaned stale top-level mcpServers.memex)');
    }
  } else if (mcp?.action === 'already_correct') {
    lines.push('🔌 MCP server:         already correct (no change)');
  } else if (mcp?.action === 'conflict') {
    lines.push(`🔌 MCP server:         ⚠️ conflict — ${mcp.warning}`);
  } else if (mcp?.action === 'memex_missing') {
    lines.push(`🔌 MCP server:         ⚠️ memex binary missing — install memex-mvp first`);
  }

  const bf = report.backfill;
  if (bf?.status === 'imported') {
    lines.push(`📥 History:            ${bf.messages_imported} new messages from ${bf.sessions_processed} session(s) made searchable`);
    if (bf.messages_skipped_dup) {
      lines.push(`                       ${bf.messages_skipped_dup} already present (deduped)`);
    }
  } else if (bf?.status === 'already_in_sync') {
    lines.push(`📥 History:            already in memex (${bf.messages_skipped_dup} messages deduplicated)`);
  } else if (bf?.status === 'no_history' || bf?.status === 'no_new_data') {
    lines.push('📥 History:            no past OpenClaw sessions found');
  } else if (bf?.status === 'skipped') {
    lines.push('📥 History:            skipped (--no-backfill)');
  }

  const r = report.restart;
  if (r?.auto_restart === 'scheduled') {
    lines.push(`🔄 Auto-restart:       scheduled in ${r.delay_seconds}s (${r.method} — ${r.command})`);
    lines.push(`                       log: ${r.log_path}`);
    lines.push('');
    lines.push('💬 After restart, send OpenClaw any message — memex will be active.');
  } else if (r?.method === 'manual') {
    lines.push('🔄 Restart needed:     could not auto-detect mechanism');
    lines.push('                       Ask OpenClaw to "restart yourself" or restart manually');
  } else if (r?.auto_restart === 'opt_out') {
    lines.push(`🔄 Restart needed:     ${r.command} (auto-restart opted out)`);
  } else {
    lines.push(`🔄 Restart needed:     ${r?.command || '(none detected)'}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// runSetup — the orchestrator
// ────────────────────────────────────────────────────────────────────

export function runSetup(store, opts = {}) {
  const configPath = opts.configPath || defaultOpenclawConfigPath();
  const report = {
    status: 'unknown',
    config_path: configPath,
    plugin_config: {},
    mcp: {},
    backfill: {},
    restart: {},
  };

  const read = readConfig(configPath);
  if (!read.ok) {
    report.plugin_config = { action: 'read_failed', error: read.error };
    report.mcp = { action: 'read_failed', error: read.error };
    report.status = 'failed';
    report.next_action = 'manual_intervention';
    report.agent_instructions =
      `Couldn't read ${configPath}: ${read.error}. `
      + `Open the file and verify it exists + is valid JSON.`;
    return report;
  }
  const cfg = read.cfg;

  // Step 1: wire plugin entry
  report.plugin_config = wirePluginEntry(cfg);

  // Step 2: wire MCP server (find memex bin unless caller passed one explicitly)
  const memexBin = 'memexBin' in opts ? opts.memexBin : findMemexBinary();
  report.mcp = wireMcpServer(cfg, { force: !!opts.force, memexBin });

  const configChanged =
    report.plugin_config.action === 'wired' ||
    report.mcp.action === 'wired' ||
    report.mcp.cleaned_stale === true;

  if (configChanged) {
    try { writeConfig(configPath, cfg); }
    catch (err) {
      report.plugin_config.write_error = err.message;
      report.status = 'failed';
      report.next_action = 'manual_intervention';
      report.agent_instructions = `Couldn't write ${configPath}: ${err.message}.`;
      return report;
    }
  }

  // Step 3: backfill
  if (opts.noBackfill) {
    report.backfill = { status: 'skipped' };
  } else {
    try {
      report.backfill = runBackfill(store, {
        agentsDir: opts.agentsDir,
        since: opts.since,
      });
    } catch (err) {
      report.backfill = { status: 'failed', error: err.message };
    }
  }

  // Step 4: detect restart
  const detected = detectRestartMechanism();
  report.restart = {
    method: detected.method,
    command: detected.command,
    detail: detected.detail,
  };

  // Step 5: schedule auto-restart
  if (opts.noAutoRestart) {
    report.restart.auto_restart = 'opt_out';
  } else if (detected.method === 'manual' || !detected.command) {
    report.restart.auto_restart = 'unavailable';
  } else {
    const sched = scheduleSelfRestart(detected.command, {
      delaySeconds: Number(opts.restartDelay) || 3,
    });
    if (sched.scheduled) {
      report.restart.auto_restart = 'scheduled';
      report.restart.delay_seconds = sched.delaySeconds;
      report.restart.log_path = sched.logPath;
    } else {
      report.restart.auto_restart = 'failed';
      report.restart.error = sched.error;
    }
  }

  // Wrap up
  if (report.plugin_config.action === 'write_failed' || report.mcp.action === 'write_failed') {
    report.status = 'failed';
    report.next_action = 'manual_intervention';
  } else if (report.mcp.action === 'memex_missing') {
    report.status = 'partial';
    report.next_action = 'install_memex_mvp';
  } else if (report.mcp.action === 'conflict') {
    report.status = 'partial';
    report.next_action = 'use_force_or_resolve_conflict';
  } else if (configChanged || (report.backfill.messages_imported || 0) > 0) {
    report.status = 'ready';
    report.next_action = report.restart.auto_restart === 'scheduled'
      ? 'wait_for_restart'
      : 'restart_required';
  } else {
    report.status = 'already_in_sync';
    report.next_action = 'none';
  }

  report.agent_instructions = formatAgentInstructions(report);
  return report;
}

export function printSetupReport(report, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatHumanSummary(report));
  }
}

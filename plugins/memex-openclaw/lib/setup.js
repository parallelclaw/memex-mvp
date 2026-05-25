/**
 * One-shot setup orchestrator for memex-openclaw v0.2.0.
 *
 * Composes the manual install steps (which install-memex-claw v2.0.2
 * spelled out across seven sections) into one function callable
 * either via the OpenClaw plugin CLI (`openclaw memex-openclaw setup`)
 * or via the standalone npm bin fallback (`memex-openclaw-setup`).
 *
 * Pipeline (each step idempotent, each surfaces its own diff in the
 * structured return value):
 *
 *   1. Wire plugin config in ~/.openclaw/openclaw.json
 *      - plugins.entries.memex-openclaw.enabled = true
 *      - plugins.entries.memex-openclaw.hooks.allowConversationAccess
 *        = true   (Bug 6 fix — without this, agent_end hook is BLOCKED
 *        by the gateway and capture silently doesn't write)
 *   2. Wire MCP server at the correct nested key
 *      - mcp.servers.memex = { command: which memex, args: [], env: {} }
 *      - cleans up stale cfg.mcpServers.memex from pre-v2.0.2 skill versions
 *   3. Backfill OpenClaw session history into memex.db
 *      - skipped if --no-backfill
 *      - watermarked per-agent so re-runs are O(0)
 *   4. Detect restart mechanism (systemd / launchd / pkill / manual)
 *   5. Schedule a delayed self-restart unless --no-auto-restart
 *
 * Output is structured JSON when `json: true`, designed for an LLM
 * agent that drove the install (e.g. user pasted the lazy-install
 * prompt into OpenClaw and OpenClaw is now running this on the user's
 * behalf). Fields like `next_action`, `restart.auto_restart`,
 * `agent_instructions` let the agent reason about a re-run and
 * formulate the right user-facing reply.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runBackfill } from './backfill.js';
import { detectRestartMechanism, scheduleSelfRestart } from './restart-detect.js';

/**
 * Default path to OpenClaw's gateway config.
 */
export function defaultOpenclawConfigPath() {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

/**
 * Locate `memex` binary on PATH for the MCP server registration.
 * Returns absolute path or null.
 */
function findMemexBinary() {
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v memex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const p = out.trim();
    return p || null;
  } catch {
    return null;
  }
}

/**
 * Read + parse openclaw.json safely. Returns {ok, cfg, error}.
 */
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

/**
 * Write config back with a one-time .before-<ts> backup. Idempotent
 * in the sense that re-writes overwrite the same destination; the
 * backup file uses a timestamp so multiple setup runs each leave a
 * trace.
 */
function writeConfig(configPath, cfg) {
  // Defensive backup (cheap, helps users undo a wrong --force)
  if (existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${configPath}.before-setup-${ts}`;
    try { copyFileSync(configPath, backup); } catch { /* non-fatal */ }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * Step 1 — ensure plugins.entries.memex-openclaw is wired with BOTH
 * enabled=true AND hooks.allowConversationAccess=true.
 *
 * Returns one of:
 *   action='already_correct'  — no change needed
 *   action='wired'            — set one or both fields
 *   action='write_failed'     — IO error
 */
function wirePluginEntry(cfg) {
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  const entry = cfg.plugins.entries['memex-openclaw'] || {};

  const before = JSON.stringify(entry);
  entry.enabled = true;
  entry.hooks = entry.hooks || {};
  entry.hooks.allowConversationAccess = true;
  cfg.plugins.entries['memex-openclaw'] = entry;
  const after = JSON.stringify(entry);

  return {
    action: before === after ? 'already_correct' : 'wired',
    enabled: entry.enabled,
    allowConversationAccess: entry.hooks.allowConversationAccess,
  };
}

/**
 * Step 2 — wire mcp.servers.memex (correct nested key) and clean up
 * any stale cfg.mcpServers.memex left by pre-v2.0.2 skill versions.
 *
 * Returns:
 *   action='already_correct' | 'wired' | 'conflict' | 'memex_missing'
 *   memex_bin: absolute path of memex binary (or null)
 *   cleaned_stale: bool — true if stale flat-key entry was deleted
 */
function wireMcpServer(cfg, { force = false, explicitMemexBin = null } = {}) {
  const memexBin = explicitMemexBin || findMemexBinary();
  if (!memexBin) {
    return {
      action: 'memex_missing',
      memex_bin: null,
      warning: 'memex binary not on PATH — install memex-mvp first (npm i -g memex-mvp)',
    };
  }

  // Clean up legacy top-level mcpServers.memex (from skill v2.0.0/2.0.1)
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
    // Don't silently overwrite a user's custom memex path.
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

/**
 * Format the agent_instructions string — the pre-cooked English the
 * LLM should relay to the user. Adapts to which steps actually
 * produced changes vs were no-ops, and to whether the restart was
 * scheduled or punted to manual.
 */
function formatAgentInstructions(report) {
  const lines = [];

  // History
  const bf = report.backfill;
  if (bf?.status === 'imported' && bf.messages_imported > 0) {
    lines.push(
      `I made ${bf.messages_imported} of your past OpenClaw messages `
      + `searchable in memex (across ${bf.per_agent?.length || 1} agent(s)).`,
    );
  } else if (bf?.status === 'already_in_sync') {
    lines.push(
      `Your past OpenClaw history was already in memex — `
      + `${bf.messages_skipped_dup || 0} messages, deduplicated.`,
    );
  } else if (bf?.status === 'no_new_data' || bf?.status === 'no_history') {
    lines.push(
      `No prior OpenClaw history found — live capture will start from the next conversation.`,
    );
  } else if (bf?.status === 'skipped') {
    lines.push('History import was skipped (--no-backfill).');
  }

  // Config
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

  // Restart
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

/**
 * Build the human-readable summary printed when --json is NOT set.
 * Compact, terminal-friendly, uses simple Unicode markers (no boxes
 * because OpenClaw's CLI may wrap lines).
 */
function formatHumanSummary(report) {
  const lines = [];
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────');
  lines.push('  memex-openclaw setup');
  lines.push('────────────────────────────────────────────────────────────');

  // Plugin config
  const pc = report.plugin_config;
  if (pc?.action === 'wired') {
    lines.push('🔧 Plugin config:      wired (enabled + allowConversationAccess)');
  } else if (pc?.action === 'already_correct') {
    lines.push('🔧 Plugin config:      already correct (no change)');
  } else if (pc?.action === 'write_failed') {
    lines.push(`🔧 Plugin config:      ⚠️ ${pc.error}`);
  }

  // MCP
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

  // Backfill
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

  // Restart
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

/**
 * Top-level orchestrator. Takes a MemexStore (already opened by the
 * plugin runtime or by the standalone bin) and a flat opts object.
 *
 * opts:
 *   configPath:       override ~/.openclaw/openclaw.json
 *   noBackfill:       skip history import (default false)
 *   noAutoRestart:    don't trigger self-restart (default false)
 *   force:            overwrite conflicting mcp.servers.memex
 *   restartDelay:     seconds to wait before restart (default 3)
 *   memexBin:         override `which memex` lookup
 *   agentsDir:        override default ~/.openclaw/agents/
 *   since:            YYYY-MM-DD cutoff for backfill
 *   json:             return result instead of printing humans summary
 *
 * Returns a structured object (see README) regardless of json flag —
 * the CLI layer decides whether to print human or JSON.
 */
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

  // ----- Step 1 + 2: edit config -----
  const read = readConfig(configPath);
  if (!read.ok) {
    report.plugin_config = { action: 'read_failed', error: read.error };
    report.mcp = { action: 'read_failed', error: read.error };
    report.status = 'failed';
    report.next_action = 'manual_intervention';
    report.agent_instructions = `Couldn't read ${configPath}: ${read.error}. `
      + `Open the file and verify it exists + is valid JSON.`;
    return report;
  }
  const cfg = read.cfg;

  report.plugin_config = wirePluginEntry(cfg);
  report.mcp = wireMcpServer(cfg, {
    force: !!opts.force,
    explicitMemexBin: opts.memexBin,
  });

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

  // ----- Step 3: backfill -----
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

  // ----- Step 4: detect restart -----
  const detected = detectRestartMechanism();
  report.restart = {
    method: detected.method,
    command: detected.command,
    detail: detected.detail,
  };

  // ----- Step 5: schedule auto-restart -----
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

  // ----- Wrap up: overall status + next_action -----
  if (report.plugin_config.action === 'write_failed' || report.mcp.action === 'write_failed') {
    report.status = 'failed';
    report.next_action = 'manual_intervention';
  } else if (report.mcp.action === 'memex_missing') {
    report.status = 'partial';
    report.next_action = 'install_memex_mvp';
  } else if (report.mcp.action === 'conflict') {
    report.status = 'partial';
    report.next_action = 'use_force_or_resolve_conflict';
  } else if (configChanged || report.backfill.messages_imported > 0) {
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

/**
 * Convenience for the CLI layer: print either JSON or human summary
 * based on opts.json. Returns nothing.
 */
export function printSetupReport(report, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatHumanSummary(report));
  }
}

/**
 * Restart-mechanism detector + delayed self-restart scheduler.
 *
 * Direct port of memex-hermes's detect_restart_mechanism +
 * schedule_self_restart (Python → Node), adapted for OpenClaw:
 *   - Target unit name is 'openclaw' (with 'openclaw-gateway' fallback)
 *     instead of 'hermes' / 'hermes-agent'
 *   - pkill pattern matches the actual OpenClaw process command line
 *
 * Why these specific four probes, in this order, was relitigated when
 * we shipped Hermes v0.2.0 — see that release for the rationale:
 *
 *   1. systemctl --user is-active   (typical user-installed Linux service)
 *   2. systemctl is-active          (system-wide install on shared VPS)
 *   3. launchctl list | grep        (macOS workstation)
 *   4. pgrep -f openclaw            (manual / screen / tmux / Docker —
 *                                    we have a PID, can HUP it)
 *
 * If none of those find anything the user is on an unusual setup
 * (something we don't recognize), we surface 'manual' so the caller
 * can ask the LLM agent driving the install to relay "you'll need to
 * restart OpenClaw yourself" to the human — same flow as Hermes.
 *
 * Note on OpenClaw 2026.5.x: this version doesn't support the docs'
 * `reload: hybrid` global setting, so schedule-and-die is the only
 * automation path. If a future OpenClaw exposes a hybrid reload, the
 * setup orchestrator should prefer that (cleaner) — this module
 * becomes a fallback.
 */

import { execFileSync, spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

/**
 * Try one external command with a strict timeout. Returns
 *   { ok: true, stdout: '...' }  on rc=0
 *   { ok: false }                 on rc!=0 or error
 * Never throws.
 */
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

/**
 * Check whether a given binary is callable (effectively `command -v`
 * without spawning a full shell).
 */
function which(name) {
  // execFileSync of `command -v` is the most portable cross-distro
  // check. The shell fallback handles macOS / bash / zsh equivalently.
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
 * Returns { method, command, detail } — method is the family;
 * command is the exact shell command to invoke; detail describes
 * what we found (unit name, label, pids).
 */
export function detectRestartMechanism() {
  const result = { method: 'manual', command: '', detail: '' };

  // 1 + 2: systemd (user + system)
  if (which('systemctl')) {
    const probes = [
      { scope: '--user', method: 'systemd-user' },
      { scope: null,     method: 'systemd-system' },
    ];
    for (const probe of probes) {
      for (const unit of ['openclaw', 'openclaw-gateway']) {
        const args = ['is-active'];
        if (probe.scope) args.unshift(probe.scope);
        args.push(unit);
        const r = tryCmd('systemctl', args);
        if (r.ok && r.stdout.trim() === 'active') {
          const cmd = probe.scope
            ? `systemctl --user restart ${unit}`
            : `sudo systemctl restart ${unit}`;
          return {
            method: probe.method,
            command: cmd,
            detail: `systemd unit '${unit}' active`,
          };
        }
      }
    }
  }

  // 3: launchd on macOS
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

  // 4: pgrep fallback (manual / screen / tmux / Docker — we found
  // a live process, can deliver HUP)
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
 *
 * `start_new_session=True` (spawn detached + unref) puts the child in
 * its own process group so it survives the SIGTERM the restart
 * delivers to the gateway. Logs go to logPath so a failed restart can
 * be diagnosed.
 *
 * Returns { scheduled, delaySeconds, logPath } on success
 * or { scheduled: false, error } on failure.
 *
 * Empty restartCommand → returns scheduled=false without spawning.
 * This makes it safe to call when detectRestartMechanism() returned
 * 'manual' — the caller can blindly call schedule and check the flag.
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
    return {
      scheduled: true,
      delaySeconds: delay,
      logPath,
    };
  } catch (err) {
    return { scheduled: false, error: err.message };
  }
}

/**
 * v0.13 sync-join durability units — tunnel keeper + watchdog builders.
 *
 * Tests the PURE builders only (no launchctl/systemctl), asserting the
 * invariants the self-healing design depends on — each one traces back to a
 * real failure from the live mesh bring-up:
 *   - ssh runs FOREGROUND (-N, no -f) so the OS supervisor owns the lifecycle
 *   - ExitOnForwardFailure → a failed -L bind exits (→ respawn), never a
 *     silent no-op tunnel
 *   - ServerAlive 30×3 → dead peer noticed in ~90s
 *   - explicit IPv4 loopback on BOTH sides of -L (a bare port once bound
 *     ::1-only and produced a tunnel nobody dialed)
 *   - KeepAlive (launchd) / Restart=always (systemd) → self-heal
 *   - watchdog runs `sync-watchdog` on an hourly interval with env injected
 *
 * Run: node test/sync/tunnel-service.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'memex-tun-'));
process.env.MEMEX_DIR = TMP;

const {
  buildTunnelScript,
  buildTunnelLaunchAgentPlist,
  buildTunnelSystemdUnit,
  buildWatchdogLaunchAgentPlist,
  buildWatchdogSystemdService,
  buildWatchdogSystemdTimer,
  SERVICE_PATHS,
} = await import('../../lib/sync/service.js');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('tunnel keeper script:');
const script = buildTunnelScript({ sshTarget: 'openclaw@203.0.113.7', localPort: 8770, remotePort: 8766 });

t('runs ssh in the foreground (-N, never -f) — supervisor owns the lifecycle', () => {
  assert.match(script, /exec ssh -N/);
  assert.doesNotMatch(script, /ssh .*-f\b/);
});
t('forward -L with explicit IPv4 loopback on both sides', () => {
  assert.match(script, /-L 127\.0\.0\.1:8770:127\.0\.0\.1:8766/);
});
t('ExitOnForwardFailure — failed bind exits instead of silent no-op', () => {
  assert.match(script, /ExitOnForwardFailure=yes/);
});
t('ServerAlive 30×3 — dead peer noticed within ~90s', () => {
  assert.match(script, /ServerAliveInterval=30/);
  assert.match(script, /ServerAliveCountMax=3/);
});
t('BatchMode — never hangs on an interactive prompt', () => {
  assert.match(script, /BatchMode=yes/);
});
t('optional identity file flag', () => {
  const s = buildTunnelScript({ sshTarget: 'u@h', localPort: 1, remotePort: 2, identity: '/home/u/.ssh/id_ed25519' });
  assert.match(s, /-i "\/home\/u\/\.ssh\/id_ed25519" -o IdentitiesOnly=yes/);
  assert.doesNotMatch(script, /IdentitiesOnly/);
});

console.log('tunnel launchd plist:');
const plist = buildTunnelLaunchAgentPlist();
t('KeepAlive + RunAtLoad + ThrottleInterval — self-heal with backoff', () => {
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>15<\/integer>/);
});
t('distinct synctunnel label', () => {
  assert.match(plist, /com\.parallelclaw\.memex\.synctunnel/);
  assert.equal(SERVICE_PATHS.TUNNEL_MAC_LABEL, 'com.parallelclaw.memex.synctunnel');
});

console.log('tunnel systemd unit:');
const unit = buildTunnelSystemdUnit();
t('Restart=always + RestartSec — self-heal on any exit', () => {
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=15/);
});
t('waits for network-online', () => {
  assert.match(unit, /After=network-online\.target/);
});

console.log('watchdog units:');
const wdPlist = buildWatchdogLaunchAgentPlist({ script: '/x/ingest.js', mins: 60, nodePath: '/usr/bin/node' });
t('launchd: hourly StartInterval running sync-watchdog with env injected', () => {
  assert.match(wdPlist, /<key>StartInterval<\/key><integer>3600<\/integer>/);
  assert.match(wdPlist, /<string>sync-watchdog<\/string>/);
  assert.match(wdPlist, /<key>MEMEX_SYNC_EXPERIMENTAL<\/key><string>1<\/string>/);
  assert.match(wdPlist, /com\.parallelclaw\.memex\.syncwatchdog/);
});
t('systemd: oneshot service + hourly persistent timer', () => {
  const svc = buildWatchdogSystemdService({ script: '/x/ingest.js', nodePath: '/usr/bin/node' });
  assert.match(svc, /Type=oneshot/);
  assert.match(svc, /ExecStart=\/usr\/bin\/node \/x\/ingest\.js sync-watchdog/);
  const timer = buildWatchdogSystemdTimer({ mins: 60 });
  assert.match(timer, /OnUnitActiveSec=60min/);
  assert.match(timer, /Persistent=true/);
});
t('all four sync unit labels are distinct (server/schedule/tunnel/watchdog)', () => {
  const labels = [
    SERVICE_PATHS.MAC_LABEL, SERVICE_PATHS.SCHED_MAC_LABEL,
    SERVICE_PATHS.TUNNEL_MAC_LABEL, SERVICE_PATHS.WD_MAC_LABEL,
  ];
  assert.equal(new Set(labels).size, 4, `labels collide: ${labels.join(', ')}`);
});

rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? '\nTunnel/watchdog unit checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

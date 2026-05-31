/**
 * Phase 2 test: sync-server service unit generation.
 *
 * Tests the PURE builders (plist / systemd unit content) without touching
 * launchctl or systemctl — asserting the critical invariants:
 *   - MEMEX_SYNC_EXPERIMENTAL=1 is injected (else the server refuses to start)
 *   - ExecStart / ProgramArguments carry `sync-server start --port --bind`
 *   - restart-on-failure policy present (systemd)
 *   - KeepAlive present (launchd)
 *
 * Plus syncServerServiceStatus() returns installed:false in a clean env.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'memex-svc-'));
process.env.MEMEX_DIR = TMP;

const {
  buildLaunchAgentPlist,
  buildSystemdUnit,
  syncServerServiceStatus,
  SERVICE_PATHS,
  buildScheduleSystemdTimer,
  buildScheduleSystemdService,
  buildScheduleLaunchAgentPlist,
  syncScheduleStatus,
} = await import('../../lib/sync/service.js');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const opts = {
  script: '/home/openclaw/memex-tracer/ingest.js',
  port: 8766,
  bind: '0.0.0.0',
  nodePath: '/usr/bin/node',
};

console.log('systemd unit builder:');
const unit = buildSystemdUnit(opts);

t('injects MEMEX_SYNC_EXPERIMENTAL=1', () => {
  assert.match(unit, /Environment=MEMEX_SYNC_EXPERIMENTAL=1/);
});
t('ExecStart runs sync-server start with port+bind', () => {
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/home\/openclaw\/memex-tracer\/ingest\.js sync-server start --port 8766 --bind 0\.0\.0\.0/);
});
t('has Restart=on-failure', () => {
  assert.match(unit, /Restart=on-failure/);
});
t('enabled at default.target (survives reboot)', () => {
  assert.match(unit, /WantedBy=default\.target/);
});
t('logs to sync-server.out/err.log', () => {
  assert.match(unit, /sync-server\.out\.log/);
  assert.match(unit, /sync-server\.err\.log/);
});

console.log('launchd plist builder:');
const plist = buildLaunchAgentPlist(opts);

t('injects MEMEX_SYNC_EXPERIMENTAL=1 env', () => {
  assert.match(plist, /<key>MEMEX_SYNC_EXPERIMENTAL<\/key><string>1<\/string>/);
});
t('ProgramArguments carry sync-server start --port --bind', () => {
  assert.match(plist, /<string>sync-server<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<string>--port<\/string>\s*<string>8766<\/string>/);
  assert.match(plist, /<string>--bind<\/string>\s*<string>0\.0\.0\.0<\/string>/);
});
t('KeepAlive + RunAtLoad (survives reboot + crash)', () => {
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
});
t('uses the distinct syncserver label (not the capture daemon)', () => {
  assert.match(plist, /com\.parallelclaw\.memex\.syncserver/);
  assert.equal(SERVICE_PATHS.MAC_LABEL, 'com.parallelclaw.memex.syncserver');
});

console.log('status (clean env):');
t('reports installed:false when no unit exists', () => {
  const st = syncServerServiceStatus();
  assert.equal(st.installed, false);
  assert.equal(st.running, false);
  assert.ok(['launchd', 'systemd-user', 'none'].includes(st.manager));
});

t('omits port/bind flags when not provided', () => {
  const u = buildSystemdUnit({ script: '/x/ingest.js', nodePath: 'node' });
  assert.match(u, /ExecStart=node \/x\/ingest\.js sync-server start$/m);
  assert.doesNotMatch(u, /--port/);
});

console.log('schedule (Phase 3) builders:');

t('systemd timer fires every N minutes + persists missed runs', () => {
  const timer = buildScheduleSystemdTimer({ mins: 15 });
  assert.match(timer, /OnUnitActiveSec=15min/);
  assert.match(timer, /Persistent=true/);          // catch up after sleep/off
  assert.match(timer, /WantedBy=timers\.target/);
});

t('systemd schedule service is oneshot running sync-run --all', () => {
  const svc = buildScheduleSystemdService({ script: '/h/ingest.js', nodePath: '/usr/bin/node' });
  assert.match(svc, /Type=oneshot/);
  assert.match(svc, /ExecStart=\/usr\/bin\/node \/h\/ingest\.js sync-run --all/);
  assert.match(svc, /Environment=MEMEX_SYNC_EXPERIMENTAL=1/);
});

t('launchd schedule uses StartInterval (not KeepAlive) + sync-run --all', () => {
  const plist = buildScheduleLaunchAgentPlist({ script: '/h/ingest.js', mins: 15, nodePath: '/usr/bin/node' });
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/); // 15*60
  assert.doesNotMatch(plist, /KeepAlive/);  // one-shot re-run, not long-lived
  assert.match(plist, /<string>sync-run<\/string>/);
  assert.match(plist, /<string>--all<\/string>/);
  assert.match(plist, /<key>MEMEX_SYNC_EXPERIMENTAL<\/key><string>1<\/string>/);
  assert.match(plist, /com\.parallelclaw\.memex\.syncschedule/);
});

t('schedule status reports installed:false in clean env', () => {
  const st = syncScheduleStatus();
  assert.equal(st.installed, false);
});

t('schedule label is distinct from server + capture daemon', () => {
  assert.equal(SERVICE_PATHS.SCHED_MAC_LABEL, 'com.parallelclaw.memex.syncschedule');
  assert.notEqual(SERVICE_PATHS.SCHED_MAC_LABEL, SERVICE_PATHS.MAC_LABEL);
});

rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? '\nService unit checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

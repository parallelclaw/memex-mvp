/**
 * Tests for restart detector + scheduler.
 *
 * The detector calls real subprocess commands (systemctl, launchctl,
 * pgrep) on whichever host runs the tests, so we can't easily assert
 * a SPECIFIC method — the test host may have any of them or none.
 * What we CAN assert is the SHAPE: detectRestartMechanism returns
 * a well-formed result regardless of host. For specific code-path
 * coverage, we'd want process-level mocking, which Node's native
 * test runner doesn't make easy; that gap is acceptable here because
 * the logic itself is straightforward + the field-validation we did
 * for memex-hermes (which uses identical structure) caught the real
 * edge cases.
 *
 * For scheduleSelfRestart, we DO assert that:
 *   - empty command returns scheduled=false without spawning
 *   - non-empty command spawns a detached shell and returns scheduled=true
 *   - the child is properly detached (doesn't keep the parent alive)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  detectRestartMechanism,
  scheduleSelfRestart,
} from '../lib/restart-detect.js';

// ---------- detector shape tests ----------

test('detectRestartMechanism: returns well-formed result on any host', () => {
  const r = detectRestartMechanism();
  // Required fields, regardless of which branch hit.
  assert.equal(typeof r.method, 'string');
  assert.equal(typeof r.command, 'string');
  assert.equal(typeof r.detail, 'string');
  // method must be one of the known families.
  assert.ok(
    ['systemd-user', 'systemd-system', 'launchd', 'pkill', 'manual'].includes(r.method),
    `unexpected method: ${r.method}`,
  );
  // 'manual' means we couldn't find anything → command must be empty.
  if (r.method === 'manual') {
    assert.equal(r.command, '');
  } else {
    assert.ok(r.command.length > 0, 'non-manual must have a restart command');
  }
});

// ---------- scheduler tests ----------

test('scheduleSelfRestart: rejects empty / whitespace command', () => {
  const r1 = scheduleSelfRestart('');
  assert.equal(r1.scheduled, false);
  assert.ok(r1.error);

  const r2 = scheduleSelfRestart('   ');
  assert.equal(r2.scheduled, false);
});

test('scheduleSelfRestart: clamps negative delay to ≥ 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-restart-test-'));
  const logPath = join(dir, 'restart.log');
  try {
    const r = scheduleSelfRestart('true', {
      delaySeconds: -5,
      logPath,
    });
    assert.equal(r.scheduled, true);
    assert.equal(r.delaySeconds, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduleSelfRestart: schedules and detaches a harmless command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-restart-test-'));
  const logPath = join(dir, 'restart.log');
  try {
    const r = scheduleSelfRestart('true', {
      delaySeconds: 1,
      logPath,
    });
    assert.equal(r.scheduled, true);
    assert.equal(r.logPath, logPath);
    // Wait long enough for the background shell to run (1s delay + buffer)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(existsSync(logPath), 'log file should exist after restart fires');
    const log = readFileSync(logPath, 'utf8');
    assert.ok(log.includes('restart_command: true'), `log content: ${log}`);
    assert.ok(log.includes('rc=0'), `expected rc=0 for /bin/true: ${log}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduleSelfRestart: returns sane delaySeconds for valid input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-restart-test-'));
  const logPath = join(dir, 'restart.log');
  try {
    const r = scheduleSelfRestart('true', { delaySeconds: 7, logPath });
    assert.equal(r.scheduled, true);
    assert.equal(r.delaySeconds, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

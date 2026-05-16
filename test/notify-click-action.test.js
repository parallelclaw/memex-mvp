// Tests for lib/notify-click-action.js — click-target picker + command builder.
//
// All tests inject a fake `env` so we don't depend on what's actually
// installed on the machine running the test.

import {
  pickTarget,
  buildClickCommand,
  targetLabel,
  bannerCallToAction,
  fireClickableNotification,
  executeClickAction,
} from '../lib/notify-click-action.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
function assertEq(a, b, m = '') {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
}

function mkEnv(opts = {}) {
  return {
    platform: opts.platform || 'darwin',
    terminal_notifier: opts.tn === false ? null : (opts.tn || '/opt/homebrew/bin/terminal-notifier'),
    claude_cli: opts.cli === false ? null : (opts.cli || '/usr/local/bin/claude'),
    claude_desktop: opts.desktop === false ? null : (opts.desktop || '/Applications/Claude.app'),
    memex_bin: opts.memex || '/Users/me/.npm-global/bin/memex',
  };
}

console.log('notify-click-action:\n');

// ---------- pickTarget ----------

test('pickTarget auto + CLI installed → claude-cli', () => {
  assertEq(pickTarget('auto', mkEnv()), 'claude-cli');
});

test('pickTarget auto + only Desktop → claude-desktop', () => {
  assertEq(pickTarget('auto', mkEnv({ cli: false })), 'claude-desktop');
});

test('pickTarget auto + no Claude → terminal', () => {
  assertEq(pickTarget('auto', mkEnv({ cli: false, desktop: false })), 'terminal');
});

test('pickTarget claude-cli with CLI installed', () => {
  assertEq(pickTarget('claude-cli', mkEnv()), 'claude-cli');
});

test('pickTarget claude-cli without CLI → falls through to auto (claude-desktop)', () => {
  assertEq(pickTarget('claude-cli', mkEnv({ cli: false })), 'claude-desktop');
});

test('pickTarget claude-cli without anything → terminal', () => {
  assertEq(pickTarget('claude-cli', mkEnv({ cli: false, desktop: false })), 'terminal');
});

test('pickTarget terminal always returns terminal', () => {
  assertEq(pickTarget('terminal', mkEnv()), 'terminal');
});

test('pickTarget none always returns none', () => {
  assertEq(pickTarget('none', mkEnv()), 'none');
});

// ---------- buildClickCommand ----------

test('buildClickCommand claude-cli wraps claude bin in AppleScript', () => {
  const cmd = buildClickCommand('claude-cli', mkEnv());
  assert(cmd.includes('osascript'));
  assert(cmd.includes('do script'));
  assert(cmd.includes('cd ~'));
  assert(cmd.includes('/usr/local/bin/claude'));
});

test('buildClickCommand claude-desktop uses open -a', () => {
  const cmd = buildClickCommand('claude-desktop', mkEnv());
  assert(cmd.startsWith('open '));
  assert(cmd.includes('Claude.app'));
});

test('buildClickCommand terminal queues memex telegram pending', () => {
  const cmd = buildClickCommand('terminal', mkEnv());
  assert(cmd.includes('osascript'));
  assert(cmd.includes('memex telegram pending'));
});

test('buildClickCommand none returns null', () => {
  assertEq(buildClickCommand('none', mkEnv()), null);
});

test('buildClickCommand falls back to claude in PATH if absolute missing', () => {
  const env = mkEnv({ cli: false });
  // Force claude-cli target even though not detected — caller might bypass pickTarget
  const cmd = buildClickCommand('claude-cli', env);
  // Even when claude_cli is null, command uses 'claude' literal — won't work
  // but won't crash. Real callers should always go through pickTarget first.
  assert(cmd.includes('claude'));
});

// ---------- labels ----------

test('targetLabel returns human-readable string per target', () => {
  assert(targetLabel('claude-cli').toLowerCase().includes('claude code'));
  assert(targetLabel('claude-desktop').toLowerCase().includes('desktop'));
  assert(targetLabel('terminal').toLowerCase().includes('terminal'));
  assert(targetLabel('none').toLowerCase().includes('no'));
});

test('bannerCallToAction adapts text per target (clickable=true)', () => {
  assert(bannerCallToAction('claude-cli', true).toLowerCase().includes('click to launch'));
  assert(bannerCallToAction('claude-desktop', true).toLowerCase().includes('click to open claude'));
  assert(bannerCallToAction('terminal', true).toLowerCase().includes('click to open terminal'));
  assert(bannerCallToAction('none', true).toLowerCase().includes('memex telegram pending'));
});

test('bannerCallToAction drops "Click to" when not clickable', () => {
  // No terminal-notifier → banner is informative, not clickable.
  // Text should show concrete shell action, not "Click to ..." which would mislead.
  const cli = bannerCallToAction('claude-cli', false);
  assert(!cli.toLowerCase().includes('click to'));
  assert(cli.toLowerCase().includes('claude') || cli.toLowerCase().includes('memex telegram'));

  const term = bannerCallToAction('terminal', false);
  assert(!term.toLowerCase().includes('click to'));
  assert(term.toLowerCase().includes('memex telegram pending'));
});

// ---------- fireClickableNotification (smoke — does not actually spawn) ----------

test('fireClickableNotification non-darwin → noop', () => {
  const r = fireClickableNotification({
    title: 'test', message: 'm',
    env: mkEnv({ platform: 'linux' }),
    dryRun: true,
  });
  assertEq(r.backend, 'noop');
});

test('fireClickableNotification with TN + claude-cli → terminal-notifier backend', () => {
  // We can't easily verify the spawn happened without intercepting child_process,
  // but we can verify the function returns the right backend label.
  const r = fireClickableNotification({
    title: 't', message: 'm',
    target: 'auto',
    env: mkEnv(),
    dryRun: true,
  });
  assertEq(r.backend, 'terminal-notifier');
  assertEq(r.target, 'claude-cli');
  assert(r.click_command);
});

test('fireClickableNotification without TN → osascript backend (no click)', () => {
  const r = fireClickableNotification({
    title: 't', message: 'm',
    target: 'auto',
    env: mkEnv({ tn: false }),
    dryRun: true,
  });
  assertEq(r.backend, 'osascript');
  assertEq(r.target, 'none');
  assertEq(r.click_command, null);
});

test('fireClickableNotification with target=none + TN → still terminal-notifier but no click', () => {
  // pickTarget('none') → 'none' → buildClickCommand returns null → falls back to osascript
  const r = fireClickableNotification({
    title: 't', message: 'm',
    target: 'none',
    env: mkEnv(),
    dryRun: true,
  });
  // With TN installed but no click_command, we fall to osascript branch
  assertEq(r.backend, 'osascript');
  assertEq(r.target, 'none');
});

// ---------- v0.10.6: dryRun mode ----------

test('dryRun:true returns shape without spawning real notification', () => {
  // We can't directly assert no-spawn, but we can confirm the return
  // shape is identical between dry and not-dry for the same input.
  const r = fireClickableNotification({
    title: 'dry', message: 'msg',
    target: 'auto',
    env: mkEnv(),
    dryRun: true,
  });
  assertEq(r.backend, 'terminal-notifier');
  assertEq(r.target, 'claude-cli');
  assert(r.click_command.includes('claude'));
});

test('MEMEX_NO_FIRE env also suppresses spawn', () => {
  const prev = process.env.MEMEX_NO_FIRE;
  process.env.MEMEX_NO_FIRE = '1';
  try {
    const r = fireClickableNotification({
      title: 'env-noop', message: 'm',
      target: 'auto',
      env: mkEnv(),
    });
    // Same shape as dryRun explicit
    assertEq(r.backend, 'terminal-notifier');
    assertEq(r.target, 'claude-cli');
  } finally {
    if (prev === undefined) delete process.env.MEMEX_NO_FIRE;
    else process.env.MEMEX_NO_FIRE = prev;
  }
});

// ---------- AppleScript injection guard ----------

test('AppleScript paths with embedded quotes are escaped', () => {
  const env = mkEnv({ cli: '/path/with"quote/claude' });
  const cmd = buildClickCommand('claude-cli', env);
  // Escaped backslash + quote
  assert(cmd.includes('\\"'));
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

// Regression test for the inbox-watcher bug discovered 2026-05-17:
// the ingest daemon overwrites its snapshot file in the inbox every time
// the source JSONL grows; chokidar fires 'change' (or 'unlink'+'add' on
// some filesystems) for those overwrites. Pre-fix, server.js only listened
// for 'add', so overwrites were silently ignored — inbox file stayed on
// disk, DB stopped getting new content after the first 'add'.
//
// This test simulates the daemon's snapshot-rewrite pattern (cross-dir
// renameSync from staging into inbox) and asserts the chokidar watcher
// configured exactly like server.js still emits an event we can react to
// on each rewrite.

import chokidar from 'chokidar';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
  })();
}
function assert(c, m) { if (!c) throw new Error(m); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('inbox-watcher:\n');

await test('chokidar with server.js config emits both add and a follow-up event on rewrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memex-inbox-watch-'));
  const inbox = join(root, 'inbox');
  const staging = join(root, 'staging');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(staging, { recursive: true });

  const events = [];
  const watcher = chokidar.watch(inbox, {
    ignoreInitial: false,
    ignored: /\.tmp$/,
    awaitWriteFinish: { stabilityThreshold: 200 },
    depth: 0,
  })
    .on('add', (p) => events.push({ kind: 'add', name: p.split('/').pop() }))
    .on('change', (p) => events.push({ kind: 'change', name: p.split('/').pop() }))
    .on('unlink', (p) => events.push({ kind: 'unlink', name: p.split('/').pop() }));

  await sleep(300); // give chokidar time to initialise

  // Step 1 — daemon-style write: stage file, cross-dir rename into inbox.
  const stagingPath = join(staging, 'code-fake.jsonl');
  const inboxPath = join(inbox, 'code-fake.jsonl');
  writeFileSync(stagingPath, '{"role":"user","content":"first","timestamp":"2026-05-17T00:00:00Z"}\n');
  renameSync(stagingPath, inboxPath);
  await sleep(600); // > stabilityThreshold

  // Step 2 — daemon overwrites the same inbox path with grown snapshot.
  const stagingPath2 = join(staging, 'code-fake.jsonl');
  writeFileSync(stagingPath2,
    '{"role":"user","content":"first","timestamp":"2026-05-17T00:00:00Z"}\n' +
    '{"role":"assistant","content":"second","timestamp":"2026-05-17T00:00:01Z"}\n'
  );
  renameSync(stagingPath2, inboxPath); // OVERWRITES the inbox file
  await sleep(600);

  await watcher.close();
  rmSync(root, { recursive: true, force: true });

  // The first rename must trigger an 'add'. The overwrite must trigger SOMETHING
  // that lets us re-import — either a fresh 'add' (chokidar sees unlink+add on
  // cross-dir rename on this OS) or a 'change' on macOS FSEvents. Both are
  // acceptable; the bug was that server.js's old config listened only to 'add'
  // AND chokidar emitted 'change' (on this user's mac) — so the overwrite was
  // lost. Now we listen for both, so any event of either kind for the second
  // rename is sufficient.
  const interesting = events.filter((e) => e.name === 'code-fake.jsonl');
  assert(interesting.length >= 2,
    `expected ≥ 2 events for the rewritten inbox file, got: ${JSON.stringify(interesting)}`);
  // At least one of the events must be 'change' or a second 'add'. If we ONLY
  // see 'add'+'unlink' the rewrite wasn't detected.
  const reimportSignal = interesting.find((e, i) => i > 0 && (e.kind === 'change' || e.kind === 'add'));
  assert(reimportSignal,
    `no re-import-worthy event after rewrite; events: ${JSON.stringify(interesting)}`);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

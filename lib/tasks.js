/**
 * Agent-to-agent task ledger (Foreman tracer-bullet, v0).
 *
 * A task is a MESSAGE with source='agent-task' — so tasks ride the existing
 * sync (which replicates the messages table) with ZERO new transport. Status
 * is event-sourced: every state change is a new append-only row. The current
 * status of a task is its latest-ts event. See docs/design/agent-tasks.md.
 *
 * Row encoding (one messages row per event):
 *   source          = 'agent-task'
 *   conversation_id = 'task-<id>'          (groups a task's events)
 *   msg_id          = '<id>.<status>.<ts>' (unique, append-only)
 *   role            = 'task'
 *   text            = human-readable (prompt on submit, result on done)
 *   metadata(JSON)  = { task_id, status, from, to, kind, prompt, result }
 *   origin          = who wrote THIS event (v0.14 provenance)
 *
 * Status model (A2A subset): submitted → working → done | failed.
 *
 * CLI (brand-neutral, mirrors sync-* — survives the parallelclaw rename):
 *   task-delegate "<prompt>" [--to <origin>] [--kind <c>] [--content <t>]
 *   task-list [--for <origin>] [--status <s>] [--mine] [--inbox]
 *   task-update <id> <status> [--result <text>]
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { getOrigin } from './config.js';

const SOURCE = 'agent-task';
const STATUSES = ['submitted', 'working', 'done', 'failed'];

function dbPath() {
  const dir = process.env.MEMEX_DIR || join(homedir(), '.memex');
  return join(dir, 'data', 'memex.db');
}

function openDb() {
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  return db;
}

/** Append one event row for a task. Returns the row's msg_id. */
function writeEvent(db, { taskId, status, envelope, text, origin, now }) {
  const ts = Math.floor(now / 1000);
  const msgId = `${taskId}.${status}.${now}`;
  db.prepare(
    `INSERT OR IGNORE INTO messages
       (source, conversation_id, msg_id, role, sender, text, ts, metadata, origin)
     VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`
  ).run(SOURCE, `task-${taskId}`, msgId, origin, text || '', ts,
        JSON.stringify(envelope), origin);
  return msgId;
}

/**
 * Create (submit) a task. opts: { prompt (req), to, kind, content, db?, now? }.
 * Returns { id, to }.
 */
export function createTask({ prompt, to = 'any', kind = 'general', content = null, db = null, now = Date.now() } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('createTask: prompt required');
  const ownDb = !db;
  db = db || openDb();
  const from = getOrigin();
  // Short, sortable, collision-resistant id (Node CLI — Date.now/random ok).
  const id = `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeEvent(db, {
      taskId: id, status: 'submitted', origin: from, now,
      text: String(prompt),
      envelope: { task_id: id, status: 'submitted', from, to, kind,
                  prompt: String(prompt), content: content || null, result: null },
    });
  } finally { if (ownDb) db.close(); }
  return { id, to };
}

/**
 * Append a status transition. opts: { result, db?, now? }.
 * Carries prompt/to/kind forward from the latest known event so the envelope
 * stays self-describing. Returns the updated envelope.
 */
export function updateTask(id, status, { result = null, db = null, now = Date.now() } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`updateTask: status must be one of ${STATUSES.join('/')}`);
  const ownDb = !db;
  db = db || openDb();
  try {
    const prev = latestEvent(db, id);
    if (!prev) throw new Error(`updateTask: no task "${id}"`);
    const env = { ...prev.envelope, status, result: result ?? prev.envelope.result ?? null };
    writeEvent(db, {
      taskId: id, status, origin: getOrigin(), now,
      text: status === 'done' || status === 'failed' ? (result || '') : (env.prompt || ''),
      envelope: env,
    });
    return env;
  } finally { if (ownDb) db.close(); }
}

/** Latest event for one task id, or null. Returns { envelope, ts, origin }. */
function latestEvent(db, id) {
  const rows = db.prepare(
    `SELECT metadata, ts, origin FROM messages
      WHERE source = ? AND conversation_id = ? ORDER BY ts DESC, id DESC LIMIT 1`
  ).all(SOURCE, `task-${id}`);
  if (!rows.length) return null;
  let envelope = {};
  try { envelope = JSON.parse(rows[0].metadata || '{}'); } catch (_) {}
  return { envelope, ts: rows[0].ts, origin: rows[0].origin };
}

/**
 * List tasks with their CURRENT (latest) status.
 * opts: { forOrigin, status, mine, inbox, limit, db? }.
 *   mine   — tasks I submitted (from === my origin)
 *   inbox  — tasks addressed to me AND currently 'submitted' (ready to take)
 * Returns [{ id, from, to, kind, status, prompt, result, ts }] newest-first.
 */
export function listTasks({ forOrigin = null, status = null, mine = false, inbox = false, limit = 50, db = null } = {}) {
  const ownDb = !db;
  db = db || openDb();
  try {
    const me = getOrigin();
    // All events; reduce to latest per task in JS (low volume; robust to
    // cross-node id ordering — we key on logical ts, not local rowid).
    const rows = db.prepare(
      `SELECT conversation_id, metadata, ts FROM messages
        WHERE source = ? ORDER BY ts ASC, id ASC`
    ).all(SOURCE);
    const latest = new Map();
    for (const r of rows) {
      let env; try { env = JSON.parse(r.metadata || '{}'); } catch (_) { continue; }
      if (!env.task_id) continue;
      latest.set(env.task_id, { ...env, ts: r.ts }); // later rows overwrite → latest wins
    }
    let out = [...latest.values()];
    if (inbox) out = out.filter((t) => (t.to === me) && t.status === 'submitted');
    if (mine) out = out.filter((t) => t.from === me);
    if (forOrigin) out = out.filter((t) => t.to === forOrigin || t.from === forOrigin);
    if (status) out = out.filter((t) => t.status === status);
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, Math.max(1, limit)).map((t) => ({
      id: t.task_id, from: t.from, to: t.to, kind: t.kind,
      status: t.status, prompt: t.prompt, result: t.result || null, ts: t.ts,
    }));
  } finally { if (ownDb) db.close(); }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { (out._ ||= []).push(a); continue; }
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) { out[a] = next; i++; }
    else out[a] = true;
  }
  return out;
}

export function cmdTaskDelegate() {
  const args = parseFlags(process.argv.slice(3));
  const prompt = (args._ || [])[0];
  if (!prompt) {
    console.error('usage: task-delegate "<prompt>" [--to <origin>] [--kind <class>] [--content <text>]');
    process.exit(2);
  }
  const { id, to } = createTask({
    prompt, to: args['--to'] || 'any', kind: args['--kind'] || 'general',
    content: typeof args['--content'] === 'string' ? args['--content'] : null,
  });
  console.log(`✓ delegated task ${id} → ${to} (from ${getOrigin()})`);
  console.log(`  track: task-list --mine`);
  process.exit(0);
}

export function cmdTaskUpdate() {
  const args = parseFlags(process.argv.slice(3));
  const [id, status] = args._ || [];
  if (!id || !status) {
    console.error('usage: task-update <id> <submitted|working|done|failed> [--result <text>]');
    process.exit(2);
  }
  try {
    const env = updateTask(id, status, { result: typeof args['--result'] === 'string' ? args['--result'] : null });
    console.log(`✓ task ${id} → ${env.status}${env.result ? ' (result attached)' : ''}`);
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  process.exit(0);
}

export function cmdTaskList() {
  const args = parseFlags(process.argv.slice(3));
  const tasks = listTasks({
    forOrigin: args['--for'] || null,
    status: args['--status'] || null,
    mine: '--mine' in args,
    inbox: '--inbox' in args,
    limit: parseInt(args['--limit'] || '', 10) || 50,
  });
  if (!tasks.length) { console.log('No tasks.'); process.exit(0); }
  const icon = { submitted: '○', working: '◐', done: '✓', failed: '✗' };
  for (const t of tasks) {
    const when = t.ts ? new Date(t.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '?';
    console.log(`${icon[t.status] || '?'} ${t.id}  ${t.from} → ${t.to}  [${t.status}]  ${when}`);
    console.log(`    ${String(t.prompt || '').slice(0, 80)}`);
    if (t.result) console.log(`    └ result: ${String(t.result).slice(0, 80)}`);
  }
  process.exit(0);
}

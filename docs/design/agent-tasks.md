# Agent-to-agent tasks (Foreman) — client journeys + tracer-bullet spec

> **Status:** design + tracer (v0). The product where one of the user's agents
> hands a task to another and it gets done. Brand: shipping inside memex; the
> product is being renamed to **parallelclaw** (decided 2026-06-13, no users yet).
> Full vision/requirements: memory note `memex-foreman-orchestration`.

## The one mechanism (not "day/night", not direction-specific)

> Any of my agents hands a task to any other of my agents. It runs when that
> agent is available. The result returns to where I am.

"Direction" (to always-on / cheaper / smarter / different-access) is a
parameter, not a separate system. Time of day is irrelevant. Two illustrative
instances below — same pipe.

## Client journeys — the lazy-Oleg image of the result (verbatim, preserved)

### ① Delegate to an always-on agent ("do this, I'll be away")
> **You, in Claude Code:** "this can run while I'm away — pull together everything on X, report by Monday."
> **Claude Code:** `✓ Handed to vps: "research X". I'll bring the result when you open your laptop. You can close it.`
> *(Monday, you open Claude Code — first thing in context:)*
> `📥 vps finished "research X" (Sat 03:12). ~1400-word report. I skimmed it, added 2 missing sources. Open / discard / refine?`
> You never opened a terminal on the other machine. Result came back where you already were.

### ② Quota wall → auto-failover (the original spark)
> Deep in a Claude Code session, usage hits 20%.
> Instead of "you're out, come back in 2h":
> `⚡ Running low — handing the bulk edits to the cheap always-on agent; I'll keep directing and checking its work.`
> Work doesn't stop. You barely notice — except you didn't hit a wall.

### ③ From phone / another agent → your laptop's smart agent
> **You (Telegram → OpenClaw/Kimi-Claw), midday:** "when I'm at my laptop, have Claude Code refactor the auth module and run tests."
> **Kimi-Claw:** `✓ Queued a task for Claude Code on your Mac. It'll run when you open the laptop; I'll send the result here.`
> *(evening, you open the Mac)* `📥 from you-via-kimi: refactor auth + tests — take it?` → one tap → done → result flows back → **Kimi-Claw pings Telegram:** `✓ auth refactored, tests green (24/24). Diff on the Mac.`

### ④ Autonomous teamwork (with your gate on the irreversible bit)
> Kimi-Claw (always-on, cron) detects "memex deploy failing" → can't fix code → delegates investigation to Claude Code on the Mac → Claude Code finds the cause + prepares a fix → returns to Kimi-Claw → Kimi (has VPS shell) redeploys → pings you: `⚠️ deploy was failing (origin migration); Claude Code found+fixed it, I redeployed — green. Approve merge to main?`
> Read-only investigation = auto; **merge/deploy = one tap** (selective-auto gate).

### Honest availability asymmetry (state it in product)
- Executor = always-on node → runs anytime, even while you sleep.
- Executor = the laptop (smart agent) → only when awake; otherwise the task
  WAITS in the ledger (not an error) until you open it. No cloud Claude Code.

### Decided UX rules
- **Selective-auto default**: read/safe classes auto; destructive on another
  machine (files/git/deploy/spend/outbound) = one-tap approval; origin-trust.
- **Never fail silently**; unavailable executor → waits; stale/failed → loud.
- **Result routes back to the requesting surface** (Claude Code → Claude Code;
  Telegram-via-OpenClaw → back to Telegram).
- **Tasks survive session close** — durable ledger.

---

## Tracer-bullet (v0) — smallest end-to-end slice, like sync's "Day 1"

**Goal:** prove a task round-trips on the live mesh (Mac ↔ Kimi-Claw via the VPS1
hub-transport) with ZERO new transport — before investing in classes /
selective-auto / UI.

### Key idea: a task is a message with `source='agent-task'`
Tasks ride the EXISTING sync (it replicates the `messages` table). Status is
**event-sourced** (append-only rows), matching our verbatim principle. `origin`
(v0.14) records who wrote each event.

**Row encoding** (one `messages` row per task event):
- `source` = `agent-task`
- `conversation_id` = `task-<id>` (groups all events of one task)
- `msg_id` = `<id>.<status>.<ts>` (unique; append-only; dedups exact repeats)
- `role` = `task`
- `text` = human-readable (the prompt on submit, the result on done)
- `metadata` = JSON envelope `{task_id, status, from, to, kind, prompt, result}`
- `origin` = who wrote this event; `ts` = now

**Status model** (A2A subset): `submitted → working → done | failed`.
"Current status of task X" = the latest-ts event row for `conversation_id='task-X'`.
"My inbox" = tasks where `to` = my origin AND latest status = `submitted`.

### Surface (brand-neutral CLI, `sync-*` convention — survives the rebrand)
- `task-delegate "<prompt>" [--to <origin>] [--kind <class>] [--content <text>]`
  → writes a `submitted` event, prints the task id.
- `task-list [--for <origin>] [--status <s>] [--mine] [--inbox]`
  → tasks with their latest status.
- `task-update <id> <status> [--result <text>]`
  → appends an event (working/done/failed).
(MCP tools + natural-language "delegate this" intent + UI surfacing = v1, named
under the final `parallelclaw` brand at rebrand time.)

### Executor = a prompt, zero code (for OpenClaw / Kimi-Claw cron)
> Every 5 min: `task-list --inbox` (tasks addressed to me, status=submitted).
> For each: `task-update <id> working` → do the work with your own tools/model →
> `task-update <id> done --result "<summary/output>"` (or `failed --result "<why>"`).

### Round-trip acceptance test (live, Mac ↔ Kimi-Claw)
1. Mac: `task-delegate "summarize the ECC research in 5 bullets" --to kimi`
2. sync → Kimi-Claw cron picks it up → working → executes → done+result
3. sync → Mac: `task-list --mine` shows `done` with the result.
VPS1 is hub-transport only (its LLM is down); Kimi-Claw is the executor.

### Out of scope for the tracer (later phases)
Selective-auto classes, MCP tools, NL intent recognition, UI surfacing
(SessionStart/statusline/notification), result-routing to Telegram, injection
filter (manual `task-update` = the v0 safety gate), validation loops, quota
arbitrage. See `memex-foreman-orchestration` for phasing.

# ParallelClaw — detailed roadmap (for the next agent)

> Consolidated plan as of **2026-06-14**. Memex is evolving from "AI memory" into
> the **personal AI ops layer** (codename Foreman): your agents share one memory
> AND delegate tasks to each other. This doc is the executable plan — pick a
> phase, read its tasks/files/acceptance, build.
>
> **Read first (memory notes, `memory/`):** `memex-foreman-orchestration`
> (vision + business requirements + v1 fix-list), `memex-retrieval-direction`
> (agentic-FTS5 decision), `clawmem-deep-dive`, `memex-agent-coordination-landscape`,
> `memex-hermes-plugin`, `memex-release-ops`. Companion design docs:
> `docs/design/agent-tasks.md` (client journeys + tracer spec),
> `docs/design/sync-join-ux.md`.

## 0. What ParallelClaw is (positioning)

**One mechanism:** *Any of my agents hands a task to any other of my agents. It
runs when that agent is available. The result returns to where I am.* Memory is
the **foundation** (the durable broker); coordination is the **headline**. This
is an OPEN category — funded players (Mem0 $24M, Letta $70M) are in *memory*;
nobody packages cross-tool, cross-machine, memory-brokered, any↔any personal
agent delegation. Anthropic structurally can't (won't delegate to Kimi/DeepSeek).

## 1. Current state (baseline — already shipped/proven)

- **Sync mesh (v0.13 sync-join, v0.14 origin):** Mac (Claude Code) ↔ VPS1 (hub
  transport; its LLM is DOWN) ↔ Kimi-Claw (OpenClaw + live LLM). Self-healing
  tunnels, hourly watchdog, 15-min schedule. All nodes on **v0.14.1**.
- **Capture spans 6 sources** into one `~/.memex/data/memex.db`: Claude Code,
  OpenClaw (plugin), **Hermes (`plugins/memex-hermes`, shipped to PyPI, 122
  tests)**, Telegram, Cursor, Obsidian. Per-row `origin` provenance (v0.14).
- **Retrieval (v0.12):** FTS5 search with `since_ts`/`until_ts`,
  `conversation_id`, `origin` filters; `get_conversation` offset/order/total.
- **Foreman tracer (commit 7e82b3a):** `lib/tasks.js` — task = message with
  `source='agent-task'`, status event-sourced (append-only). CLI
  `task-delegate`/`task-list`/`task-update`. **Live round-trip PROVEN BOTH
  directions** on Mac↔Kimi-Claw (Mac→Kimi ECC summary; Kimi→Mac code review).

## 2. Decisions locked

- **Rebrand memex → `parallelclaw`, NOW** (no users = cheapest). Rebrand first,
  build new code under the clean namespace.
- **Retrieval = agentic-FTS5 (grep-native), NOT embeddings** by default; vectors
  opt-in later (paraphrase/cross-lingual only).
- **Foreman = feature inside the product** (no separate brand). Selective-auto
  default. Result routes back to the requester's surface. Tasks survive session
  close. Never fail silently.
- **Test coordination on Mac↔Kimi-Claw** (VPS1 = hub transport only).

## 3. Hero scenarios (keep design grounded)

1. Delegate to always-on ("do this while I'm away") — Mac→Kimi.
2. Quota wall → auto-failover (the original spark).
3. Phone/Telegram → laptop's smart agent (e.g. "tell Claude to make Tetris").
4. Autonomous teamwork loop (monitor → delegate → fix → report).

**Availability asymmetry (state honestly):** executor = always-on node → runs
anytime; executor = the laptop (Claude Code) → only while awake, else the task
WAITS in the ledger. No cloud Claude Code, so "do it now with laptop closed"
honestly can't run.

---

# PHASES (sequenced)

## Phase R — Rebrand to ParallelClaw  (~1–2 days, low risk)

**Principle: rename the SURFACE, keep the PLUMBING (as back-compat aliases) so the
live mesh keeps running.**

RENAME (low risk):
- npm package `memex-mvp` → **`parallelclaw`** (same code). Add bin aliases
  `parallelclaw` + `pclaw` → server.js / ingest.js.
- User-facing copy → parallelclaw + coordination narrative: `docs/index.html`
  (landing), `README.md`, `README.ru.md`, `HELP.md`, `SYNC.md`,
  `MULTI_MACHINE.md`, `install.sh`, `skills/install-memex*`, `CHANGELOG.md`.
- GitHub repo `memex-mvp` → `parallelclaw` (auto-redirects). Org/domain already
  parallelclaw.

KEEP (do NOT rename — would break the live mesh; back-compat):
- `~/.memex/` data dir + `MEMEX_DIR` (internal storage, user never sees it).
- env `MEMEX_SYNC_EXPERIMENTAL` / `MEMEX_ORIGIN` (keep reading; optional
  `PARALLELCLAW_*` aliases).
- launchd/systemd labels `com.parallelclaw.memex.*` (already half-branded, work).
- bins `memex` / `memex-sync` (live units call them — keep as aliases).
- MCP tools `memex_*` (keep; don't break MCP wiring/skills). NEW Foreman tools
  born as `parallelclaw_*`.

STEPS: edit copy → add bin aliases in package.json → bump to **1.0.0** → `npm test`
→ commit → user runs `npm publish` (browser-auth; see `memex-release-ops`) →
deprecate `memex-mvp` pointing to `parallelclaw` → nodes keep running (optionally
`npm i -g parallelclaw` later; `memex` alias keeps units alive).
ACCEPTANCE: `parallelclaw --version` works; live mesh sync still green; landing
shows parallelclaw.

## Phase 1 — v1 task-ledger correctness/safety  (BEFORE any auto-execution)

From Claude Code's self-review of `lib/tasks.js` (in `memex-foreman-orchestration`):
- **#1 CRITICAL — status not by wall-clock ts.** `latestEvent` (ORDER BY ts) and
  `listTasks` (overwrite-by-ts) regress state under clock skew (we hit VPS1 skew).
  Fix: **monotonic per-task `seq`** in the envelope (increment from latest seen),
  derive current status by max seq (tiebreak ts). Touch: `lib/tasks.js`
  (writeEvent adds seq; latestEvent/listTasks order by seq).
- **#3 CRITICAL — claim/lock vs double-execution.** Two executors both take a
  `submitted` task. Fix: executor writes `working` with its origin, then
  **re-reads latest and proceeds only if latest==its own working** (optimistic
  claim). Touch: executor logic + `lib/tasks.js` helper `claimTask(id)`.
- #5 lifecycle guard (reject done→working). #2 `to:'any'` routing (broadcast +
  claim, or require explicit `to`, or warn). #6 require result on done/failed.
  #4 msg_id counter suffix. #7 bound listTasks scan + index. #8 decide whether
  `source='agent-task'` rows are excluded from default `memex_search`/overview.
TESTS: extend `test/tasks.test.js` — seq monotonicity under simulated skew,
double-claim rejected, lifecycle guard. ACCEPTANCE: concurrent claim test green;
skew test green.

## Phase 2 — Executor loops + result-routing + delegate UX  (the "auto" loop)

Goal: the Tetris loop runs automatically (within the availability asymmetry).
- **2a. Always-on executor (Kimi/OpenClaw) — fully auto, easy.** A cron-prompt
  (zero code) OR a small poller: every N min `task-list --inbox` → `claimTask`
  → execute with own tools/model → `task-update done --result`. Executor MUST
  read context via `memex search`/CLI, not raw SQL (live-test lesson). Make the
  executor prompt **self-correcting** (state: conversation_id is a column; use
  memex CLI; return any sane result, don't over-optimize).
- **2b. Mac executor (Claude Code) — headless runner, while awake.** launchd
  poller (mirror `lib/sync/cli.js` watchdog + `lib/sync/service.js` unit builder)
  → on inbox task invokes `claude -p "<prompt>"` in a scoped workdir → captures
  output → `task-update done`. **Gated by selective-auto** (code/file tasks from
  trusted origin: auto in sandbox, or one-tap). Honest limit: only while Mac awake.
- **2c. NL intent + delegate tool.** Requesting agent recognizes "tell X to do Y"
  → calls a `delegate` MCP tool (new, `parallelclaw_delegate`) instead of the
  user pasting SQL. Touch: new MCP tool in server.js + SERVER_INSTRUCTIONS recipe.
- **2d. Result-routing.** The originating agent notices its task is `done` and
  delivers the result to the user's surface (e.g. Kimi → Telegram via OpenClaw
  message send). For Claude Code requester → surfaces via SessionStart/statusline.
ACCEPTANCE: end-to-end "ask Kimi → Claude Code (awake) makes it → Kimi DMs result"
with no manual prompt-throwing.

## Phase 3 — Retrieval = agentic-FTS5  (model-free; see `memex-retrieval-direction`)

- **3a. Retrieval recipes** in tool descriptions + HELP: teach the agent to
  iterate (search→read→refine), fire 4–8 parallel query variants, broaden/narrow
  via filters, search-then-read (`memex_search` → `memex_get_conversation` around
  hit). Touch: server.js tool descriptions + SERVER_INSTRUCTIONS + HELP.md.
- **3b. Multi-query + RRF helper** (optional): `memex_search` accepts N variants →
  RRF-fused result set (borrow ClawMem's RRF — fuse KEYWORD queries, not vectors).
- **3c. FTS5 tokenizer fix** (borrow ClawMem: split non-alnum, keep 1-char tokens,
  AND-of-prefixes) for compound terms. Touch: `lib/db-init.js` FTS config + query
  builder in server.js.
- **3d. Injection filter** (borrow ClawMem's 5 layers) on BOTH injected memory
  context AND task-envelope content — REQUIRED before auto-execution. Touch: a
  shared `sanitizeInjected()` used by the hook + the executor.
- Vectors (sqlite-vec + node-llama-cpp) = documented **opt-in** `embed enable`,
  NOT default.

## Phase 4 — Landing + positioning flip

- Add the coordination **vision section** now (memory = foundation). FLIP the
  hero from memory→coordination only AFTER Phase 2 ships (no vaporware). Copy
  drafted in chat 2026-06-13 (Telegram-relayable Hermes-style 2-step framing).
- UI surfacing for coordination: SessionStart line "📥 N tasks from X",
  statusline badge, notification (reuse watchdog notification path).

## Later / opt-in
- Vector semantic layer (paraphrase/cross-lingual).
- **Managed relay** for no-VPS users (the rendezvous gap) — monetization point.
- Hermes as a third delegation participant (it already shares the corpus + has an
  `on_delegation` hook — see `memex-hermes-plugin`).
- Align task envelope fully with A2A status vocab + GNAP shape for interop.

---

## Recommended order
**R (rebrand) → 1 (#1,#3 first) → 2a+2d (always-on auto loop + result-routing,
the cheapest "say-it-and-forget" win) → 2b/2c (Mac headless + NL intent) → 3
(retrieval) → 4 (landing).** Alternative if the user wants the "auto loop" magic
before rebrand: do Phase 1 + 2a + 2d first (toward an always-on node), rebrand
after — but new tool names then get renamed once.

## Test harness reminder
All coordination tested on **Mac (Claude Code) ↔ Kimi-Claw** via VPS1 hub
transport. VPS1's LLM is down — it's transport only. Mac global is 0.14.1;
the repo working tree has the tracer (task-* CLI) — run Mac side via repo
`node ingest.js` until a release ships the CLI to globals.

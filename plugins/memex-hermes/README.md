# memex-hermes

**Bridge that joins [Hermes Agent](https://github.com/NousResearch/hermes-agent) into the memex unified-memory corpus.**

If you use Hermes alongside Claude Code / OpenClaw / Telegram / Cursor / Obsidian — this plugin lets one search find conversations across **all** of them. Hermes turns are stored verbatim in a local SQLite file shared with [memex-mvp](https://www.npmjs.com/package/memex-mvp) (npm), which captures the other clients.

> [!IMPORTANT]
> **Status: 0.1.x — early.** Memex-hermes is in active beta. The technical surface is stable (122 tests, verified on live VPS), but the *product* still has to prove itself. **See "When you might NOT need this" below before installing.**

## When you might NOT need this

Be honest with yourself first.

Hermes ships **strong built-in memory** out of the box:

- `~/.hermes/state.db` — every turn already persisted in SQLite + FTS5 (same stack we use)
- `~/.hermes/MEMORY.md` / `USER.md` — curated long-term notes with pre-compaction auto-flush
- Active Memory subagent — proactive recall before each reply
- `hermes memory` CLI for searching the local store

**If Hermes is your only AI assistant — built-in memory probably covers 80%+ of what you need.** Don't add memex-hermes just because it sounds cool. You'd be running two systems that write the same data, twice the IO, twice the surface area.

memex-hermes only earns its install **when** you have at least one of:

- ✅ You also use Claude Code / Cursor / Cline / Continue / Zed and want unified search across them
- ✅ You also have OpenClaw (memex-mvp captures it via separate daemon) and want one corpus
- ✅ You exported Telegram chats and want them searchable alongside Hermes sessions
- ✅ You want a single `memex` CLI (or web dashboard) for all your AI history
- ✅ You explicitly want the **verbatim guarantee** even for MEMORY.md edits (we mirror them)

If you tick zero of those boxes — install [memex-mvp](https://www.npmjs.com/package/memex-mvp) first, get value from it with one client, then come back when you actually need the bridge.

## What this plugin actually does

When you have memex-mvp set up for other clients, memex-hermes makes Hermes join the party:

```
                              ┌──────────────────────────┐
                              │   ~/.memex/data/         │
                              │     memex.db             │
                              │   (one unified corpus)   │
                              └────────▲─────────────────┘
                                       │
              ┌─────────────┬──────────┼──────────────┬───────────────┐
              │             │          │              │               │
        ┌──────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐
        │ Hermes   │  │ Claude     │  │ OpenClaw   │  │ Telegram │  │ Cursor /     │
        │          │  │ Code       │  │ (Linux VPS)│  │ exports  │  │ Continue/etc │
        │ memex-   │  │            │  │            │  │          │  │              │
        │ hermes   │  │ memex-mvp  │  │ memex-mvp  │  │ memex-mvp│  │ memex-mvp    │
        │ (this)   │  │ daemon     │  │ daemon     │  │ MCP tool │  │ daemon       │
        └──────────┘  └────────────┘  └────────────┘  └──────────┘  └──────────────┘

  Then: one `memex search "tax forms"` → finds it in all of the above,
        regardless of which client you originally discussed it in.
```

memex-hermes is the **Hermes-shaped edge** of that diagram. Without memex-mvp + at least one other source, you're paying installation cost for an isolated feature that Hermes already provides natively.

## Position vs other Hermes memory plugins

This isn't "the best memory for Hermes" — Hermes built-in is excellent for single-client use. It's a **different product**:

| | memex-hermes | Hermes built-in | Mem0 / Supermemory | Mnemosyne / hermes-memory |
|---|---|---|---|---|
| Designed for | multi-client unified history | Hermes-only | extract + recall across sessions | sophisticated Hermes-only recall |
| Storage | verbatim SQLite | verbatim SQLite (state.db) | extracted facts, cloud | structured/vector |
| Shared corpus with other clients | ✅ via memex-mvp | ❌ | ❌ | ❌ |
| Auth / API key | none | none | required (Mem0 cloud) | none |
| Verbatim recall | always | always | impossible | partial |
| Vector search | ❌ (planned v0.2) | ❌ | ✅ | ✅ |
| Right pick if you... | use 2+ AI clients | only use Hermes | want LLM-extracted facts | want fancy in-Hermes recall |

## Install

> [!TIP]
> **First install [memex-mvp](https://www.npmjs.com/package/memex-mvp) (`npm i -g memex-mvp`) and set it up for at least one other client** (Claude Code is the easiest start). Then memex-hermes has something to bridge into. Installing memex-hermes alone makes little sense — see "When you might NOT need this" above.

Four steps. Live on [PyPI](https://pypi.org/project/memex-hermes/) — no git URL needed.

```bash
# 1. Install into Hermes' Python environment (recommended)
uv pip install memex-hermes --python $HOME/.hermes/hermes-agent/venv/bin/python
# Or with vanilla pip:
pip install memex-hermes

# 2. Create the shim folder Hermes discovers
#    (Hermes scans ~/.hermes/plugins/<name>/ directly — no entry_points
#    are used for memory provider discovery as of Hermes v0.10.x.)
memex-hermes init

# 3. Activate in Hermes config — edit ~/.hermes/config.yaml:
#   memory:
#     provider: "memex"

# 4. Restart Hermes. The plugin auto-activates.
```

**Why the extra `init` step?** Hermes' memory-provider discovery is folder-based, not entry-point-based (verified by reading `plugins/memory/__init__.py` in hermes-agent v0.10.x). The `init` command creates a 3-line shim at `~/.hermes/plugins/memex/__init__.py` that imports from the pip-installed package. (Note the asymmetry: **bundled** Hermes plugins live at `<hermes-agent>/plugins/memory/<name>/`, but **user** plugins live at `~/.hermes/plugins/<name>/` — no `memory/` subdir. We follow Hermes' actual discovery code.) Benefits:

- **Auto-upgrades**: `pip install -U memex-hermes` updates the plugin on next Hermes restart. No need to re-run init.
- **Tiny on-disk footprint** in `~/.hermes/`: just a stub, all real code lives in pip site-packages.
- **Forward-compatible**: if a future Hermes adds entry_point support, our `pyproject.toml` already declares it and the same code works for both paths.

To uninstall the plugin without touching the pip package: `memex-hermes uninstall`. To check current status: `memex-hermes status`.

memex is **zero-config** — there's nothing else to set up. The DB lives at `~/.memex/data/memex.db` (override with `MEMEX_DB` env var or `~/.hermes/memex.json` containing `{"db_path": "..."}`).

## Backfill historical Hermes sessions

memex-hermes ships a one-shot backfill so you can import everything Hermes already remembers:

```bash
# Default: reads ~/.hermes/state.db, writes to ~/.memex/data/memex.db
memex-hermes-backfill

# Dry-run to see what would happen
memex-hermes-backfill --dry-run

# Only sessions since a date
memex-hermes-backfill --since 2026-04-01

# Custom paths
memex-hermes-backfill --hermes-home /opt/hermes --memex-db /data/memex.db
```

Idempotent — re-running is safe (`UNIQUE(source, conversation_id, msg_id)` dedups).

## What gets captured

Every Hermes lifecycle hook routes verbatim data into memex.db:

| Hook | What we store |
|---|---|
| `sync_turn(user, assistant)` | both messages of every turn, verbatim |
| `on_session_end(messages)` | safety net — full final history, idempotent re-insert |
| `on_memory_write(action, target, content)` | mirror of built-in `MEMORY.md` / `USER.md` edits |
| `on_pre_compress(messages)` | turns about to be compressed → preserved before context drops them |
| `on_delegation(task, result)` | subagent task and result observations |

Recall is two-phase:

- `queue_prefetch(query)` after each turn → background FTS5 search, result cached
- `prefetch(query)` before next LLM call → returns cached context (~500 token budget), injected into the user message so prompt cache stays valid

And the LLM gets three MCP tools:

- `memex_search(query)` — find records, returns IDs + 100-char previews (Tier 1)
- `memex_get(ids)` — fetch full verbatim text by ID (Tier 2 — only when needed)
- `memex_recent(conversation_id)` — last N messages in a thread (chronological)

This is the **progressive disclosure** pattern (popularised by claude-mem) — ~10× token savings vs returning full text in every search result.

## Conversation IDs

memex-hermes groups messages so the same user's messages on the same platform share a conversation across all Hermes sessions:

| Hermes session metadata | Conversation ID |
|---|---|
| `platform="telegram", user_id="97592799"` | `hermes-telegram-97592799` |
| `platform="discord", user_id="123abc"` | `hermes-discord-123abc` |
| `platform="cli"` (no user_id) | `hermes-cli-<session8>` |
| `platform="cron"` | `hermes-cron-<session8>` |
| Memory file mirror | `hermes-memory-file-memory` / `-user` |

Same model as memex-mvp uses for OpenClaw (`openclaw-tg-<sender_id>`).

## Verify after install

```bash
# Hermes side — check provider is loaded:
hermes memory status
# Should show: "memex" active

# memex-mvp CLI (if installed) — see captured rows:
memex overview
memex recent --source hermes
memex search "ваш тестовый запрос"
```

If `memex` CLI isn't installed, query SQLite directly:

```bash
sqlite3 ~/.memex/data/memex.db \
  "SELECT COUNT(*), MIN(date(ts,'unixepoch')), MAX(date(ts,'unixepoch'))
     FROM messages WHERE source='hermes'"
```

## Logs

`logging.getLogger("memex_hermes")` — appears in Hermes' standard log stream at `~/.hermes/logs/`. Set Hermes log level to DEBUG to see prefetch + sync details.

## What memex-hermes is NOT

- ❌ **Not a replacement for Hermes' built-in memory.** It augments. Hermes' own `state.db` + `MEMORY.md` keep working unchanged.
- ❌ **Not a stand-alone product** — it's a bridge to memex-mvp's unified corpus. Without memex-mvp + another captured client, you get no benefit you couldn't get from Hermes' built-in store.
- ❌ **Not a fact-extractor.** If you want extraction, install Mem0 alongside (memex stores raw, Mem0 indexes facts on top).
- ❌ **Not a vector store** (yet). Search is FTS5 only. sqlite-vec hybrid recall is planned for v0.2.
- ❌ **Not a multi-tenant cloud.** Local-first; one SQLite file per machine.
- ❌ **Not the only writer.** `memex.db` is shared — memex-mvp daemons, MCP imports, this plugin, all coexist via `UNIQUE(source, conv_id, msg_id)`.

## Roadmap

This is an early release (0.1.x). The technical foundation is solid (122 tests, verified on live VPS), but the product story still needs to mature:

- **v0.2** — sqlite-vec hybrid retrieval (close the vector-search gap with Mnemosyne/Hindsight)
- **v0.2** — GitHub Actions CI for test + auto-publish
- **v0.2** — strict mypy + `py.typed` marker
- **v0.3** — opt-in OpenTelemetry hooks for users who want observability
- **future** — Mac ↔ VPS sync of memex.db (so your laptop + your VPS Hermes share one corpus across hosts)

## License

MIT. See LICENSE in the parent repository.

## Source / issues

- Repo: https://github.com/parallelclaw/memex-mvp (plugin lives in `plugins/memex-hermes/`)
- Issues: https://github.com/parallelclaw/memex-mvp/issues
- Homepage: https://memex.parallelclaw.ai

## Related

- [memex-mvp](https://www.npmjs.com/package/memex-mvp) — Node.js CLI + MCP server for the same `memex.db`. Install separately for the `memex search`, `memex overview`, `memex_search` MCP tool, web dashboard, and daemons for Claude Code / OpenClaw / Telegram / Obsidian / Cursor / Cowork.
- [install-memex-claw](https://clawhub.ai/sedelev/install-memex-claw) — installation skill for OpenClaw users.

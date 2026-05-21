# memex-hermes

**Verbatim local-first memory for [Hermes Agent](https://github.com/NousResearch/hermes-agent).**
Stores every turn raw — no LLM extraction, no cloud, no auth, no API keys.

## Why memex-hermes (vs Mem0 / Supermemory / hermes-memory)

Most memory layers for Hermes extract "facts" from your conversations and discard the originals. That's lossy by design — if the extractor misses nuance, you can never recover it.

memex-hermes does the opposite:

| | memex-hermes | Mem0 / Supermemory | hermes-memory |
|---|---|---|---|
| What's stored | **raw turns, full text** | extracted facts | structured memory |
| Backend | local SQLite + FTS5 | cloud SaaS | local SQLite |
| Auth / API key | **none** | required | none |
| LLM cost at capture | **zero** | per-turn extraction | depends |
| Restore originals | **always possible** | impossible | partial |
| Backfill old history | ✅ `memex-hermes-backfill` | ❌ | ❌ |
| Cross-client corpus | ✅ shared with Claude Code, OpenClaw, Telegram via `memex-mvp` | ❌ | ❌ |
| Anthropic-eats-this risk | low (we're the substrate) | high (we'd be the layer that becomes redundant) | medium |

memex is the **substrate**. Pair it with Mem0 / Supermemory if you want extraction *on top* — they'll happily index memex's verbatim store while you still hold the originals.

## Install

Three steps: install the pip package, generate a tiny shim folder Hermes will discover, activate in config.

```bash
# 1. Install into Hermes' Python environment (recommended)
uv pip install memex-hermes --python $HOME/.hermes/hermes-agent/venv/bin/python
# Or with vanilla pip:
pip install memex-hermes

# 2. Create the shim folder Hermes discovers
#    (Hermes scans ~/.hermes/plugins/memory/ — pip entry_points are NOT used
#    for memory provider discovery as of Hermes v0.10.x.)
memex-hermes init

# 3. Activate in Hermes config — edit ~/.hermes/config.yaml:
#   memory:
#     provider: "memex"

# 4. Restart Hermes. The plugin auto-activates.
```

**Why the extra `init` step?** Hermes' memory-provider discovery is folder-based, not entry-point-based (verified by reading `plugins/memory/__init__.py` in hermes-agent v0.10.x). The `init` command creates a 3-line shim at `~/.hermes/plugins/memory/memex/__init__.py` that imports from the pip-installed package. Benefits:

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

- ❌ It is not a fact-extractor. If you want extraction, install Mem0 alongside.
- ❌ It is not a vector store. Search is FTS5 (text). Optional sqlite-vec hybrid recall is on the memex-mvp roadmap.
- ❌ It is not a multi-tenant cloud. Local-first; one SQLite file per machine.
- ❌ It is not the only writer. memex.db is shared — memex-mvp daemons, MCP imports, this plugin, all coexist via `UNIQUE(source, conv_id, msg_id)`.

## License

MIT. See LICENSE in the parent repository.

## Source / issues

- Repo: https://github.com/parallelclaw/memex-mvp (plugin lives in `plugins/memex-hermes/`)
- Issues: https://github.com/parallelclaw/memex-mvp/issues
- Homepage: https://memex.parallelclaw.ai

## Related

- [memex-mvp](https://www.npmjs.com/package/memex-mvp) — Node.js CLI + MCP server for the same `memex.db`. Install separately for the `memex search`, `memex overview`, `memex_search` MCP tool, web dashboard, and daemons for Claude Code / OpenClaw / Telegram / Obsidian / Cursor / Cowork.
- [install-memex-claw](https://clawhub.ai/sedelev/install-memex-claw) — installation skill for OpenClaw users.

# memex-openclaw

**OpenClaw plugin that captures every turn verbatim into the [memex](https://memex.parallelclaw.ai) unified SQLite corpus.**

Replaces the v0.11.x `memex-sync` file-watcher daemon. Captures via OpenClaw's native plugin lifecycle hooks — no file watching, no JSON parsing, no daemon to manage.

> [!IMPORTANT]
> **memex-openclaw is a bridge plugin, not a memory replacement.** It's most useful when you ALSO run other clients (Claude Code / Hermes / Cursor / Telegram exports) captured into the same [memex-mvp](https://www.npmjs.com/package/memex-mvp) corpus. If you only use OpenClaw with built-in memory-core / Memoria / Mem0 — that's already a complete memory stack; memex-openclaw mostly earns its place when you want **unified search across multiple AI clients**.

## What it does

Three lifecycle hooks + two LLM-facing tools:

| Hook | What we do |
|---|---|
| `agent_end` | Insert the just-completed turn's user + assistant messages into memex.db, verbatim. Channel comes from `ctx.messageProvider` — no parsing. |
| `before_compaction` | Save messages that are about to be dropped from active context. They become searchable from memex even after OpenClaw forgets them. |
| `session_end` | Update conversation last_ts. Safety-net marker. |

| Tool | What it does |
|---|---|
| `memex_search(query, limit?)` | FTS5 lexical search across all captured sources. Returns IDs + 100-char previews (cheap — Tier 1 of progressive disclosure). |
| `memex_get(ids)` | Full verbatim text by record ID. Use after `memex_search` to read the records that look relevant (Tier 2). |

Storage: `~/.memex/data/memex.db` (override via plugin config `dbPath`). Same SQLite schema as memex-mvp (npm) and memex-hermes (pip) — all three can write to the same DB concurrently.

> **v0.1.0 used `registerMemoryCorpusSupplement` to surface memex content through OpenClaw's built-in `memory_search`.** Turned out that API is not exported to npm-installed (external) plugins in OpenClaw 2026.5.x — only to bundled ones. v0.1.1 switched to standalone tools, which work everywhere.

## Install

Once published to npm:

```bash
openclaw plugins install @parallelclaw/memex-openclaw
```

For development / local install:

```bash
git clone https://github.com/parallelclaw/memex-mvp.git
cd memex-mvp/plugins/memex-openclaw
npm install
openclaw plugins install --link "$(pwd)"
```

Enable in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "memex-openclaw": {
        "enabled": true
      }
    }
  }
}
```

Optional config (default db path is `~/.memex/data/memex.db`):

```json
{
  "plugins": {
    "entries": {
      "memex-openclaw": {
        "enabled": true,
        "config": {
          "dbPath": "/some/other/path/memex.db"
        }
      }
    }
  }
}
```

Restart OpenClaw:

```bash
openclaw gateway restart
```

### If `MemexStore` fails to open (better-sqlite3 native binary missing)

`openclaw plugins install` may run npm install with `--ignore-scripts`, which skips better-sqlite3's postinstall script that downloads the prebuilt native binary. Result: at runtime the plugin can't open the DB.

Manual fix:

```bash
cd ~/.openclaw/npm/node_modules/@parallelclaw/memex-openclaw
npm rebuild better-sqlite3
# On low-memory VPS where gyp rebuild OOMs, force prebuilt-only:
#   npm rebuild better-sqlite3 --build-from-source=false
openclaw gateway restart
```

### Bug-1 diagnostic (v0.1.1)

If after install the plugin appears `loaded` in `openclaw plugins inspect memex-openclaw` but no rows are captured, check the diagnostic trace file we write at the top of every `register()` invocation:

```bash
cat /tmp/memex-openclaw-debug.log
```

A correct sequence looks like:

```
2026-... module loaded (top-level)
2026-... register() called — gateway recognised plugin
2026-... store opened: ~/.memex/data/memex.db, rows=N
2026-... tools registered: memex_search, memex_get
2026-... register() returned — hooks active
```

If only the first line is present and nothing else fires on `openclaw gateway restart`, OpenClaw is not invoking the plugin's `register()` function for external (npm-installed) plugins. Open an issue on the repo with the full diagnostic file content.

## Conversation routing

| OpenClaw context | memex conversation_id |
|---|---|
| `messageProvider="telegram", channelId="97592799"` | `openclaw-telegram-97592799` |
| `messageProvider="discord", channelId="..."` | `openclaw-discord-<channelId>` |
| `messageProvider="cli"` (no channelId) | `openclaw-cli-<session8>` |
| `messageProvider="cron"` | `openclaw-cron-<session8>` |

Per-user threading: same Telegram chat across multiple OpenClaw sessions ends up in **one** memex conversation, just like memex-hermes does with Hermes.

## Verify

```bash
# Hermes / OpenClaw / memex-mvp can all coexist — check OpenClaw rows:
sqlite3 ~/.memex/data/memex.db \
  "SELECT COUNT(*), MIN(date(ts,'unixepoch')), MAX(date(ts,'unixepoch'))
     FROM messages WHERE source='openclaw'"

# Or via memex-mvp CLI (npm i -g memex-mvp):
memex recent --source openclaw
memex search "your test query" --source openclaw
```

## What this plugin is NOT

- ❌ Not a replacement for OpenClaw's built-in memory (memory-core / Active Memory). It augments — registers as a corpus supplement.
- ❌ Not a fact extractor. Stores raw turns. Use Mem0 / Memoria alongside if you want extraction.
- ❌ Not a vector store (yet). FTS5 lexical search only.
- ❌ Not a single-client product. Earns its value when paired with memex-mvp + at least one other captured client.

## Testing

```bash
npm install
npm test     # 40 tests, ~1 second
```

## Architecture vs old memex-sync daemon (v0.11.x)

| | Old (v0.11.x file-watcher) | New (this plugin) |
|---|---|---|
| Where it runs | Separate `memex-sync` Node daemon | Inside OpenClaw runtime |
| How it captures | Polls `~/.openclaw/agents/main/sessions/*.jsonl` | Subscribes to `agent_end` hook |
| Channel detection | Regex on message text + sessions.json parsing | `ctx.messageProvider` — no parsing |
| Knowledge of OpenClaw file format | Hardcoded (paths, naming, `.reset.`, `.checkpoint.`) | None |
| Lines of code | ~1000 (in memex-mvp lib/) | ~250 (this package) |
| What breaks when OpenClaw changes its file format | Everything | Nothing |
| What breaks when OpenClaw changes its plugin API | This plugin (one file to update) | — |

## License

MIT. See parent repository.

## Related

- [memex-mvp](https://www.npmjs.com/package/memex-mvp) — Node.js CLI + MCP server for the same `memex.db`. Install for search tools, dashboard, and capturing other clients (Claude Code, Cursor, Telegram).
- [memex-hermes](https://pypi.org/project/memex-hermes/) — Python plugin doing the same for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
- [install-memex-claw](https://clawhub.ai/sedelev/install-memex-claw) — ClawHub skill that walks through the install.

# memex-mvp · your AI's missing memory

> **English** · [Русский](README.ru.md)

[![npm](https://img.shields.io/npm/v/memex-mvp.svg)](https://www.npmjs.com/package/memex-mvp)
[![downloads](https://img.shields.io/npm/dw/memex-mvp.svg)](https://www.npmjs.com/package/memex-mvp)
[![license](https://img.shields.io/npm/l/memex-mvp.svg)](LICENSE)

> **A single store for all your AI and Telegram chats.**

A local-first MCP server that indexes **every conversation you have with AI** — Claude Code, Claude Cowork, Cursor, Cline, Continue, Zed, Obsidian notes, and selected Telegram chats — into one searchable SQLite + FTS5 corpus and serves it back to **any MCP-compatible client** through a handful of tools.

No cloud. No account. No data leaves your machine.

```
~/.memex/inbox/              ← drop chat exports here (or symlink AI session files)
     ↓ chokidar watcher
parser  (Telegram JSON · Claude Code JSONL · Cursor SQLite · Obsidian md)
     ↓
SQLite + FTS5  (~/.memex/data/memex.db)
     ↓
MCP server  →  Cursor · Cline · Claude Code · Continue · Zed · Codex · …
```

---

## Install in 60 seconds

```sh
npm install -g memex-mvp
memex-sync install      # macOS LaunchAgent for auto-capture
```

If `npm install -g` hits `EACCES` (system Node on macOS), either fix your prefix once:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
```

Or use one-shot `sudo npm install -g memex-mvp`.

**Want to try without installing globally?**

```sh
npx memex-mvp install
```

---

## Connect to your MCP client

After install, point your client at `memex` (an alias of `server.js` exposed on `PATH`):

### Claude Code

```sh
claude mcp add memex --scope user -- memex
```

### Cursor / Cline / Continue / Zed

Add to that client's MCP config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "memex": { "command": "memex" }
  }
}
```

Restart the client. Try the prompt:

> *"Use memex_overview to show me what's in my AI memory."*

If you see a snapshot of sources and recent conversations — you're done.

For a fully-automated install across all detected MCP clients, see [the AI-driven install guide](https://memex.parallelclaw.ai) on the landing page (paste the prompt into any MCP-enabled agent, it'll wire everything up itself).

---

## What it captures

| Source                | How it gets in                                                 |
|-----------------------|----------------------------------------------------------------|
| Claude Code sessions  | Auto: `memex-sync` watches `~/.claude/projects/`               |
| Claude Cowork         | Auto: same watcher, including all subagent transcripts         |
| Cursor IDE chats      | Auto: reads Cursor's local SQLite session store                |
| Continue / Zed        | Auto: filesystem watchers per platform                         |
| Obsidian notes        | Auto: per-vault markdown watcher                               |
| Telegram exports      | Manual: drop `result.json` (Telegram Desktop) into `~/.memex/inbox/` |
| Telegram (live)       | Run [`memex-bot`](bot/README.md) — captures messages you send/forward to your private bot |

All sources land in the same FTS5 corpus, searchable by one `memex_search` call.

---

## MCP tools

| Tool                          | What it does                                                              |
|-------------------------------|---------------------------------------------------------------------------|
| `memex_overview`              | Corpus snapshot — sources, counts, recent chats, daemon health           |
| `memex_search`                | Full-text search with BM25 × recency boost                               |
| `memex_recent`                | Most recent messages across all sources                                  |
| `memex_get_conversation`      | Full transcript by `conversation_id`                                     |
| `memex_list_conversations`    | Conversations sorted by activity, filterable by source                   |
| `memex_list_projects`         | Distinct project paths captured (for the `project` filter)               |
| `memex_archive_conversation`  | Hide a chat from default listings (data preserved)                       |
| `memex_export_markdown`       | Export one conversation as Markdown (for Obsidian round-trip)            |
| `memex_list_sources`          | Per-source enabled/disabled + counts                                     |
| `memex_status`                | Daemon health: PID, last capture, watched files                          |
| `memex_sources_status`        | Which sources are captured + the exact CLI to opt out                    |
| `memex_help`                  | Returns the full user guide with concrete use cases                      |

Detailed search parameters (filters, sort, format) live in [HELP.md](HELP.md).

---

## Why memex (vs. cloud memory services)

| Concern                       | memex                              | Cloud memory (Mem0 / Supermemory / …) |
|-------------------------------|------------------------------------|---------------------------------------|
| Where your data lives         | Your machine, one SQLite file      | Their servers                         |
| Cost per ingested turn        | 0 (no LLM call on write)           | $0.005+/1K tokens                     |
| Cross-AI corpus               | ✅ same DB for all clients         | ⚠️ depends on plugin coverage         |
| Telegram ingestion            | ✅ first-class                     | ❌ not supported                      |
| Verbatim storage              | ✅ raw text preserved              | ❌ usually fact-extracted             |
| Survives if vendor blocks you | ✅ your DB stays on disk           | ❌ data inaccessible                  |
| Offline / air-gapped          | ✅                                 | ❌                                    |
| Trade-off                     | Lexical search (FTS5), not semantic | Semantic + reranker, but cloud-bound  |

---

## Privacy

- **Zero network egress** during normal operation. The MCP server only listens on stdio.
- **No account, no telemetry.** First-time install ping (planned, opt-out) is the only network call ever — and it's anonymous (UUID + version + OS, no content).
- **The DB is one file** at `~/.memex/data/memex.db`. Back it up, encrypt it (FileVault is enough), `rm` it — your call.
- **Source opt-out per category**: `memex-sync sources <name> disable` keeps that source out of the corpus permanently.

See [PRIVACY section in the Russian README](README.ru.md#приватность-и-безопасность--privacy--security) for the full breakdown.

---

## Cross-device

memex is single-machine by design — but you can sync the DB between your own devices via iCloud Drive symlink, syncthing, or one-time `scp`. The corpus is one SQLite file plus a small inbox directory, so any file-sync tool handles it. See [README.ru.md](README.ru.md#между-устройствами--across-devices) for tested recipes.

---

## Limitations (v0.5)

- **FTS5 only** — no semantic search yet. Russian/English cross-lingual queries don't bridge ("git rebase" vs "перебазирование коммитов" return different hits). Vector embeddings are on the roadmap.
- **macOS-first** — daemon installer registers a LaunchAgent. Linux works as a foreground process; Windows untested.
- **Single user** — the Telegram bot serves exactly one Telegram user_id (you).
- **No webhook for the bot** — long-polling only, captures buffer ~24h server-side when laptop is offline.

---

## Resources

- 🏠 Landing: [memex.parallelclaw.ai](https://memex.parallelclaw.ai) — the AI-driven install prompt
- 📖 [HELP.md](HELP.md) — concrete use cases + full tool reference + troubleshooting
- 🤖 [bot/README.md](bot/README.md) — Telegram capture bot setup
- 🇷🇺 [README.ru.md](README.ru.md) — full Russian README with deeper privacy / migration sections
- 🐛 [Issues](https://github.com/parallelclaw/memex-mvp/issues) on GitHub

---

## License

MIT — see [LICENSE](LICENSE).

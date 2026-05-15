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

**One-line install (recommended):**

```sh
curl -fsSL https://memex.parallelclaw.ai/install.sh | bash
```

That single command:
1. Verifies Node ≥ 20.
2. Runs `npm install -g memex-mvp`, auto-fixing `EACCES` by moving npm's prefix to `~/.npm-global` (no `sudo` needed, ever).
3. Installs the auto-capture daemon (`memex-sync install`) **with** the v0.8 Brian Chesky auto-context hook into `~/.claude/settings.json` (preserves existing hooks).
4. Backfills history (`memex-sync scan`) so memex already knows about your past sessions.
5. If `claude` (Claude Code CLI) is on PATH, runs `claude mcp add memex --scope user -- memex` to wire MCP automatically.

Idempotent — safe to re-run. To inspect the script before piping to bash: `curl -fsSL https://memex.parallelclaw.ai/install.sh | less`.

**Prefer manual install?**

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

### Install via AI skill (Claude Code / OpenClaw)

If you'd rather have an AI agent walk you through everything, drop the
[install-memex skill](skills/install-memex/) into `~/.claude/skills/`:

```sh
mkdir -p ~/.claude/skills
curl -fsSL https://raw.githubusercontent.com/parallelclaw/memex-mvp/main/skills/install-memex/SKILL.md \
  -o ~/.claude/skills/install-memex/SKILL.md
```

Then in Claude Code (or any Skills-aware agent) just say:

> install memex

…or `/install-memex`. The agent handles `npm install`, MCP-config wiring,
auto-capture daemon, and verification — ~2 minutes.

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

## Terminal CLI (v0.7+) — query memex without MCP

The same `memex` binary that runs as an MCP server also has a terminal mode for direct queries. Useful when MCP isn't wired up, when you want to pipe results into shell scripts, or when debugging MCP-config issues:

```sh
memex search "Postgres migration"          # full-text search
memex search "Q2 deck" --chat "Memex Bot"  # scope to one conversation by title
memex search "JWT" --as-of 2026-05-01      # v0.8.1: time-travel — only msgs before date
memex when "Brian Chesky"                   # v0.8.1: "when did we talk about X" — dates + chats
memex recent --limit 5                      # last 5 messages across all sources
memex list --source web                     # all saved URLs
memex get web-1582ab51a7b7                  # full content of one conversation
memex overview                              # snapshot of corpus + v0.8.1: capture streak
memex projects                              # distinct project_paths captured
memex help                                  # full user guide (HELP.md)
memex --help                                # command reference
```

Every query supports `--json` for machine-readable output: `memex search foo --json | jq '.results[].snippet'`. The DB is opened **read-only** — safe to run while `memex-sync` daemon is writing.

When called **without arguments** (`memex`), the binary still runs as an MCP stdio server (the way Claude Code / Cursor / Cline launch it). CLI mode and MCP mode are the same package — no extra install.

---

## Auto-context (v0.8+) — Claude already knows what you were doing

After `memex-sync install`, you're prompted to enable **auto-context**. When yes, memex adds a SessionStart hook to `~/.claude/settings.json` so that **every time you open Claude Code in a project**, Claude gets injected with ~500-1500 tokens of relevant context — what you did recently in this project, which conversations touched it, which related topics came up. No prompts. No tool calls. Just memory.

```sh
# Adding/removing the hook outside the install flow:
memex hook install        # add SessionStart hook (idempotent)
memex hook uninstall      # remove only the memex entry, preserves other hooks
memex hook status         # show current state

# Inspecting what gets injected:
memex context             # dry-run the hook output for the current dir
memex context --pwd /path # for a different project
memex context --no-source telegram  # exclude a source
```

The hook respects existing hooks (e.g. `gstack`, custom user hooks) — they're preserved untouched.

**Currently only Claude Code has native SessionStart hooks.** For Cursor / Cline / Continue / Zed, MCP-tool-based fallback is on the v0.9.0 roadmap.

---

## Save URLs into memex (v0.6+)

Once memex is installed, any MCP-aware agent can also save **web pages, AI chat shares, and pasted text** into your memex memory — searchable from any other AI chat later. In Claude Code, Cursor, Cline, …:

```
Save https://www.perplexity.ai/share/<id> to memex
Add this article to my memex: https://example.com/long-post
```

The agent fetches the page via its own WebFetch (auto-falling back to `r.jina.ai` for Cloudflare-protected sites — memex teaches the trick) and calls `memex_store_document`. Memex stores the content verbatim as a `web` source conversation, indistinguishable from AI chats at search time.

Perplexity threads need to be made **Public** in the Share dialog first — memex detects private threads and tells the user how to fix it. Full guide: [HELP.md §8](HELP.md).

**Memex stays 100% local** — the agent fetches, memex only stores. Zero outbound calls from memex itself.

---

## Telegram chats (v0.10+) — agent walks you through it

Telegram-export setup used to be 8 steps. v0.10+ collapses it to 2 (you click in Telegram; you pick which chats to keep). The rest is automatic.

**How it works:**
1. The daemon watches `~/Downloads/Telegram Desktop/` in the background. **No setup needed** — already on after install.
2. You export a chat from Telegram Desktop (chat → ⋮ → Export chat history → HTML or JSON).
3. memex detects the export, **moves it to `~/.memex/pending/`** (NOT into your DB yet).
4. Your AI agent (or you in terminal) calls `memex_telegram_pending` — sees a numbered list with chat name, msg count, date range.
5. You pick which to import. Sensitive ones (Bank, Therapist, Tinder) — skip. memex remembers and won't ask again.
6. Future re-exports of allowed chats auto-merge. Skipped ones stay out.

**The agent leads.** Just say *"set up Telegram for memex"* (or **install memex** in a fresh session — the install-memex skill v1.2+ proactively offers it). The agent will:
- Check if Telegram Desktop is installed (give you the right download link if not)
- Check the 24h post-login export-block window (tell you when you can export)
- Show the click-path in Telegram
- Wait for your export, then present the picker

**Three modes:** `pick` (default — review each export), `auto` (allowed chats auto-import; new ones go to pending), `manual` (watcher off — drop files yourself).

Terminal equivalents: `memex telegram check / pending / import 1 3 5 / skip 2 / mode auto`. Full reference: `memex telegram --help`.

---

## What it captures

| Source                | How it gets in                                                 |
|-----------------------|----------------------------------------------------------------|
| Claude Code sessions  | Auto: `memex-sync` watches `~/.claude/projects/`               |
| Claude Cowork         | Auto: same watcher, including all subagent transcripts         |
| Cursor IDE chats      | Auto: reads Cursor's local SQLite session store                |
| Continue / Zed        | Auto: filesystem watchers per platform                         |
| Obsidian notes        | Auto: per-vault markdown watcher                               |
| Telegram exports      | **v0.10+: auto.** Daemon watches `~/Downloads/Telegram Desktop/`. Each new ChatExport appears in `memex telegram pending` — review chat-by-chat, import the ones you want. Privacy-first: nothing lands in the DB without your `memex telegram import <indices>`. Allow-list remembers your decisions so future re-exports auto-merge. JSON + HTML both supported. (Legacy path still works: drop into `~/.memex/inbox/`.) |
| Telegram (live)       | Run [`memex-bot`](bot/README.md) — captures messages you send/forward to your private bot |
| **Web pages, AI chat shares, pasted text** | From any MCP agent: *"save https://... to memex"*. Agent fetches; memex stores verbatim. Cloudflare-protected pages (Perplexity, npm.com, Twitter, Medium, …) handled via the agent's r.jina.ai fallback. See [HELP.md §8](HELP.md) |

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
| `memex_store_document`        | Save a web page, AI chat share, or pasted text. Agent fetches; memex stores verbatim. Teaches the Jina r.jina.ai trick for Cloudflare-blocked pages |
| `memex_list_sources`          | Per-source enabled/disabled + counts                                     |
| `memex_status`                | Daemon health: PID, last capture, watched files                          |
| `memex_sources_status`        | Which sources are captured + the exact CLI to opt out                    |
| `memex_help`                  | Returns the full user guide with concrete use cases                      |
| `memex_telegram_check`        | v0.10+: Detect Telegram Desktop, login age (24h block), pending count, suggested next step |
| `memex_telegram_pending`      | v0.10+: List exports staged for review with chat name + msg count + dates |
| `memex_telegram_import`       | v0.10+: Import selected exports into memex.db (by index or title) — auto-allowlists |
| `memex_telegram_skip`         | v0.10+: Mark chats as "never index" — applies to future re-exports too  |
| `memex_telegram_mode`         | v0.10+: Get/set capture mode: pick (default) · auto · manual            |

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

# 📚 Install memex — cross-AI memory in 2 minutes

> One prompt sets up local-first AI memory across **Claude Code, Cowork, Cursor, Cline, Continue, and Zed** — plus Obsidian notes and Telegram chats. No cloud. No account. No data leaves your machine.

## What this skill does

After you drop the skill into your agent (`~/.claude/skills/` for Claude Code, or your client's equivalent), saying **"install memex"** triggers a guided installation:

1. **Discovery** — read-only checks for which MCP client you're using and what AI data already exists on your machine
2. **`npm install -g memex-mvp`** — with EACCES fallbacks (one-shot sudo OR permanent prefix-fix; the agent asks you which)
3. **MCP config merge** — adds a single absolute-path `command` entry into your client's `mcpServers` config. Never overwrites your other servers
4. **`memex-sync install`** — registers the macOS LaunchAgent for live auto-capture
5. **`memex-sync scan`** — one-time backfill of every session that already exists on disk
6. **Restart hint + verification commands** — including the v0.7+ CLI fallback (`memex overview`, `memex search "foo"`) so you can verify memex works even if MCP didn't wire up cleanly

End-to-end: **~2 minutes**, fully observable (agent shows each command before running).

## What is memex?

Memex is a **local-first MCP server** that captures every conversation you have with an AI — across **Claude Code, Cowork (including subagent transcripts), Cursor, Cline, Continue, Zed**, plus **Obsidian notes**, **Telegram chats**, and **web pages / AI chat shares** (v0.6+ via `memex_store_document` — agent fetches, memex stores verbatim) — into one searchable SQLite + FTS5 corpus.

Any MCP-compatible agent can then query that corpus through 12 standard tools (`memex_search`, `memex_recent`, `memex_overview`, `memex_store_document`, …).

| Pain                                            | Memex                                |
|-------------------------------------------------|--------------------------------------|
| Claude forgets every session                    | One unified history across all sessions, all clients |
| Switching from Claude Code to Cursor = lost context | Cursor can read your Claude history (same SQLite DB) |
| Cloud memory services hold your data hostage    | One `~/.memex/data/memex.db` file on your disk       |
| Mem0 / Supermemory pricing per token            | 0 LLM calls on write — free at any scale             |
| Vendor ban = lose everything                    | Your DB stays even if Claude blocks your account     |

📦 npm: [memex-mvp](https://www.npmjs.com/package/memex-mvp) · 🏠 [memex.parallelclaw.ai](https://memex.parallelclaw.ai) · 🐛 [GitHub](https://github.com/parallelclaw/memex-mvp)

## Why a skill (vs. just copy-pasting the install prompt)

The install playbook also exists as a copy-paste prompt on the landing page. But once you have the skill installed, you skip a friction layer:

| Without skill | With skill |
|---|---|
| Open landing page in browser | (already in your agent) |
| Click "Copy install prompt" | — |
| Paste a wall of text into Claude/Cursor | Just say "install memex" |
| Hope the prompt is up-to-date | Skill version updates auto-fetched |

The skill description is written so Claude / OpenClaw auto-invoke it from any phrasing of "install memex", "set up memex", "add memory to my AI", etc. — no need to remember `/install-memex` exactly.

## Example dialogue

> **User:** install memex
>
> **Agent:** 👋 You're running inside Cursor. Let me run a quick discovery before any install actions...
>
> ✓ Found Claude Code data at `~/.claude/projects/` (8 sessions)
> ✓ Found Cowork sessions (3 subagent transcripts in your projects)
> ✗ Continue not installed
> ✗ Zed not installed
> ✓ Cursor data found (this is where I'll write the MCP config)
>
> After install, memex will auto-index conversations from: Claude Code, Cowork, Cursor. Drop Telegram exports into `~/.memex/inbox/` manually if you want those too.
>
> Ready to proceed with Step 1 (`npm install -g memex-mvp`)?
>
> **User:** yes
>
> **Agent:** [shows each command, runs npm install, gets `which memex` path, merges into `~/.cursor/mcp.json`, runs `memex-sync install`, runs `memex-sync scan`, prints restart hint]

See [examples.md](examples.md) for more sample dialogues, including EACCES recovery and partial-install scenarios.

## Requirements

- **Node.js 20–24** (LTS recommended). Install via [nodejs.org](https://nodejs.org), `brew install node`, or [nvm](https://github.com/nvm-sh/nvm)
- **macOS or Linux** (Windows untested for memex itself; skill works anywhere your agent has shell access)
- **An MCP-compatible CLI agent**: Claude Code, OpenClaw, Cursor (with MCP), Cline, Continue, or Zed. Web-only agents (ChatGPT, Claude.ai) can't execute install steps

## Install the skill

```sh
mkdir -p ~/.claude/skills/install-memex
curl -fsSL https://raw.githubusercontent.com/parallelclaw/memex-mvp/main/skills/install-memex/SKILL.md \
  -o ~/.claude/skills/install-memex/SKILL.md
```

Or, if you've already done `npm install -g memex-mvp`, the skill ships inside the package:

```sh
cp -r "$(npm root -g)/memex-mvp/skills/install-memex" ~/.claude/skills/
```

Then in your agent: `install memex` (or `/install-memex` if your client supports slash-commands).

## What the skill won't do

- ❌ Install Node.js for you — it stops and asks you to install it
- ❌ Run `sudo` without asking — EACCES fallback always confirms with you first
- ❌ Overwrite your existing `mcpServers` config — always merges
- ❌ Redirect any host application's data location — memex reads from each tool's native path
- ❌ Send anything over the network (besides `npm install` itself)

## License

[MIT](https://github.com/parallelclaw/memex-mvp/blob/main/LICENSE) for memex itself.
This skill bundle is published on ClawHub under [MIT-0](https://opensource.org/license/mit-0) (effectively public domain — no attribution required) per ClawHub's publishing terms.

---

📚 Built by [@parallelclaw](https://github.com/parallelclaw) · Star the repo if memex helps you: [github.com/parallelclaw/memex-mvp](https://github.com/parallelclaw/memex-mvp)

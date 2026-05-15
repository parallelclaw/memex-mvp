---
name: install-memex
description: Make Claude, Cursor, Cline, Continue, and Zed remember every AI conversation forever — one local SQLite corpus shared across all of them. Installs memex (local-first MCP server) in ~2 minutes — npm install, MCP config wiring, auto-capture daemon, history backfill. No cloud, no account, verbatim storage. Also indexes Obsidian notes, Telegram chats, and any URL the user wants to save (web pages, Perplexity threads, AI chat shares — memex_store_document tool, v0.6+). Use when the user says "install memex", "set up memex", "add memory to my AI", "make my agent remember across sessions", or similar.
version: 1.0.0
metadata:
  openclaw:
    emoji: "📚"
    homepage: https://memex.parallelclaw.ai
    requires:
      bins:
        - node
        - npm
---

# Install memex

You are installing **memex** on this machine. Memex is a local-first MCP server that captures the user's AI conversations across Claude Code, Cowork (including subagents), Cursor, Obsidian, and Telegram exports into a searchable SQLite + FTS5 index that any MCP-compatible agent can query through 11 standard tools.

Repo: https://github.com/parallelclaw/memex-mvp
Landing: https://memex.parallelclaw.ai
npm: https://www.npmjs.com/package/memex-mvp

## How memex works (read this so you don't get confused by paths below)

Memex has its OWN storage at `~/.memex/data/memex.db`. It READS from each tool's native data location automatically — Claude Code from `~/.claude/projects/`, Cursor from its `state.vscdb`, Cowork from its sessions dir, Obsidian from configured vaults. You do NOT need to change where Claude Code, Cursor, or any other tool saves its data. Memex is a passive observer.

## Prerequisite

This skill only works if you are running INSIDE an AI agent that has direct access to the user's shell — i.e. one of: Claude Code (CLI), Cursor, Cline, Continue, or Zed. Web-based agents (ChatGPT in browser, Claude.ai web, Claude Desktop without tools, etc.) cannot execute `npm`/file operations. If you are NOT a CLI-based agent with shell access, stop now and tell the user to use the manual install at https://memex.parallelclaw.ai/#quickstart.

## Discovery — do this BEFORE the numbered steps

Scan the user's setup so you can tailor advice and tell them exactly what memex will pick up.

1. Identify which MCP client you're running inside (you should know from context — Claude Code CLI, Cursor, Cline, Continue, or Zed).
2. Run these read-only checks one by one:
   ```sh
   ls -d ~/.claude/projects 2>/dev/null
   ls -d ~/Library/Application\ Support/Claude/local-agent-mode-sessions 2>/dev/null
   ls -d ~/Library/Application\ Support/Cursor 2>/dev/null
   ls ~/.continue/config.json 2>/dev/null
   ls -d ~/.config/zed 2>/dev/null
   ```
3. Report to the user in plain language:
   - "You're running inside [X]. I will edit [path] in step 2 below."
   - "Tools with data found on this machine: [list]"
   - "Tools NOT found (memex won't capture from these): [list]"
   - "After install, memex will auto-index conversations from: [detected sources]"
4. Wait for the user's "ok" before starting step 1.

## Five-step install

Do these in order. Show each command before running it. Stop and ask if anything fails or looks wrong.

### 1. Install memex from npm

```sh
npm install -g memex-mvp
```

If you get `EACCES` (macOS system Node), tell the user to choose:

**Option A** — one-shot sudo:
```sh
sudo npm install -g memex-mvp
```

**Option B** — fix prefix permanently (better long-term):
```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
npm install -g memex-mvp
```

**Ask which the user prefers — don't guess.**

If `node` or `npm` are missing, STOP and tell the user to install Node.js (recommend nvm.sh or `brew install node`). Don't try to install Node yourself.

**Verify:** `which memex` prints an absolute path; `memex-sync --help` runs without error.

### 2. Wire memex into the MCP client

Common config locations:

| Client       | Config file                                         |
|--------------|-----------------------------------------------------|
| Claude Code  | `~/.claude/config.json` (or platform equivalent)    |
| Cursor       | `~/.cursor/mcp.json`                                |
| Cline        | VS Code `settings.json` (`cline.mcpServers`)        |
| Continue     | `~/.continue/config.json`                           |
| Zed          | `~/.config/zed/settings.json` (`context_servers`)   |

Tell the user which one you've inferred and which file you'll edit. If unclear, ask.

Read the existing config (if present). Show the user a diff before saving.

Get the **absolute** path to the memex binary — GUI apps (Cursor, Cline, Claude Desktop) on macOS often don't inherit shell PATH, so a bare `"command": "memex"` fails with `spawn memex ENOENT`. Run:

```sh
which memex
```

Capture that path (e.g. `/Users/<you>/.npm-global/bin/memex` or `/usr/local/bin/memex`). If it's a shim, also run `realpath $(which memex)` to resolve to the real binary.

MERGE this entry into `mcpServers` — never overwrite other servers the user has:

```json
{
  "mcpServers": {
    "memex": {
      "command": "<absolute path from which memex>"
    }
  }
}
```

One path, no `args`. The published npm package wires up its own entry point.

If the config file doesn't exist, create the parent directory and write a minimal valid file with just memex.

**Verify:** re-read the file after save; confirm `memex` entry is present and `command` is an absolute path.

### 3. Turn on live auto-capture

```sh
memex-sync install
memex-sync status
```

`status` should print "daemon installed", "running (PID …)", "watching N sessions".

**Verify:** status output shows a non-zero PID.

### 4. Backfill existing history

The daemon only catches NEW sessions going forward. To index everything already on disk:

```sh
memex-sync scan
```

This walks `~/.claude/projects/`, Cowork sessions, Cursor `state.vscdb`, and any configured Obsidian vaults once, ingesting whatever exists.

Optionally:
```sh
memex-sync backfill-projects
```

Tags older conversations with their `project_path` so `memex_list_projects` works on them.

**Verify:** after scan, `memex-sync status` shows a non-zero "ingested" count.

### 5. Tell the user what to do next

Tell the user to fully quit and reopen the MCP client (Cmd+Q on macOS) so it picks up the new memex tools.

After restart, suggest they try any of:
- "show me what memex has in memory" → triggers `memex_overview`
- "what projects has memex captured" → triggers `memex_list_projects`
- "search memex for [recent topic]" → triggers `memex_search`
- "save https://en.wikipedia.org/wiki/As_We_May_Think to memex" → triggers `memex_store_document` and teaches the user that URL-saving exists (v0.6+)

These confirm everything works end-to-end.

**CLI fallback (v0.7+):** if the MCP integration doesn't pick up in the user's client for any reason, tell them they can verify memex from the terminal directly — same binary, no MCP needed:

```sh
memex overview      # confirms memex itself is healthy
memex search "foo"  # FTS search from CLI
memex list          # list conversations
memex --help        # command reference
```

This is also useful for agents without native MCP support (OpenCode + Kimi, plain shell scripts, CI pipelines) — they can shell out to `memex` directly.

## Safety rules — read before starting

- If `node` or `npm` aren't installed, stop and tell the user to install Node.js (recommend nvm.sh or `brew install node`). Don't try to install Node yourself.
- Never run `rm`, `sudo`, or anything destructive without explicit confirmation from the user.
- Show every command before running it. If the user says "no" or "stop", halt and explain.
- If a step fails, do NOT auto-retry or auto-fix — tell the user what failed and ask how to proceed.
- When editing the MCP config, always preserve existing entries. If you can't merge cleanly, abort and tell the user.
- Do NOT modify the host application's settings beyond adding the memex entry to its `mcpServers` config. Specifically: do not redirect where Cursor / Claude Code / any other tool saves its data. Memex reads from each tool's native location automatically. The only file you should touch is the MCP config file listed in step 2.
- Stay focused on the main install task. If sidetracked into a sub-task (changing workspace, fixing an unrelated config issue, looking up something else), once it's done you MUST return to the memex install and explicitly tell the user: "OK, back to memex install. We were at step N — should I continue?". Don't go silent after a side task. Don't assume the user wants to abandon the install — always confirm.

## Begin

Greet the user, confirm which MCP client you're running inside, and run the Discovery checks before any install actions.

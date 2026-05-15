---
name: install-memex
description: Make Claude, Cursor, Cline, Continue, and Zed remember every AI conversation forever — one local SQLite corpus shared across all of them. Installs memex (local-first MCP server) in ~2 minutes — npm install, MCP config wiring, auto-capture daemon, history backfill. No cloud, no account, verbatim storage. Also indexes Obsidian notes, Telegram chats, and any URL the user wants to save (web pages, Perplexity threads, AI chat shares — memex_store_document tool, v0.6+). Use when the user says "install memex", "set up memex", "add memory to my AI", "make my agent remember across sessions", or similar.
version: 1.2.0
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

## Fast path — one-line installer (try this first)

memex ships a hosted bash installer that does steps 1, 3, and 4 in a single run — and also wires up Claude Code's MCP entry if `claude` is on PATH. It's idempotent (safe to re-run), auto-fixes the `EACCES` case by moving npm's prefix to `~/.npm-global`, and prompts before enabling the auto-context hook.

Show this command to the user, explain what it does, get their **explicit ok**, then run:

```sh
curl -fsSL https://memex.parallelclaw.ai/install.sh | bash
```

What the script does, in order:
1. Checks Node ≥ 20.
2. `npm install -g memex-mvp` — on EACCES, sets `npm config set prefix ~/.npm-global`, appends PATH to `~/.zshrc`, retries.
3. `memex-sync install` with `--auto-context yes` (Brian Chesky hook into `~/.claude/settings.json` — preserves other hooks).
4. `memex-sync scan` — backfills existing history.
5. `claude mcp add memex --scope user -- memex` if Claude Code CLI is detected.

After the script finishes:
- If the user is in **Claude Code (CLI)** → install is complete. Skip straight to step 6 (verification + restart). Also do step 5 (offer Telegram capture).
- If the user is in **Cursor / Cline / Continue / Zed** → the npm install + daemon + auto-context + scan are done, but the GUI client's MCP config still needs the memex entry. **Skip step 1 (already installed)**, **skip step 3** (daemon already installed) and **skip step 4** (scan already ran). **Do step 2** (wire MCP into the GUI client's config), **step 5** (offer Telegram), and **step 6** (verify + restart).

If the script fails for any reason — non-zero exit, weird output, user uncomfortable piping curl to bash — fall back to the **Manual install** below.

To inspect what the script does first: `curl -fsSL https://memex.parallelclaw.ai/install.sh | less` (don't pipe to bash).

## Manual install (if the fast path didn't fit)

Do these in order. Show each command before running it. Stop and ask if anything fails or looks wrong.

### 1. Install memex from npm

```sh
npm install -g memex-mvp
```

If you get `EACCES` (macOS system Node), **recommend Option B (permanent prefix fix) by default** and proceed unless the user explicitly chooses sudo.

Say to the user:

> "Hit EACCES — your Node is installed in a system directory that npm can't write to without admin rights. Two fixes:
>
> **A)** Quick: `sudo npm install -g memex-mvp` — one-time, requires your password
> **B)** Permanent fix: I'll move npm's install location to your home directory. After this, no `npm install -g` will ever ask for sudo again, for any package. Five commands, one-time.
>
> I recommend **B** — it's a permanent improvement that benefits all your future Node tools, not just memex. Proceed with B?"

If the user agrees (or says anything like "ok", "yes", "default", "go", "B") — proceed with B without further questions:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
npm install -g memex-mvp
```

If the user **explicitly** picks A (or says "sudo", "fast", "quick"), use sudo:

```sh
sudo npm install -g memex-mvp
```

After the install completes, verify with `which memex` (should print an absolute path) and `memex --version` (should print the version).

**Important if Option B was used + user already had memex from a prior sudo install:** the old sudo-installed copy in `/usr/local/lib/node_modules/memex-mvp/` is now orphaned (PATH prefers the new home install). Mention this once:

> "By the way, you have an older sudo-installed memex copy in `/usr/local/lib/`. It's harmless but takes ~60 MB. Clean it up when convenient: `sudo npm uninstall -g memex-mvp` — not urgent."

Don't run that uninstall yourself — let the user decide when.

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

### 3. Turn on live auto-capture + auto-context (v0.8+)

```sh
memex-sync install
```

During `memex-sync install`, you'll see a prompt:

```
Auto-context (Brian Chesky mode):
  When you open Claude Code in a project, memex can inject 500-1500 tokens
  of relevant context so Claude knows what you were doing — without you
  having to ask. Adds a SessionStart hook to ~/.claude/settings.json.
  Other hooks (e.g. gstack) are preserved.

  Enable? [Y/n]
```

**Answer Y unless the user has stated privacy concerns** about Claude seeing context from their other AI conversations. Auto-context is the "10/10 magic moment" of memex — without it the install ships at base capability. Other hooks (gstack, custom) are preserved untouched.

For non-interactive flows (CI / scripts): pass `--auto-context yes` or `--yes`.

```sh
memex-sync status
```

`status` should print "daemon installed", "running (PID …)", "watching N sessions".

**Verify:** status output shows a non-zero PID. Also run `memex hook status` — should show `INSTALLED` if auto-context was accepted.

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

### 5. Offer Telegram-export capture (v0.10+)

After the core install is done, **proactively** ask:

> "Memex can also remember your Telegram chats — work, family, group chats, whatever you want indexed. Want me to set that up too? It's about 2 minutes."

If yes, run `memex_telegram_check` (MCP tool) or `memex telegram check` (CLI). The result tells you the user's state and the next step. Walk them through:

  - **No Telegram Desktop?** → Give the download URL from the check output. Wait for them to install + log in.
  - **Logged in <24h ago?** → Tell them: "Telegram blocks export for the first 24h. Wait ~X hours, then come back."
  - **Ready to export?** → Show the click-path: open chat → ⋮ menu (top-right) → "Export chat history" → format HTML or JSON → Export.

After the user exports, memex's daemon **auto-detects** the file in ~/Downloads/Telegram Desktop/ and stages it in pending review. Then:

  - Call `memex_telegram_pending` to list staged exports (chat name, msg count, date range).
  - **Present as a numbered list**, ask which to import. Accept indices, titles, or natural language.
  - Call `memex_telegram_import` with selected indices/titles. The chat is added to the allow-list — future re-exports auto-merge.
  - For sensitive chats user doesn't want (Bank, Therapist, etc.), call `memex_telegram_skip`.

**Privacy is the core promise. Never auto-import. Always get explicit per-chat consent on the first round.**

If the user declines Telegram setup ("not now" / "skip"): say "OK, I'll skip Telegram. You can run `memex telegram setup` anytime later." Don't push.

### 6. Tell the user what to do next

Tell the user to fully quit and reopen the MCP client (Cmd+Q on macOS) so it picks up the new memex tools.

After restart, suggest they try any of:
- "show me what memex has in memory" → triggers `memex_overview`
- "what projects has memex captured" → triggers `memex_list_projects`
- "search memex for [recent topic]" → triggers `memex_search`
- "save https://en.wikipedia.org/wiki/As_We_May_Think to memex" → triggers `memex_store_document` and teaches the user that URL-saving exists (v0.6+)
- **Open Claude Code in any project the user worked on recently** — the SessionStart auto-context (v0.8+) should kick in and Claude will mention prior work _before_ the user types anything. This is the "Brian Chesky moment" — the magical-first-impression of memex.

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

Greet the user, confirm which MCP client you're running inside, and run the Discovery checks before any install actions. After Discovery, **propose the fast path (curl one-liner) first** — it covers ~90% of cases in one shot. After the core install completes, **proactively offer Telegram-export capture (step 5)** unless the user has already declined. Only fall back to the manual flow if the user objects, the script fails, or you're inside a GUI client where you'll still need to do step 2 manually after the script runs.

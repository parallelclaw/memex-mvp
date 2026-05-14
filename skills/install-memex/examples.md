# Example dialogues

Sample interactions when the user invokes this skill. These show typical happy paths and how the skill handles common edge cases.

---

## Example 1 · Happy path on a fresh Cursor install

> **User:** install memex
>
> **Agent:** 👋 You're running inside Cursor. Let me run a quick discovery before any install actions...
>
> ```
> ✓ Found Claude Code data at ~/.claude/projects/ (12 sessions)
> ✓ Found Cowork sessions (4 subagent transcripts)
> ✓ Cursor data found — I'll write MCP config to ~/.cursor/mcp.json
> ✗ Continue config not found
> ✗ Zed config not found
> ```
>
> After install, memex will auto-index conversations from: **Claude Code, Cowork, Cursor**. If you also use Obsidian or want Telegram chats indexed, we can add those after the main install.
>
> Ready to proceed with Step 1?
>
> **User:** yes
>
> **Agent:** Running `npm install -g memex-mvp`...
>
> ```
> + memex-mvp@0.5.4
> ```
>
> ✓ Memex installed. Verifying: `which memex` → `/usr/local/bin/memex`. Good.
>
> Step 2: I'm about to merge a new entry into your `~/.cursor/mcp.json`. Here's the diff:
>
> ```diff
>   {
>     "mcpServers": {
>       "github": { ... },
> +     "memex": {
> +       "command": "/usr/local/bin/memex"
> +     }
>     }
>   }
> ```
>
> Looks correct? (Y/n)
>
> **User:** yes
>
> **Agent:** ✓ Config saved.
>
> Step 3: `memex-sync install` — sets up the macOS LaunchAgent that auto-captures new Claude Code / Cowork / Cursor sessions...
>
> ```
> ✓ memex-sync installed
> ✓ daemon running (PID 47291)
> ✓ watching 12 sessions across 3 source roots
> ```
>
> Step 4: `memex-sync scan` to backfill existing history. This indexes everything already on your disk — might take 30-90 seconds...
>
> ```
> ingested 847 messages from 12 conversations
> ```
>
> ✓ All done. **Restart Cursor (Cmd+Q + reopen)** so it picks up the new memex tools. After restart, try:
>
> - "what does memex have in memory?"
> - "search memex for [a recent topic you worked on]"
> - "list my memex projects"

---

## Example 2 · EACCES recovery (macOS system Node)

> **User:** install memex
>
> **Agent:** [runs discovery, gets user OK] Step 1: `npm install -g memex-mvp`...
>
> ```
> npm error code EACCES
> npm error path: '/usr/local/lib/node_modules/memex-mvp'
> ```
>
> Hit a permissions error — this is common on macOS when Node is installed system-wide. Two ways to fix:
>
> **Option A** (quick, requires sudo password):
> ```sh
> sudo npm install -g memex-mvp
> ```
>
> **Option B** (one-time setup, then future `npm install -g` works without sudo):
> ```sh
> mkdir -p ~/.npm-global
> npm config set prefix ~/.npm-global
> echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
> source ~/.zshrc
> npm install -g memex-mvp
> ```
>
> Option B is the standard npm recommendation — solves this for every future global install. Option A is faster if you don't want to touch your shell config. Which do you prefer?
>
> **User:** B
>
> **Agent:** [runs the 5 commands in sequence, shows output for each] ✓ Done. Verifying:
>
> ```
> which memex → /Users/macbook/.npm-global/bin/memex
> ```
>
> Now continuing to Step 2 with this path...

---

## Example 3 · Wants only Claude Code, not the daemon

> **User:** install memex but skip the daemon
>
> **Agent:** Sure — that means memex will be available as a tool, but new sessions won't be auto-captured. You'll need to run `memex-sync scan` manually whenever you want to index recent sessions. Got it?
>
> **User:** yes
>
> **Agent:** [runs Steps 1, 2, 4 — skipping `memex-sync install` in Step 3]
>
> ✓ Memex installed, MCP config wired, backfill complete (847 messages from existing sessions).
>
> Since you skipped the daemon, here's how to refresh memex going forward:
> ```sh
> memex-sync scan
> ```
>
> You can install the daemon any time later: `memex-sync install`.

---

## Example 4 · Existing memex install detected

> **User:** install memex
>
> **Agent:** Quick check: `which memex` → `/usr/local/bin/memex`. You already have memex installed.
>
> Running `memex-sync status`:
> ```
> daemon running (PID 47291), watching 12 sessions
> last capture: 4 minutes ago
> ```
>
> Memex is working. What would you like to do?
>
> - **Reinstall** (e.g. to update to the latest version): I can run `npm install -g memex-mvp@latest`
> - **Add a new source** (Obsidian vault, Telegram exports, etc.)
> - **Add memex to another MCP client** (you have it in Cursor; want it in Cline / Continue / Zed too?)
> - **Nothing** — already good

---

## Example 5 · Web-only agent (no shell access)

> **User:** install memex
>
> **Agent:** I see you're running me through claude.ai web — I don't have access to your machine's shell, so I can't run `npm install` or write files for you.
>
> You have three options to install memex:
>
> 1. **CLI agents** (best UX): Open Claude Code, Cursor, Cline, Continue, or Zed and ask me there. Those have shell access and will run this skill end-to-end.
>
> 2. **Manual install** (~5 minutes, you run the commands): Follow https://memex.parallelclaw.ai/#quickstart — 4 steps in your terminal.
>
> 3. **One-liner from terminal**:
> ```sh
> npm install -g memex-mvp
> memex-sync install
> ```
> Then add `{"mcpServers": {"memex": {"command": "$(which memex)"}}}` to your MCP client's config file. Details: https://memex.parallelclaw.ai
>
> Which path works for you?

---

## What these examples illustrate about the skill's behavior

- **Always discover first**, then ask for confirmation before any write action
- **Show every command** before running it; show diffs for config edits
- **Offer choices** at decision points (EACCES, daemon yes/no) rather than guessing
- **Detect and adapt** to existing installs, missing prerequisites, partial setups
- **Refuse gracefully** when running in a context where the install can't actually work (web-only agents)

If you see the skill *not* doing one of these things, that's a bug — report it at https://github.com/parallelclaw/memex-mvp/issues.

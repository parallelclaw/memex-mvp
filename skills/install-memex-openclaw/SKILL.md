---
name: install-memex-openclaw
description: Wire memex (the local-first MCP memory server) into an OpenClaw gateway — works wherever OpenClaw runs (Linux or macOS, VPS or workstation). Auto-captures every OpenClaw session in ~/.openclaw/agents/main/sessions/ and exposes 18 MCP tools (memex_search, memex_recent, memex_overview, memex_store_document, memex_import_file, etc.) to the local OpenClaw agent. Auto-detects whether memex is already installed on this machine (e.g. via the generic install-memex skill for Claude Code) — if yes, skips install and just merges memex into the OpenClaw gateway config; if no, does the full platform-aware install (Linux → systemd user-service, macOS → LaunchAgent). Back-fills past sessions in one shot. Zero questions to the user — discovery → actions → verification. Use when the user says "set up memex for OpenClaw", "wire memex into my OpenClaw", "make OpenClaw remember its sessions", "поставь memex здесь", or similar. PAIRS with the generic install-memex skill — if the user ALSO uses Claude Code, Cursor, Cline, Continue, Zed, or has Telegram chats to capture on this same machine, recommend they run install-memex separately for those flows.
version: 1.0.0
metadata:
  openclaw:
    emoji: "🧠"
    homepage: https://memex.parallelclaw.ai
    requires:
      bins:
        - node
        - npm
---

# Install memex for OpenClaw

You are inside an OpenClaw agent. The user asked you to set up memex — the local-first MCP memory server — so that:

1. Every OpenClaw session in `~/.openclaw/agents/main/sessions/` is auto-captured into a single SQLite + FTS5 corpus.
2. Existing past sessions are back-filled in one shot.
3. The OpenClaw gateway gains 18 MCP tools (memex_search, memex_overview, memex_recent, memex_store_document, memex_import_file, etc.).
4. The capture continues automatically (systemd user-service on Linux, LaunchAgent on macOS).

**Where you might be running:**

- 🖥️ **VPS** (Linux VPS hosting OpenClaw + Hermes etc.) — typical "always-on agent" deployment
- 💻 **macOS workstation** running OpenClaw alongside Claude Code / Cursor / etc.
- 💻 **Linux workstation** (Pop!OS, Fedora, etc.) running OpenClaw locally
- 🖥️ **macOS VPS / Mac-mini server** — also valid

All four work the same way. **Platform** (Linux/macOS) determines daemon type. **Context** (VPS vs workstation) is irrelevant to memex.

**Important — interaction with the generic install-memex skill:**

If the user ALREADY ran [`install-memex`](https://clawhub.ai/sedelev/install-memex) (the generic Claude Code / Cursor / Cline / Continue / Zed installer) on THIS machine, then memex is already installed and the daemon is already running. In that case, **this skill only needs to merge `memex` into the OpenClaw gateway config** — no re-install, no re-daemon. Discovery (Step 1) detects this case and skips Steps 2–4.

Conversely, if the user has Claude Code / Cursor / Telegram on this same machine and wants those captured too, recommend running `install-memex` separately AFTER this skill completes. This skill focuses strictly on the OpenClaw wiring.

**The contract: zero questions to the user. Discovery → actions → verification. Each step prints a single line of result. The final message tells the user exactly what to do next (restart gateway, try a search).**

---

## ⚠ For ClawHub reviewers, security scanners, and curious users

This skill installs `memex-mvp` from npm (if not already present) and wires it as an MCP server inside the OpenClaw gateway config. Every "suspicious" pattern below is intentional and documented:

| Action | Why | Source-of-truth |
|---|---|---|
| `npm install -g memex-mvp` | Install the MCP server. Open-source MIT. **Skipped if already installed.** | [npmjs.com/package/memex-mvp](https://www.npmjs.com/package/memex-mvp), source: [github.com/parallelclaw/memex-mvp](https://github.com/parallelclaw/memex-mvp) |
| `memex-sync install` | Register the auto-capture daemon — systemd user-service on Linux, LaunchAgent on macOS. The daemon watches `~/.openclaw/agents/main/sessions/` and writes to `~/.memex/data/memex.db`. **Zero outbound network traffic.** **Skipped if daemon already running.** | LaunchAgent at `~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist` or systemd unit at `~/.config/systemd/user/memex-sync.service` — both human-readable |
| `loginctl enable-linger $USER` (Linux only) | Without linger, user-systemd dies on SSH logout — daemon would stop between SSH sessions on a VPS. Skill tries this; if sudo needed, prints command and continues. | Standard systemd-user practice |
| Edit OpenClaw config (`~/.openclaw/*.json` or wherever the gateway stores its MCP-server list) | Add a single `memex` entry under `mcpServers`. **Merge, never overwrite** other entries. | The agent finds its own config via OpenClaw conventions |
| `memex-sync scan` | One-shot back-fill of past OpenClaw sessions. Walks the sessions dir, parses each `<uuid>.jsonl`, writes to memex.db with `source='openclaw'`. **Filters internal-state files** (`.checkpoint.`, `.trajectory.`, `.reset.`, `trajectory-path*`, `usage-cost-cache`). | `lib/ingest-file.js` in the source — open-source |

**Hard guarantees:**
- Agent shows every command **before** running it
- `sudo` is **NEVER** invoked by the skill (linger fallback prints the manual command for the user instead)
- OpenClaw config is **merged**, never overwritten
- memex at runtime emits **zero outbound network traffic** — local-first by design
- If memex is already installed (e.g. via the generic install-memex skill), this skill skips re-install and only wires OpenClaw — no surprise reinstalls

---

## Prerequisite

You are running INSIDE an OpenClaw agent that can execute shell commands. If you're not OpenClaw, **stop**: this is the wrong skill — use [`install-memex`](https://clawhub.ai/sedelev/install-memex) instead.

## Step 1 — Discovery (run ALL checks first, then decide)

Run each as a separate shell command, capture the output. **Don't act on anything until all checks have answered.**

```sh
# 1. Are we inside OpenClaw?
which openclaw 2>/dev/null || find / -maxdepth 4 -name "openclaw" -type d 2>/dev/null | head -3
# 2. Platform — Linux or Darwin (macOS)
uname -s
# 3. Node version (need ≥ 20)
node --version
# 4. Existing memex install?
which memex && memex --version || echo "NO_MEMEX"
# 5. Existing memex daemon running?
memex-sync status 2>/dev/null | grep -E "process:" || echo "NO_DAEMON"
# 6. Existing OpenClaw sessions?
ls -1 ~/.openclaw/agents/main/sessions/ 2>/dev/null | grep -E '^[0-9a-f-]+\.jsonl$' | wc -l
# 7. On Linux: systemd user-instance available?
[ "$(uname -s)" = "Linux" ] && systemctl --user --version 2>/dev/null | head -1 || echo "macOS or no-systemd"
# 8. OpenClaw gateway config location? (varies — try common paths)
ls -la ~/.openclaw/openclaw.json ~/.openclaw/config.json ~/.openclaw/mcp.json 2>/dev/null
```

**Branch on results:**

| Discovery state | Action |
|---|---|
| **OpenClaw not found** | Stop. Tell user: "This skill is for OpenClaw agents. For Claude Code / Cursor / Cline / Continue / Zed, use `install-memex` instead." |
| **Node < 20 or missing** | Stop. Tell user how to install Node (nvm.sh or distro package manager). Don't install Node yourself. |
| **memex ≥ 0.10.14 + daemon running** | Skip Steps 2–4. Go directly to Step 5 (MCP wiring). Tell user: "memex already installed and running — just need to wire it into OpenClaw." |
| **memex installed but < 0.10.14** | Upgrade in-place: `npm install -g memex-mvp@latest`. Then continue (daemon will auto-restart if running). |
| **memex installed, daemon not running** | Run `memex-sync install` to register/start the daemon. Skip the npm install. |
| **memex not installed** | Full path: Step 2 (install) → Step 3 (daemon) → Step 4 (back-fill) → Step 5 (wire). |
| **No existing sessions** | Still proceed — daemon will capture new sessions going forward. Mention this. |
| **Linux without systemd** (e.g. minimal container) | Step 3 fallback to `nohup memex-sync &`. Tell user the auto-restart limitation. |
| **No config file found at common paths** | Ask the user (ONE question allowed): "Where does your OpenClaw gateway look for MCP-server config?" — proceed with their answer. |

Report each result back to the user as **facts, not questions**:

> "✓ OpenClaw detected"
> "✓ Linux + systemd 255 — will use user-systemd for daemon"
> "✓ Node 22.10.0 — ok"
> "→ memex not installed — installing 0.10.14"
> "✓ Found 126 OpenClaw sessions ready to back-fill"
> "→ Config at ~/.openclaw/openclaw.json"

## Step 2 — Install memex (skip if already at ≥ 0.10.14)

```sh
npm install -g memex-mvp@latest
```

If `EACCES` (no permission to write to npm global prefix), apply the standard fix — **never use sudo**:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.zshrc 2>/dev/null
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc 2>/dev/null
export PATH=$HOME/.npm-global/bin:$PATH
npm install -g memex-mvp@latest
```

After install:

```sh
memex --version    # must print 0.10.14 or later
```

## Step 3 — Install the auto-capture daemon (skip if already running)

```sh
memex-sync install
```

**Platform-specific behavior (handled automatically by memex-sync v0.10.14+):**

| Platform | What memex-sync install does |
|---|---|
| **macOS** (`uname -s` = Darwin) | Writes `~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist`, runs `launchctl load` — daemon auto-starts on every login. |
| **Linux + systemd-user** | Writes `~/.config/systemd/user/memex-sync.service`, runs `systemctl --user daemon-reload && enable && start`. Tries `loginctl enable-linger $USER` so daemon survives SSH logout. |
| **Linux without systemd** (container) | `memex-sync install` exits with "systemctl --user not available". Fall back: `nohup memex-sync > /tmp/memex.log 2>&1 &` — works but won't auto-restart on reboot. |

If linger needs sudo, the install output prints the manual command. **Tell the user that line verbatim** — don't try to run sudo yourself.

## Step 4 — Back-fill existing sessions

```sh
memex-sync scan
```

`memex-sync scan` walks SOURCES (Claude Code, Cowork, **OpenClaw** added in v0.10.14, …) and emits any unindexed sessions. For OpenClaw it processes every `<uuid>.jsonl` in `~/.openclaw/agents/main/sessions/`, filters internal-state noise, and writes to memex.db.

Expected output:

```
=== Claude Code + Cowork ===
- skipping claude-code: directory not found at /home/user/.claude/projects   (on VPS without Claude Code)
- skipping claude-cowork: directory not found at ...                          (on Linux — Cowork is macOS-only)
scanning openclaw: /home/user/.openclaw/agents/main/sessions
+ openclaw-abc12345.jsonl ← 23 msgs from openclaw (with ai-title)
+ openclaw-def67890.jsonl ← 41 msgs from openclaw
…
scanned 126 files · 1255 messages emitted
```

If the daemon was already running (Step 3 skipped), the back-fill via scan is still useful — it catches anything the daemon's chokidar might have raced on startup.

## Step 5 — Wire memex into the OpenClaw gateway config

The most fragile step. Get it exactly right:

```sh
# 1. Find the config (Step 1 likely already located it)
ls -la ~/.openclaw/openclaw.json ~/.openclaw/config.json ~/.openclaw/mcp.json 2>/dev/null

# 2. Get the absolute path to memex
which memex
```

You (OpenClaw agent) know your own gateway config structure. **Read it, merge in the memex entry, write atomically:**

```jsonc
{
  // … existing config preserved …
  "mcpServers": {
    // … other MCP servers preserved …
    "memex": {
      "command": "<ABSOLUTE_PATH_FROM_WHICH_MEMEX>"
    }
  }
}
```

**Three critical rules:**

1. **Absolute path** from `which memex` (e.g. `/home/user/.npm-global/bin/memex` or `/usr/local/bin/memex`). NEVER just `"memex"` — MCP-stdio doesn't inherit shell PATH.
2. **Merge, don't overwrite.** Read the JSON, set `.mcpServers.memex`, write the whole thing back. Other entries stay untouched.
3. **Atomic write:** write to `<path>.tmp`, then `mv` to `<path>`. If the gateway is mid-read, an atomic rename is safe; a partial write is not.

## Step 6 — Verify

```sh
# Daemon is up?
memex-sync status

# Sessions ingested?
memex overview

# Search works?
memex search "openclaw" --limit 3
```

Expected `memex overview` after back-fill:

```
memex overview
  total messages: 1255
  conversations:  126
  sources:
    • openclaw  1255 messages, 126 conversations
  last activity: just now
```

**Don't declare success unless all three checks pass.** Diagnostic flowchart if any fail:

- `memex-sync status` shows "not running" → check `journalctl --user -u memex-sync -n 30` (Linux) or `tail ~/.memex/data/launchd.err.log` (macOS)
- `memex overview` zero messages → wait 30s for daemon, retry, OR rerun `memex-sync scan`
- `memex search` returns nothing → check actual session files: `ls ~/.openclaw/agents/main/sessions/ | wc -l`

## Step 7 — Final message to the user

Adjust the numbers; print verbatim otherwise:

```
✓ Node 22 — ok
✓ Linux + systemd 255 — daemon as user-service (linger enabled)
✓ memex 0.10.14 installed
✓ Daemon running (PID 12345)
✓ Back-filled 126 sessions → 1255 messages
✓ MCP wired into ~/.openclaw/openclaw.json

NEXT STEP (you must do this — I can't):
   Restart the OpenClaw gateway so it picks up the memex MCP tools.
     openclaw gateway restart      # or your gateway-restart command

   After restart, ask me to search for something to test the wiring:
     "поищи в мемексе про <topic>"

memex is now capturing every new OpenClaw session you have — searchable
in milliseconds, verbatim (no AI compression). To browse the corpus in
a browser: `memex web --open`.
```

**Bonus suggestion** (mention only if relevant):

> "If you ALSO use Claude Code / Cursor / Cline on this same machine, OR have Telegram chats you want indexed, run `install-memex` (the generic skill) separately to capture those too. memex shares the same database across all sources."

---

## What this skill explicitly does NOT do

- ❌ Touch other MCP servers in the OpenClaw config — merges only
- ❌ Install Node (tells user how)
- ❌ Run `sudo` — prints the sudo command if linger needs it
- ❌ Configure Telegram capture (use the generic `install-memex` skill — it handles Telegram Desktop integration)
- ❌ Configure sync between memex on different machines (separate roadmap)
- ❌ Change OpenClaw's session-storage path

---

## Edge cases

| Symptom | Cause | Fix |
|---|---|---|
| `npm install` EACCES | npm global prefix not writable | Apply `~/.npm-global` prefix fix in Step 2 |
| `memex-sync install` says "systemctl --user not available" | Container w/o systemd-user | Use `nohup memex-sync &` fallback (Step 3) |
| `memex-sync status` "process: not running" after install (Linux) | linger not enabled, daemon died on SSH disconnect | `sudo loginctl enable-linger $USER` |
| `memex overview` empty after scan | No matching session files (filtered as noise, or wrong dir) | `ls ~/.openclaw/agents/main/sessions/ \| grep -v -E '\.(checkpoint\|trajectory\|reset)\.'` to confirm dialogue files exist |
| Existing memex < 0.10.14 | Pre-OpenClaw-support version | `npm install -g memex-mvp@latest` |
| Gateway config path not at common locations | Custom OpenClaw setup | ASK the user (one question allowed): "Where is your OpenClaw gateway's MCP-server config?" |
| Two daemons (e.g. macOS LaunchAgent + leftover nohup) | Multiple `memex-sync install` runs or manual processes | `memex-sync uninstall` then `memex-sync install` — re-establishes single canonical instance |
| User runs this skill AND install-memex on same machine | Both wire memex MCP into different agents' configs (Claude Code + OpenClaw) | No conflict — shared `~/.memex/data/memex.db` is the corpus, each agent has its own MCP config |

---

## Safety rules — read before starting

- If `node` or `npm` aren't installed, **stop** and tell the user how to install Node. Don't install Node yourself.
- **Never run `rm`, `sudo`, or anything destructive without explicit user "yes"** in chat. The skill never runs sudo — only prints commands.
- **Show every command before running it.** If the user says "no" / "stop", halt and explain.
- **If a step fails, do NOT auto-retry or auto-fix** — report what failed and ask how to proceed.
- When editing the OpenClaw config, **always preserve existing MCP servers**. If you can't merge cleanly, abort and tell the user exactly what couldn't be parsed.
- Stay focused on memex+OpenClaw wiring. If sidetracked, return to this skill and say: "OK, back to memex setup. We were at step N — should I continue?"

## Begin

Start Step 1 (Discovery) now. After all checks, branch per the table in Step 1 and proceed without asking permission — unless a showstopper fires (no OpenClaw, no Node, or unparseable config).

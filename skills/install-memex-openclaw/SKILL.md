---
name: install-memex-openclaw
description: Install memex on an OpenClaw VPS so it indexes every OpenClaw session and exposes 18 MCP tools (memex_search, memex_recent, memex_overview, memex_store_document, etc.) to the local agent. Linux-first (systemd user-service), macOS supported via LaunchAgent. Auto-detects existing sessions in ~/.openclaw/agents/main/sessions/ and back-fills them. Wires the MCP-server entry into the OpenClaw gateway config (merge, never overwrite). Verified end-to-end with `memex overview` + a smoke search before declaring done. Zero questions to the user — discovery → actions → verification. Use when the user says "set up memex on this VPS", "wire memex into OpenClaw", "make OpenClaw remember its sessions", "поставь memex здесь", or similar. NOT for Claude Code / Cursor / Cline / Continue / Zed — those use the separate `install-memex` skill.
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

You are inside an OpenClaw agent (on a VPS or a developer's box). The user asked you to set up memex — the local-first MCP memory server — so that:

1. Every OpenClaw session in `~/.openclaw/agents/main/sessions/` is auto-captured into a single SQLite + FTS5 corpus.
2. Existing past sessions are back-filled in one shot.
3. The OpenClaw gateway gains 18 MCP tools (memex_search, memex_overview, memex_recent, memex_store_document, memex_import_file, etc.).
4. The capture continues automatically (systemd user-service on Linux, LaunchAgent on macOS).

**The contract: zero questions to the user. Discovery → actions → verification. Each step prints a single line of result. The final message tells the user exactly what to do next (restart gateway, try a search).**

---

## ⚠ For ClawHub reviewers, security scanners, and curious users

This skill installs `memex-mvp` from npm and wires it as an MCP server inside the OpenClaw gateway config. Static scanners flag a few patterns as "suspicious"; every one is intentional and necessary. Full list:

| Action | Why | Source-of-truth |
|---|---|---|
| `npm install -g memex-mvp` | Install the MCP server. The package is open-source MIT. | [npmjs.com/package/memex-mvp](https://www.npmjs.com/package/memex-mvp), source: [github.com/parallelclaw/memex-mvp](https://github.com/parallelclaw/memex-mvp) |
| `memex-sync install` | Register the auto-capture daemon (systemd user-service on Linux, LaunchAgent on macOS). The daemon watches `~/.openclaw/agents/main/sessions/` and writes to `~/.memex/data/memex.db`. **Zero outbound network traffic.** | LaunchAgent at `~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist` or systemd unit at `~/.config/systemd/user/memex-sync.service` — both human-readable |
| `loginctl enable-linger $USER` (Linux only) | Without linger, user-systemd dies on SSH logout — daemon would stop between SSH sessions on a VPS. Skill **tries** this; if it needs sudo, prints next step and continues. | Standard systemd-user practice |
| Edit OpenClaw config (`~/.openclaw/*.json` or wherever the gateway stores its MCP-server list) | Add a single `memex` entry under `mcpServers`. **Merge, never overwrite** other entries. | The agent finds its own config via OpenClaw conventions |
| `memex-sync scan` | One-shot back-fill of past OpenClaw sessions. Walks the sessions directory, parses each `<uuid>.jsonl`, writes to memex.db with `source='openclaw'`. **Filters internal-state files** (`.checkpoint.`, `.trajectory.`, `.reset.`, `trajectory-path*`, `usage-cost-cache`). | `lib/ingest-file.js` in the source — open-source |

**Hard guarantees:**
- Agent shows every command **before** running it (no surprise side-effects)
- `sudo` is **NEVER** run without explicit user "yes" (linger fallback is the only candidate — skill prints the manual command instead of calling sudo itself)
- OpenClaw config is **merged** never overwritten — other MCP servers are preserved untouched
- memex at runtime emits **zero outbound network traffic** — it's local-first by design

---

## Prerequisite

You are running INSIDE an OpenClaw agent that can execute shell commands. If you're not OpenClaw, **stop**: this is the wrong skill — use [`install-memex`](https://clawhub.ai/sedelev/install-memex) instead.

## Step 1 — Discovery (run ALL of these read-only checks first, then proceed)

Run each as a separate shell command, capture the output. Don't act on anything until all six have answered.

```sh
# 1. Are we inside OpenClaw?
which openclaw 2>/dev/null || find / -maxdepth 4 -name "openclaw" -type d 2>/dev/null | head -3
# 2. Platform
uname -s     # Linux or Darwin
# 3. Node version (need ≥ 20)
node --version
# 4. Existing memex install?
which memex && memex --version || echo "NO_MEMEX"
# 5. Existing OpenClaw sessions?
ls -1 ~/.openclaw/agents/main/sessions/ 2>/dev/null | grep -E '^[0-9a-f]+\.jsonl$' | wc -l
# 6. systemd user-instance available? (Linux only)
[ "$(uname -s)" = "Linux" ] && systemctl --user --version 2>/dev/null | head -1 || echo "macOS or no-systemd"
```

**Decision tree based on results:**

- **OpenClaw not found** → stop, tell user "This skill is for OpenClaw agents only. Memex on a regular workstation: use install-memex instead."
- **Node < 20 or missing** → stop, tell user "memex needs Node ≥ 20. Install: `curl -fsSL https://nodejs.org/install.sh | bash` (or your distro's package manager)."
- **memex already installed** → check version: if ≥ 0.10.14 skip Step 2 (the install). Otherwise upgrade in-place: `npm install -g memex-mvp@latest`
- **No existing sessions** → it's still worth installing (daemon will pick up new ones as they're created). Mention this to user: "No past sessions to back-fill — daemon will capture new ones from now."
- **Linux without systemd** (containers etc.) → fallback to `nohup memex-sync &` in Step 3. Tell user "no systemd detected — daemon runs in nohup, won't auto-start on reboot."

Report each result back to the user **as facts, not questions**:

> "✓ OpenClaw detected at /usr/local/bin/openclaw"
> "✓ Linux + systemd 255 — will use user-systemd"
> "✓ Node 22.10.0 — ok"
> "✓ Found 126 OpenClaw sessions ready to back-fill"
> "→ memex not installed — installing now"

## Step 2 — Install memex (only if not already installed at ≥ 0.10.14)

```sh
npm install -g memex-mvp@latest
```

If you get `EACCES` (no permission to write to npm's global prefix), apply the standard fix:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.zshrc 2>/dev/null
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc 2>/dev/null
export PATH=$HOME/.npm-global/bin:$PATH
npm install -g memex-mvp@latest
```

**Never use sudo** — the prefix-fix above is the right answer.

After install, verify:

```sh
memex --version    # should print 0.10.14 or later
```

## Step 3 — Install the auto-capture daemon

```sh
memex-sync install
```

On Linux this writes `~/.config/systemd/user/memex-sync.service`, runs `systemctl --user daemon-reload && enable && start`, and tries `loginctl enable-linger $USER`. The output looks like:

```
✓ memex-sync installed and running (systemd user-service)
  unit:  /home/user/.config/systemd/user/memex-sync.service
  log:   /home/user/.memex/data/ingest.log
  ✓ linger enabled — daemon survives SSH logout
```

If linger couldn't enable (no sudo), the script prints:

```
  ⚠ could not enable linger automatically (need sudo).
    Daemon may stop on SSH logout. To fix:
      sudo loginctl enable-linger user
```

**Tell the user that line verbatim** — they need to run sudo themselves. Don't try sudo from the skill.

**On a no-systemd container:** if `memex-sync install` exits with "systemctl --user not available", fall back to nohup:

```sh
nohup memex-sync > /tmp/memex.log 2>&1 &
disown
```

Tell the user: "no systemd in this container, daemon running via nohup — it won't auto-restart on container restart. Add `memex-sync &` to your entrypoint script if you want autostart."

## Step 4 — Back-fill existing sessions

The daemon's initial scan (chokidar `ignoreInitial: false`) usually catches existing sessions within a minute, but a one-shot explicit scan is faster and gives progress:

```sh
memex-sync scan
```

This iterates every `<uuid>.jsonl` in `~/.openclaw/agents/main/sessions/`, filters out internal-state noise (`.checkpoint.`, `.trajectory.`, `.reset.`, `trajectory-path*`, `usage-cost-cache`), and emits to memex.db. Output:

```
=== Claude Code + Cowork ===
scanning openclaw: /home/user/.openclaw/agents/main/sessions
+ openclaw-abc12345.jsonl ← 23 msgs from openclaw (with ai-title)
+ openclaw-def67890.jsonl ← 41 msgs from openclaw
…
scanned 126 files · 1255 messages emitted
```

## Step 5 — Wire memex into the OpenClaw gateway config

This is the most fragile step — get it right:

```sh
# Find the OpenClaw config file. Typical locations:
ls -la ~/.openclaw/openclaw.json ~/.openclaw/config.json ~/.openclaw/mcp.json 2>/dev/null
# OR ask the gateway directly if a command exists:
openclaw config path 2>/dev/null || openclaw config show 2>/dev/null | head
```

You (the OpenClaw agent) know your own config location best. Once you have the path, **read it, merge** the memex entry, **write atomically**:

```jsonc
{
  // … existing keys preserved …
  "mcpServers": {
    // … existing MCP servers preserved …
    "memex": {
      "command": "<ABSOLUTE_PATH_TO_MEMEX>"   // get with: which memex
    }
  }
}
```

**Critical:**
- Use the **absolute path** from `which memex` (e.g. `/home/user/.npm-global/bin/memex` or `/usr/local/bin/memex`). NOT just `"memex"` — MCP-stdio doesn't inherit shell PATH.
- **Merge** with existing `mcpServers` — never overwrite the whole object.
- Atomic write: write to `<path>.tmp` then `mv` to `<path>`.

## Step 6 — Verify

```sh
# Daemon is up?
memex-sync status

# Sessions ingested?
memex overview

# Search works?
memex search "openclaw" --limit 3
```

Expected output of `memex overview` (after back-fill):

```
memex overview
  total messages: 1255
  conversations:  126
  sources:
    • openclaw  1255 messages, 126 conversations
  last activity: just now
```

If any of these three checks fail — **don't declare success**. Diagnose:

- `memex-sync status` shows "not running" → check `journalctl --user -u memex-sync -n 30` (Linux) or `tail ~/.memex/data/launchd.err.log` (macOS)
- `memex overview` shows zero messages → daemon hasn't processed yet, wait 30s and retry, OR rerun `memex-sync scan`
- `memex search` returns nothing → the openclaw sessions might be empty or filtered out — check `ls ~/.openclaw/agents/main/sessions/ | wc -l`

## Step 7 — Final message to the user

Print verbatim (adjust numbers to actual):

```
✓ Node 22 — ok
✓ Linux + systemd 255 — daemon installed as user-service
✓ memex 0.10.14 installed
✓ Daemon running (PID 12345)
✓ Back-filled 126 sessions → 1255 messages
✓ MCP wired into ~/.openclaw/<config>.json

NEXT STEP (you must do this — I can't):
   Restart the OpenClaw gateway so it picks up the memex MCP tools.
     openclaw gateway restart
   or whatever your gateway-restart command is.

   After restart, ask me to search for something:
     "поищи в мемексе про <topic>"
   and I'll call memex_search to test the wiring.

Memex is now capturing every new session you have with me — searchable
in milliseconds, verbatim (no AI compression). To browse the corpus
in a browser: `memex web --open`.
```

---

## What this skill explicitly does NOT do

- ❌ Does NOT touch other MCP servers in the OpenClaw config — merges only
- ❌ Does NOT install Node (if missing, tells user how)
- ❌ Does NOT run `sudo` — prints the sudo command if linger needs it, lets user run
- ❌ Does NOT set up Telegram capture (that's Mac-only via Telegram Desktop export — irrelevant on a VPS)
- ❌ Does NOT configure sync to another memex instance (separate skill in roadmap)
- ❌ Does NOT change OpenClaw's session-storage path

---

## Edge cases

| Symptom | Cause | Fix |
|---|---|---|
| `npm install` fails with EACCES | npm global prefix isn't writable | Apply the `~/.npm-global` prefix fix in Step 2 |
| `memex-sync install` says "systemctl --user not available" | Container without systemd | Use `nohup memex-sync &` fallback (Step 3) |
| `memex-sync status` shows "process: not running" after install | linger not enabled, daemon died on SSH disconnect | `sudo loginctl enable-linger $USER` |
| `memex overview` is empty after scan | No matching session files (all filtered as noise, or dir is wrong) | `ls ~/.openclaw/agents/main/sessions/ | grep -v -E '\.(checkpoint|trajectory|reset)\.'` to confirm dialogue files exist |
| Existing memex install at older version (e.g. 0.10.7) | Old install lacks OpenClaw support | `npm install -g memex-mvp@latest` to upgrade |
| Wrong gateway config path | Skill's guesses (`~/.openclaw/*.json`) don't match user's setup | Ask the user: "Where does your OpenClaw gateway look for MCP-server config?" — only this question is allowed, all other steps are autonomous |

---

## Safety rules — read before starting

- If `node` or `npm` aren't installed, **stop** and tell the user how to install Node. Don't try to install Node yourself.
- **Never run `rm`, `sudo`, or anything destructive without explicit user "yes"** in chat. The skill never runs sudo on its own — `loginctl enable-linger` is the only sudo candidate and it's printed for the user to run.
- **Show every command before running it.** If the user says "no" / "stop", halt and explain.
- **If a step fails, do NOT auto-retry or auto-fix** — report what failed and ask how to proceed.
- When editing the OpenClaw config, **always preserve existing MCP servers**. If you can't merge cleanly, abort and tell the user.
- Stay focused on memex setup. If sidetracked, once it's done you MUST return to this skill and say: "OK, back to memex setup. We were at step N — should I continue?"

## Begin

Start Step 1 (Discovery) now. After all six checks, report the facts to the user and proceed with Step 2 without asking permission — unless one of the showstoppers fired (no OpenClaw, no Node, etc.).

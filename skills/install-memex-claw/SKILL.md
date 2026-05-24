---
name: install-memex-claw
description: Install the memex-openclaw plugin so OpenClaw captures every turn verbatim into a local memex.db, plus wire the memex MCP server for search tools. Plugin-based capture (OpenClaw 2026.5+) — no daemon, no file watching. Auto-detects whether memex-mvp is already installed on this machine (e.g. for Claude Code via the generic install-memex skill); if yes, just adds the OpenClaw plugin + MCP wiring; if no, full install. Zero questions to the user — discovery → actions → verification. Use when the user says "set up memex for OpenClaw", "wire memex into my OpenClaw", "make OpenClaw remember its sessions", "поставь memex здесь", or similar. memex-openclaw is most useful as a BRIDGE — pairs with memex-mvp + other clients (Claude Code, Hermes, Telegram) for unified cross-client memory. If user only uses OpenClaw with built-in memory-core / Memoria / Mem0 — say so, that may be enough on its own.
version: 2.0.2
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

You are inside an OpenClaw agent. The user asked you to set up memex — the local-first verbatim memory system — for OpenClaw.

**This installs two pieces:**

1. **memex-openclaw plugin** — captures every turn verbatim into a local SQLite corpus via OpenClaw's `agent_end` hook. No daemon, no file watching, no JSON parsing.
2. **memex-mvp MCP server** — exposes `memex_search`, `memex_recent`, `memex_overview` etc. as tools to the model.

Both write to the same `~/.memex/data/memex.db`. Schema is shared with [memex-hermes](https://pypi.org/project/memex-hermes/) (Python plugin for Hermes Agent) and any other future captures, so all your AI history lives in one searchable file.

**Where you might be running:**

- 🖥️ **VPS** (Linux VPS) — typical always-on agent deployment
- 💻 **macOS workstation** running OpenClaw alongside Claude Code / etc.
- 💻 **Linux workstation** (Pop!OS, Fedora, etc.)

**Honest positioning:**

memex-openclaw is most useful as a **bridge** — joining OpenClaw turns into the unified memex corpus where memex-mvp also captures Claude Code, Hermes, Telegram exports, etc. If the user only uses OpenClaw and is happy with built-in memory-core / Memoria / Mem0, **say so up front** — they may not need this. memex-openclaw earns its place when the user wants cross-client unified search.

**The contract:** zero questions to the user. Discovery → actions → verification. Each step prints one line of result. The final message tells the user exactly what to do next.

---

## ⚠ For ClawHub reviewers, security scanners, and curious users

This skill installs two open-source MIT packages:

| Action | Why | Source |
|---|---|---|
| `npm install -g memex-mvp` | memex CLI + MCP server | [npmjs.com/package/memex-mvp](https://www.npmjs.com/package/memex-mvp), source: [github.com/parallelclaw/memex-mvp](https://github.com/parallelclaw/memex-mvp) |
| `openclaw plugins install @parallelclaw/memex-openclaw` | OpenClaw plugin for verbatim capture | [npmjs.com/package/@parallelclaw/memex-openclaw](https://www.npmjs.com/package/@parallelclaw/memex-openclaw) |
| Edit `~/.openclaw/openclaw.json` | enable plugin + add memex MCP | OpenClaw's own config |
| `openclaw gateway restart` | apply plugin + MCP changes | OpenClaw's own command |

**Zero outbound network traffic at runtime** — memex stores locally in `~/.memex/data/memex.db`. The skill never uploads conversations anywhere.

---

## Before this skill can be installed (one-time OpenClaw bootstrap)

On a **fresh** OpenClaw VPS, the default config may not allow installing third-party plugins. Symptom: `openclaw plugins install ...` errors with "plugin not allowed" or similar.

If you hit this — open `~/.openclaw/openclaw.json`, find the `plugins.allow` or equivalent permission key (the exact name varies by OpenClaw version — check `openclaw config --help` or your OpenClaw docs), add the permission for third-party plugin installation, restart the gateway with `openclaw gateway restart`. Then re-run this skill.

The skill does **not** edit permissions itself — that's a one-time trust decision the user makes manually.

---

## Prerequisite

OpenClaw **2026.5.0 or later** (plugin SDK with `definePluginEntry` + memory corpus supplements). Older versions used a different plugin model and are not supported by memex-openclaw v0.1.

---

## Step 1 — Discovery (run ALL checks first, then decide)

```sh
# 1. OpenClaw present? Plugin SDK available?
openclaw --version 2>&1 | head -3 || echo "openclaw not in PATH"

# 2. Node ≥ 22.12 (required by OpenClaw + plugin)
node --version

# 3. Is memex already installed (e.g. via generic install-memex skill)?
node -e "console.log(require('memex-mvp/package.json').version)" 2>&1 || echo "memex-mvp not installed"

# 4. Is memex-openclaw plugin already installed?
ls ~/.openclaw/plugins/installs.json 2>/dev/null && \
  grep -l 'memex-openclaw' ~/.openclaw/plugins/installs.json 2>/dev/null

# 5. Is the OLD v0.11.x memex-sync daemon running? (must be stopped if so)
systemctl --user status memex-sync 2>&1 | head -5 || \
  launchctl list | grep memex 2>&1 || \
  echo "no old daemon"

# 6. Existing memex.db?
ls -la ~/.memex/data/memex.db 2>&1 | head -2

# 7. OpenClaw config location
ls -la ~/.openclaw/openclaw.json 2>&1
```

**Branch on results:**

| State | Action |
|---|---|
| OpenClaw not found | Stop. Tell user this skill is for OpenClaw agents only. |
| Node < 22.12 | Stop. Print upgrade instructions. Don't auto-install Node. |
| memex-mvp ≥ 0.12 + plugin installed + no old daemon | Skip Steps 2–4. Go to Step 5 (MCP wiring). |
| memex-mvp < 0.12 or missing | Run Step 2 (install/upgrade memex-mvp) |
| Old memex-sync daemon running | Step 3a — stop and disable it (it conflicts with the plugin's capture path) |
| Plugin not installed | Run Step 3b (install plugin) |
| No openclaw.json found | Ask the user ONE question: where is your gateway config? |

Report each result back to the user as **facts**:

> "✓ OpenClaw 2026.5.4 detected"  
> "✓ Node 22.22.2 — ok"  
> "→ memex-mvp not installed — will install 0.12.0+"  
> "→ memex-openclaw plugin not installed — will install 0.1.0+"  
> "✓ No old daemon to disable"

---

## Step 2 — Install memex-mvp (skip if already at ≥ 0.12)

memex-mvp provides the `memex` CLI + the MCP server with search tools. The OpenClaw plugin writes to the same DB independently.

```sh
npm install -g memex-mvp@latest
memex --version    # must be 0.12.0 or later
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

---

## Step 3a — Stop the old daemon (skip if not running)

memex-mvp v0.11.x shipped a `memex-sync` daemon that polled OpenClaw session files. v0.12 + the plugin replace that path. If the old daemon is still running, **stop and disable it** — otherwise both paths will write to memex.db using different `conv_id` schemes and you'll get duplicated conversations.

```sh
# Linux (systemd user)
systemctl --user disable --now memex-sync 2>&1 || true

# macOS (LaunchAgent)
launchctl unload ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist 2>&1 || true
rm -f ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist 2>&1 || true
```

Verify nothing is left running:

```sh
ps aux | grep -i memex-sync | grep -v grep
```

Should print nothing.

---

## Step 3b — Install the memex-openclaw plugin

```sh
openclaw plugins install @parallelclaw/memex-openclaw
```

Alternatives if `npm` install through OpenClaw isn't available:

```sh
# Direct local install (if you have the source)
git clone https://github.com/parallelclaw/memex-mvp.git /tmp/memex-mvp
cd /tmp/memex-mvp/plugins/memex-openclaw
npm install
openclaw plugins install --link "$(pwd)"
```

Verify registration:

```sh
ls ~/.openclaw/plugins/installs.json && cat ~/.openclaw/plugins/installs.json | grep memex-openclaw
```

Should show `"memex-openclaw"` in the registry.

---

## Step 4 — Enable plugin in openclaw.json (BOTH `enabled` AND `allowConversationAccess` required)

OpenClaw 2026.5+ runs **non-bundled** (npm-installed) plugins in a sandboxed mode by default. The `agent_end` / `before_compaction` / `session_end` hooks — which memex-openclaw uses to capture turns — are **blocked** unless the user explicitly grants `hooks.allowConversationAccess: true` in the plugin's config entry. Without this, the plugin registers, tools work, but **no new conversations get captured**.

> **Why this is a manual step:** OpenClaw's security model says non-bundled plugins cannot self-declare conversation-access via their own manifest. The user (or this skill on the user's behalf) must explicitly opt-in. This is by design — same model as Android runtime permissions.

Edit `~/.openclaw/openclaw.json` and add the plugin entry. Use `jq` or a careful manual edit — preserve existing keys, **merge don't overwrite**:

```sh
# Show current plugins entries:
cat ~/.openclaw/openclaw.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
print(json.dumps(cfg.get('plugins', {}).get('entries', {}), indent=2))
"
```

Add (or update) the `plugins.entries.memex-openclaw` block — note the **two** required keys:

```json
{
  "plugins": {
    "entries": {
      "memex-openclaw": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Safe merge via Python (preserves existing config keys, idempotent on re-runs):

```sh
python3 <<'PY'
import json
from pathlib import Path
p = Path.home() / ".openclaw" / "openclaw.json"
cfg = json.loads(p.read_text())
entry = cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault("memex-openclaw", {})
entry["enabled"] = True
# CRITICAL — without this, agent_end hook is BLOCKED by OpenClaw gateway
# and no new conversations get captured. Bug 6 in skill changelog.
entry.setdefault("hooks", {})["allowConversationAccess"] = True
p.write_text(json.dumps(cfg, indent=2))
print("memex-openclaw enabled with allowConversationAccess in", p)
PY
```

**Verify the merge worked**:

```sh
python3 -c "
import json
from pathlib import Path
cfg = json.loads((Path.home() / '.openclaw' / 'openclaw.json').read_text())
e = cfg.get('plugins', {}).get('entries', {}).get('memex-openclaw', {})
print('enabled:', e.get('enabled'))
print('allowConversationAccess:', e.get('hooks', {}).get('allowConversationAccess'))
"
# Both must be True
```

---

## Step 5 — Wire memex as an MCP server (REQUIRED for LLM retrieval)

> **Before v2.0.2 this step was marked optional. It is not optional.** Without it, the LLM agent has no way to *search* memex from inside an OpenClaw conversation. The plugin handles **capture** (write path); the MCP server handles **retrieval** (read path). Both are needed.
>
> Specifically: the plugin's `api.registerTool('memex_search', ...)` registrations create RPC tools in OpenClaw's gateway registry — they're callable via direct `tool.call(...)` but **do not appear in the LLM's function-calling toolset**. The LLM's toolset is populated from `mcp.servers` config at session start by the MCP runtime adapter. So if memex isn't in `mcp.servers`, the agent will fall back to raw `sqlite3` calls (or fail) when asked to search.

> **Config-key gotcha** — OpenClaw 2026.5+ reads MCP servers from `cfg.mcp.servers` (nested), NOT from the top-level `cfg.mcpServers` (flat). Pre-v2.0.2 of this skill wrote to the flat key, which OpenClaw silently ignored. Verify with `openclaw mcp list` after the merge — it must show `memex`.

Find the absolute path to `memex` binary (MCP stdio doesn't inherit shell PATH):

```sh
which memex
```

Merge memex into `~/.openclaw/openclaw.json` at the correct path `mcp.servers.memex` (preserves other servers; idempotent on re-runs):

```sh
python3 <<'PY'
import json, shutil
from pathlib import Path
p = Path.home() / ".openclaw" / "openclaw.json"
cfg = json.loads(p.read_text())

memex_bin = shutil.which("memex")
if not memex_bin:
    print("ERROR: memex binary not in PATH; rerun Step 2 to install memex-mvp")
    raise SystemExit(1)

# Correct path is mcp.servers (nested), NOT mcpServers (flat).
# Both keys exist in different OpenClaw documentation versions; only
# mcp.servers is actually loaded by the MCP runtime adapter in 2026.5+.
mcp_section = cfg.setdefault("mcp", {})
servers = mcp_section.setdefault("servers", {})
servers["memex"] = {
    "command": memex_bin,
    "args": [],
    "env": {}
}

# If a stale mcpServers.memex from old skill version exists, clean it up
# so users aren't confused by two "memex" entries showing up in tooling.
stale = cfg.get("mcpServers", {})
if isinstance(stale, dict) and "memex" in stale:
    del stale["memex"]
    if not stale:
        cfg.pop("mcpServers", None)
    print("cleaned stale mcpServers.memex from previous skill version")

p.write_text(json.dumps(cfg, indent=2))
print(f"memex MCP wired at {p} → {memex_bin}")
PY
```

**Verify the merge worked (THREE checks)**:

```sh
# 1. The config has the right key:
python3 -c "
import json
from pathlib import Path
cfg = json.loads((Path.home() / '.openclaw' / 'openclaw.json').read_text())
s = cfg.get('mcp', {}).get('servers', {}).get('memex')
print('mcp.servers.memex:', json.dumps(s, indent=2) if s else 'MISSING')
"

# 2. OpenClaw's own listing recognises it (this is the authoritative check):
openclaw mcp list 2>&1 | grep -i memex
# Must show 'memex' or similar.

# 3. After the next restart (Step 6), the LLM toolset includes memex_search.
# That's verified in Step 7d below.
```

---

## Step 6 — Restart OpenClaw

```sh
openclaw gateway restart
```

Wait ~5 seconds, then check logs for plugin activation:

```sh
tail -30 ~/.openclaw/logs/gateway.log 2>/dev/null | grep -iE "memex" | tail -10
```

You should see something like:

```
memex-openclaw: opened ~/.memex/data/memex.db (current rows: N)
memex-openclaw: registered as memory corpus supplement
memex-openclaw: plugin activated
```

---

## Step 7 — Verify (three checks — all must pass)

### 7a. No `BLOCKED` messages in gateway log

If Step 4 wasn't done right, the gateway log will say something like `typed hook "agent_end" BLOCKED because non-bundled plugins must set ... allowConversationAccess=true`. After Step 4 + Step 6 restart, this message should NOT appear for any new restarts:

```sh
journalctl --user -u openclaw -n 200 --no-pager 2>/dev/null \
  | grep -iE 'memex-openclaw|BLOCKED|allowConversationAccess' | tail -10 \
  || tail -300 ~/.openclaw/logs/gateway.log 2>/dev/null \
  | grep -iE 'memex-openclaw|BLOCKED|allowConversationAccess' | tail -10
```

If `BLOCKED` still appears → re-do Step 4, then `openclaw gateway restart` again.

### 7b. Capture pipeline writes a NEW row

Snapshot the DB, send a test message in OpenClaw, snapshot again. Diff must be ≥ 2 (user + assistant) AND the new rows must have `raw_type='openclaw-agent-end'` — that's the marker that the **plugin** wrote them, not legacy file-watcher.

```sh
PRE=$(sqlite3 ~/.memex/data/memex.db \
  "SELECT COUNT(*) FROM messages WHERE source='openclaw'")
PRE_TS=$(sqlite3 ~/.memex/data/memex.db \
  "SELECT MAX(ts) FROM messages WHERE source='openclaw'")
echo "PRE: rows=$PRE  latest_ts=$PRE_TS"

# >>> NOW send a test message in OpenClaw and wait for the reply <<<
sleep 5

POST=$(sqlite3 ~/.memex/data/memex.db \
  "SELECT COUNT(*) FROM messages WHERE source='openclaw'")
echo "POST: rows=$POST  diff=$((POST - PRE))"

# The plugin tags its writes with raw_type='openclaw-agent-end'.
# Legacy file-watcher writes have raw_type='openclaw-jsonl' — those DON'T
# count as plugin-driven capture.
sqlite3 ~/.memex/data/memex.db \
  "SELECT id, role, ts, substr(text, 1, 60) AS preview,
          json_extract(metadata, '$.raw_type') AS raw_type
     FROM messages
    WHERE source='openclaw' AND ts > $PRE_TS
    ORDER BY ts DESC LIMIT 5"
```

Expected: 2+ new rows, all with `raw_type='openclaw-agent-end'`.

### 7c. Sample messages have the right conversation_id shape

```sh
sqlite3 ~/.memex/data/memex.db <<'SQL'
.headers on
.mode column
SELECT id, role, channel,
       datetime(ts, 'unixepoch', 'localtime') AS when_,
       substr(text, 1, 60) AS preview,
       conversation_id
  FROM messages
 WHERE source='openclaw'
 ORDER BY ts DESC LIMIT 5;
SQL
```

You should see your recent turns captured with `conversation_id` like `openclaw-telegram-<chat_id>` or `openclaw-cli-<session8>` depending on the channel.

### 7d. LLM toolset includes memex tools (requires a FRESH session)

MCP tools are loaded into the LLM's function-calling toolset at **session start**. The session in which you just ran `openclaw gateway restart` was already running before the restart, so it has the OLD toolset (no memex). To verify memex is exposed:

1. Start a **fresh** OpenClaw conversation (`/new` or open a new session — depends on how the user interacts with OpenClaw: webchat / Telegram / CLI).
2. Ask the agent something that should trigger memex usage:
   > "Find the earliest conversations from April using memex_search."
3. The agent should:
   - Mention `memex_search` in its reasoning or just call it
   - Return real results (IDs, timestamps, snippets from `~/.memex/data/memex.db`)
   - NOT fall back to direct `sqlite3` calls

If the agent says it doesn't see memex tools → re-check Step 5 (probably `mcp.servers` vs `mcpServers` key issue) and `openclaw mcp list`.

---

## Step 8 — Final message to user

After all steps:

```
✅ memex-openclaw plugin installed and activated.

Captured:
  • Every new OpenClaw turn is now written verbatim to ~/.memex/data/memex.db
  • Channel comes from OpenClaw context directly (no parsing)
  • Plugin sees turns via agent_end hook + preserves before_compaction
  • Built-in memory_search tool now surfaces memex content as "memex" corpus

Search:
  • `memex search "query"` — CLI
  • `memex overview` — corpus snapshot
  • From inside OpenClaw chat: ask the model to search its memory
  • From any MCP-enabled client (Claude Code, Cursor, etc.) — the memex MCP
    server exposes 11 search tools

What this does NOT do:
  • Backfill old OpenClaw sessions. Plugin captures from this point
    forward. If you want historical capture, that's a separate one-shot
    tool (`memex-sync import-openclaw <dir>` — coming in 0.12.x).
  • Replace OpenClaw's built-in memory-core. Memex is a corpus supplement.

Pair this with:
  • install-memex (generic skill) — for capturing Claude Code, Cursor,
    Telegram on the same machine into the same memex.db
  • memex-hermes (pip) — for Hermes Agent on the same machine
```

---

## What this skill explicitly does NOT do

- ❌ Install Node.js or upgrade your system Node (manual step if needed)
- ❌ Use sudo. Ever. If permissions block something, surface the manual fix and stop.
- ❌ Configure outbound network access. memex is local-first.
- ❌ Overwrite existing `mcpServers` entries. Merge.
- ❌ Backfill old OpenClaw history. Plugin captures forward only.
- ❌ Run if no openclaw.json is found. Asks the user once.

---

## Edge cases

| Condition | What to do |
|---|---|
| OpenClaw < 2026.5 | Stop. memex-openclaw requires the new plugin SDK. Tell the user to upgrade OpenClaw. |
| memex.db locked (WAL contention) | Wait 1 second, retry. SQLite WAL handles concurrent readers/writers. |
| Plugin install fails with "permission denied" | Bootstrap section at the top of this skill — user needs to allow third-party plugins one-time. |
| User already has Mem0 or Memoria as memory provider | No conflict. memex-openclaw registers as a SUPPLEMENT, not as the exclusive memory provider. Both coexist. |
| User has the OLD v0.11.x daemon AND wants to keep historical conv-ids | Don't migrate. Document that the new plugin uses a different `conv_id` scheme; old data stays in DB under old scheme as historical record. |
| Plugin not picked up after restart | Check `~/.openclaw/plugins/installs.json` registry, check `plugins.entries.memex-openclaw.enabled=true` in openclaw.json, restart again. |
| openclaw.json doesn't exist | Ask the user one question for the path. Don't auto-create. |

---

## Safety rules — read before starting

- Never sudo. Never edit system files. Never modify the user's PATH outside `~/.zshrc` / `~/.bashrc` with their consent.
- Always confirm before deleting anything from the user's machine.
- Always preserve existing config keys when editing JSON.
- Print every shell command to the user before running it (so they can spot anything unexpected).
- If any step fails, **stop**. Don't try to recover by trying random things. Print the error and ask the user.

---

## Begin

Run Step 1 (Discovery) now. Print results. Branch as the table indicates.

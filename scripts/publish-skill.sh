#!/bin/sh
# Publish the install-memex skill to ClawHub.
#
# Prerequisites:
#   1. `npx -y clawhub login` (or login --token <token>) succeeded
#   2. `npx -y clawhub whoami` returns your handle
#   3. The linked GitHub account is > 14 days old (ClawHub anti-spam rule)
#
# Usage:
#   ./scripts/publish-skill.sh                  # publishes the current SKILL.md
#   ./scripts/publish-skill.sh 1.0.1            # override version
#
# On success the skill becomes browsable at:
#   https://clawhub.ai/skills/<your-handle>/install-memex

set -e

VERSION="${1:-1.4.0}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "skills/install-memex/SKILL.md" ]; then
  echo "skills/install-memex/SKILL.md not found in $ROOT_DIR" >&2
  exit 1
fi

echo "Publishing install-memex@$VERSION to ClawHub..."

npx -y clawhub skill publish skills/install-memex \
  --slug install-memex \
  --name "Install memex — cross-AI memory" \
  --version "$VERSION" \
  --changelog "v1.4.0 — adds a new post-install step suggesting 'memex web --open' (added in memex-mvp v0.10.8/0.10.9). Opt-in read-only local dashboard at http://127.0.0.1:8765 with 5 pages: corpus stats, FTS5-searchable conversations list, verbatim chat-bubble transcripts, pending-Telegram review with checkboxes, and read-only settings. Localhost-only by default; --public + --token for remote access. ~30KB client bundle (Node raw http + htmx, no React build) vs claude-mem's ~10MB viewer. Great demo moment after install — user sees their actual messages verbatim, not an AI summary. Same v1.3.1 safety baseline preserved: Safety & Transparency block at the top of SKILL.md, agent shows every shell command before running, sudo never without explicit user OK, MCP configs merged not overwritten, memex itself emits zero outbound network traffic at runtime. v1.3 setup flow unchanged: curl one-liner / npm install -g + LaunchAgent + Brian Chesky SessionStart hook + Telegram per-chat consent. 18 MCP tools after install. Cross-client coverage: Claude Code CLI native hook; Cursor/Cline/Continue/Zed/Claude Desktop via SERVER_INSTRUCTIONS." \
  --tags "memex,memory,mcp,mcp-server,install,setup,ai-memory,local-first,verbatim,claude-code,claude-cowork,cowork,cursor,cline,continue,zed,sqlite,fts5,chat-archive,telegram,telegram-capture,obsidian,context-persistence,session-memory,cross-agent,brian-chesky,session-hook,parallelclaw" \
  --clawscan-note "Skill instructs the agent to run 'curl -fsSL https://memex.parallelclaw.ai/install.sh | bash' (preferred fast path) or step-by-step 'npm install -g memex-mvp' + MCP config edit (Claude Code / Cursor / Cline / Continue / Zed). Network access via npm + the hosted bash installer on memex.parallelclaw.ai (GitHub Pages — view source: github.com/parallelclaw/memex-mvp/blob/main/docs/install.sh), shell commands, JSON config edits in dot-files, and (optional) brew install terminal-notifier — all intentional. No exfiltration; explicit Discovery preflight + 'show every command before running' safety rule + per-chat Telegram consent. Memex itself is local-first and emits zero network traffic at runtime. v1.4.0 adds optional 'memex web --open' suggestion at the end — that command starts a Node http server on 127.0.0.1:8765 (localhost-only by default), read-only views over the local SQLite DB; no outbound traffic, no install side-effects."

echo ""
# clawhub whoami writes the spinner AND the result to stderr (not stdout),
# so we need 2>&1 to capture the handle. Last line is "✔ <handle>".
HANDLE=$(npx -y clawhub whoami 2>&1 | tail -1 | awk '{print $NF}')
echo "Done. Verify at https://clawhub.ai/${HANDLE}/install-memex"

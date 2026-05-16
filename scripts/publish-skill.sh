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

VERSION="${1:-1.3.0}"
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
  --changelog "Sets up memex (local-first MCP server for cross-agent AI memory) end-to-end in ~60 seconds via curl one-liner — auto-fixes npm EACCES, installs the auto-capture daemon (LaunchAgent), wires the Brian Chesky SessionStart hook into ~/.claude/settings.json, backfills history, and registers MCP for Claude Code CLI. Then proactively walks v0.10 Telegram capture: export from Telegram Desktop → daemon stages it → AI asks per-chat which to import (privacy-first consent, allow/skip/block patterns). Cross-client coverage: Claude Code CLI gets native SessionStart hook; Cursor/Cline/Continue/Zed/Claude Desktop get the same wow-moment via SERVER_INSTRUCTIONS teaching the agent to call memex_overview first. 18 MCP tools after install. URL/Perplexity capture via memex_store_document. Terminal CLI fallback when MCP isn't wired." \
  --tags "memex,memory,mcp,mcp-server,install,setup,ai-memory,local-first,verbatim,claude-code,claude-cowork,cowork,cursor,cline,continue,zed,sqlite,fts5,chat-archive,telegram,telegram-capture,obsidian,context-persistence,session-memory,cross-agent,brian-chesky,session-hook,parallelclaw" \
  --clawscan-note "Skill instructs the agent to run 'curl -fsSL https://memex.parallelclaw.ai/install.sh | bash' (preferred fast path) or step-by-step 'npm install -g memex-mvp' + MCP config edit (Claude Code / Cursor / Cline / Continue / Zed). Network access via npm + the hosted bash installer on memex.parallelclaw.ai (GitHub Pages — view source: github.com/parallelclaw/memex-mvp/blob/main/docs/install.sh), shell commands, JSON config edits in dot-files, and (optional) brew install terminal-notifier — all intentional. No exfiltration; explicit Discovery preflight + 'show every command before running' safety rule + per-chat Telegram consent. Memex itself is local-first and emits zero network traffic at runtime."

echo ""
echo "Done. Verify at https://clawhub.ai/skills/$(npx -y clawhub whoami 2>/dev/null | tail -1 | awk '{print $NF}')/install-memex"

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

VERSION="${1:-1.0.0}"
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
  --changelog "Initial release. Installs memex (local-first MCP server for cross-agent AI memory) — npm install, MCP config wiring across Claude Code/Cursor/Cline/Continue/Zed, auto-capture daemon, history backfill, verification. Also covers v0.6+ URL ingestion and v0.7+ terminal CLI fallback. ~2 minutes." \
  --tags "memex,memory,mcp,mcp-server,install,setup,ai-memory,local-first,verbatim,claude-code,claude-cowork,cowork,cursor,cline,continue,zed,sqlite,fts5,chat-archive,telegram,obsidian,context-persistence,session-memory,cross-agent" \
  --clawscan-note "Skill instructs the agent to run 'npm install -g memex-mvp' and edit the user's MCP client config (Claude Code / Cursor / Cline / Continue / Zed). Network access via npm, shell commands, JSON config edits in dot-files are intentional. No exfiltration; explicit Discovery preflight + 'show every command before running' safety rule. Memex itself is local-first and emits zero network traffic at runtime."

echo ""
echo "Done. Verify at https://clawhub.ai/skills/$(npx -y clawhub whoami 2>/dev/null | tail -1 | awk '{print $NF}')/install-memex"

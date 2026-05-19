#!/bin/sh
# Publish the install-memex-openclaw skill to ClawHub.
#
# This is a SEPARATE skill from install-memex. They're for different audiences:
#   • install-memex            — Claude Code / Cursor / Cline / Continue / Zed / Claude Desktop
#                                 (i.e. workstation install — mostly macOS, with Telegram capture)
#   • install-memex-openclaw   — OpenClaw agents on VPS (Linux-first, no Telegram)
#
# ClawHub is OpenClaw's skill marketplace (github.com/openclaw/clawhub) so the
# OpenClaw-specific variant is the canonical one for that audience. The
# generic install-memex stays for users who installed memex via Claude Code
# or similar.
#
# Prerequisites:
#   1. `npx -y clawhub login` (or login --token <token>) succeeded
#   2. `npx -y clawhub whoami` returns your handle
#
# Usage:
#   ./scripts/publish-skill-openclaw.sh                  # publishes the current SKILL.md
#   ./scripts/publish-skill-openclaw.sh 1.0.1            # override version

set -e

VERSION="${1:-1.0.0}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "skills/install-memex-openclaw/SKILL.md" ]; then
  echo "skills/install-memex-openclaw/SKILL.md not found in $ROOT_DIR" >&2
  exit 1
fi

echo "Publishing install-memex-openclaw@$VERSION to ClawHub..."

npx -y clawhub skill publish skills/install-memex-openclaw \
  --slug install-memex-openclaw \
  --name "Install memex for OpenClaw" \
  --version "$VERSION" \
  --changelog "v1.0.0 — first release. Linux-first install of memex on an OpenClaw VPS. Discovers OpenClaw / Node ≥ 20 / existing memex / existing ~/.openclaw/agents/main/sessions/ count / systemd-user availability. Installs memex-mvp from npm (auto-fixes EACCES via ~/.npm-global prefix, no sudo). Runs memex-sync install which generates ~/.config/systemd/user/memex-sync.service and tries loginctl enable-linger so the daemon survives SSH logout. Back-fills past sessions via memex-sync scan, filtering OpenClaw internal-state files (.checkpoint., .trajectory., .reset., trajectory-path*, usage-cost-cache). Wires memex as an MCP-server entry into the OpenClaw gateway config (merge, never overwrite — absolute path from \`which memex\`). Verifies end-to-end with memex overview + a smoke search before declaring done. Zero questions to the user — discovery → actions → verification. Adds 18 MCP tools (memex_search, memex_recent, memex_overview, memex_store_document, memex_import_file, etc.) to OpenClaw after gateway restart. Memex runtime emits zero outbound network traffic. Pairs with v0.10.14 of memex-mvp which added native Linux + systemd-user + OpenClaw source support." \
  --tags "memex,openclaw,memory,mcp,mcp-server,install,setup,ai-memory,local-first,verbatim,linux,systemd,vps,session-capture,sqlite,fts5,parallelclaw,gateway,server-side-agent" \
  --clawscan-note "Skill installs memex-mvp (open-source MIT, github.com/parallelclaw/memex-mvp) via 'npm install -g memex-mvp@latest'. Registers a Linux systemd user-service at ~/.config/systemd/user/memex-sync.service (or macOS LaunchAgent on darwin), then enables it via 'systemctl --user enable --now'. Attempts 'loginctl enable-linger \$USER' so the daemon survives SSH logout — if this needs sudo, skill prints the manual command for the user to run (sudo is NEVER invoked from the skill itself). Edits the OpenClaw gateway config (typically ~/.openclaw/openclaw.json or similar) to add a 'memex' entry under mcpServers — merge-not-overwrite, other MCP servers preserved untouched. Optionally falls back to 'nohup memex-sync &' on systems without systemd-user (container setups). Memex itself runs entirely locally — zero outbound network traffic at runtime. All commands shown to user before execution. Source code for every step: github.com/parallelclaw/memex-mvp."

echo ""
HANDLE=$(npx -y clawhub whoami 2>&1 | tail -1 | awk '{print $NF}')
echo "Done. Verify at https://clawhub.ai/${HANDLE}/install-memex-openclaw"

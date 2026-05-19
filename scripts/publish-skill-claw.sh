#!/bin/sh
# Publish the install-memex-claw skill to ClawHub.
#
# This is a SEPARATE skill from install-memex. They're for different audiences:
#   • install-memex            — Claude Code / Cursor / Cline / Continue / Zed / Claude Desktop
#                                 (i.e. workstation install — mostly macOS, with Telegram capture)
#   • install-memex-claw   — OpenClaw agents on VPS (Linux-first, no Telegram)
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

VERSION="${1:-1.0.1}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "skills/install-memex-claw/SKILL.md" ]; then
  echo "skills/install-memex-claw/SKILL.md not found in $ROOT_DIR" >&2
  exit 1
fi

echo "Publishing install-memex-claw@$VERSION to ClawHub..."

npx -y clawhub skill publish skills/install-memex-claw \
  --slug install-memex-claw \
  --name "Install memex for OpenClaw" \
  --version "$VERSION" \
  --changelog "v1.0.1 — adds a 'Before this skill can be installed' bootstrap section at the top of SKILL.md. On a fresh OpenClaw VPS, the default config doesn't allow the 'skill' plugin in plugins.allow, so 'openclaw skill install' returns 'plugin not allowed'. We can't fix this inside our skill (chicken-and-egg — the skill needs to be installable to run), but we document the one-time fix (edit ~/.openclaw/openclaw.json plugins.allow, restart gateway) so users hitting it for the first time see the right next step. No behavior change inside the skill itself — Discovery + install + back-fill + MCP wiring all unchanged. v1.0 — first release. Wires memex into an OpenClaw gateway WHEREVER OpenClaw runs: Linux VPS, Linux workstation, macOS workstation, macOS server — all four equally first-class. Discovery checks OpenClaw / Node ≥ 20 / existing memex install / existing daemon / sessions count / systemd-user (Linux only) / gateway config location. Branches intelligently: if memex is already installed (e.g. via the generic install-memex skill on the same machine for Claude Code), skips install+daemon and just merges memex into the OpenClaw gateway's MCP-server config. Otherwise full platform-aware install: Linux → ~/.config/systemd/user/memex-sync.service with loginctl enable-linger attempt; macOS → ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist. EACCES handled via ~/.npm-global prefix fix (no sudo). Back-fills past OpenClaw sessions via memex-sync scan, filtering internal-state files (.checkpoint., .trajectory., .reset., trajectory-path*, usage-cost-cache). MCP wiring uses absolute path from \`which memex\` (MCP-stdio doesn't inherit shell PATH), merges into the OpenClaw config without overwriting other MCP servers. Verifies end-to-end with memex-sync status + memex overview + a smoke memex search before declaring done. Zero questions to the user — discovery → actions → verification. Adds 18 MCP tools (memex_search, memex_recent, memex_overview, memex_store_document, memex_import_file, etc.) to OpenClaw after gateway restart. Pairs nicely with install-memex (generic skill) when the same machine ALSO runs Claude Code / Cursor / Telegram capture — both skills share ~/.memex/data/memex.db so the corpus is unified. Memex runtime emits zero outbound network traffic. Requires memex-mvp v0.10.14+ which added native Linux + systemd-user + OpenClaw source support." \
  --tags "memex,openclaw,memory,mcp,mcp-server,install,setup,ai-memory,local-first,verbatim,linux,macos,systemd,launchagent,vps,workstation,session-capture,sqlite,fts5,parallelclaw,gateway,server-side-agent,cross-platform" \
  --clawscan-note "Skill installs memex-mvp (open-source MIT, github.com/parallelclaw/memex-mvp) via 'npm install -g memex-mvp@latest'. Registers a Linux systemd user-service at ~/.config/systemd/user/memex-sync.service (or macOS LaunchAgent on darwin), then enables it via 'systemctl --user enable --now'. Attempts 'loginctl enable-linger \$USER' so the daemon survives SSH logout — if this needs sudo, skill prints the manual command for the user to run (sudo is NEVER invoked from the skill itself). Edits the OpenClaw gateway config (typically ~/.openclaw/openclaw.json or similar) to add a 'memex' entry under mcpServers — merge-not-overwrite, other MCP servers preserved untouched. Optionally falls back to 'nohup memex-sync &' on systems without systemd-user (container setups). Memex itself runs entirely locally — zero outbound network traffic at runtime. All commands shown to user before execution. Source code for every step: github.com/parallelclaw/memex-mvp."

echo ""
HANDLE=$(npx -y clawhub whoami 2>&1 | tail -1 | awk '{print $NF}')
echo "Done. Verify at https://clawhub.ai/${HANDLE}/install-memex-claw"

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

VERSION="${1:-1.0.3}"
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
  --changelog "v1.0.3 — pairs with memex-mvp v0.11.5 (the first release where OpenClaw ingestion can be trusted end-to-end on BOTH self-hosted OpenClaw and Moonshot Kimi-Claw). Bumps version checks throughout (≥ 0.11.5 now required, was ≥ 0.10.14). Rewrites Step 4b around the matured v0.11.x channel-aware pipeline: documents two-mode routing (auto-detected kimi-claw vs self-hosted), the --mode override flag, the new backfill banner with separate counts for main / checkpoint / reset files. Adds a 'What you get out of v0.11.5 vs older' table summarising every fix between v0.11.0 and v0.11.5 so users upgrading from any prior version know what changes. Key wins for self-hosted OpenClaw (the dominant case — ~90% of installs per maintainer feedback): (a) checkpoint snapshots are auto-skipped to avoid 30-40x row duplication; (b) .reset.* full session archives are now picked up (v0.11.4 added it, v0.11.5 made shouldIngest actually allow them through — the real reset filename ends in '.833Z' not '.jsonl' so v0.11.4's logic was dead code); (c) content-based session-type detection survives main-session rotation when sessions.json has dropped the entry. Key wins for Kimi-Claw users: (a) Kimi-web header strips correctly without optional [Time:] block; (b) tool-results inherit the parent conversation instead of orphaning into a fallback bucket. Adds documentation of .reset.* archive ingestion in Step 4 — self-hosted users typically gain 3-7K messages of long-term Telegram history (~140 MB) that were invisible to memex before. No behavior change in install / daemon / MCP wiring — Discovery + Steps 1-3 + 5-8 unchanged. v1.0.2 — fixes two friction points: Step 6 (Verify) moved DB-content checks to new Step 8 (post-restart) since inbox isn't drained until first MCP server start. plugins.allow troubleshooting generalised. Pairs with memex-mvp v0.10.15. v1.0.1 — adds 'Before this skill can be installed' bootstrap section documenting the one-time plugins.allow edit on fresh OpenClaw VPS. v1.0 — first release. Wires memex into an OpenClaw gateway WHEREVER OpenClaw runs: Linux VPS, Linux workstation, macOS workstation, macOS server — all four equally first-class. Discovery checks OpenClaw / Node ≥ 20 / existing memex install / existing daemon / sessions count / systemd-user (Linux only) / gateway config location. Branches intelligently: if memex is already installed (e.g. via the generic install-memex skill for Claude Code), skips install+daemon and just merges memex into the OpenClaw gateway's MCP-server config. Otherwise full platform-aware install: Linux → ~/.config/systemd/user/memex-sync.service with loginctl enable-linger attempt; macOS → ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist. EACCES handled via ~/.npm-global prefix fix (no sudo). MCP wiring uses absolute path from \`which memex\` (MCP-stdio doesn't inherit shell PATH), merges into the OpenClaw config without overwriting other MCP servers. Verifies end-to-end before declaring done. Zero questions to the user — discovery → actions → verification. Adds 18 MCP tools (memex_search, memex_recent, memex_overview, memex_store_document, memex_import_file, etc.) to OpenClaw after gateway restart. Pairs nicely with install-memex (generic skill) when the same machine ALSO runs Claude Code / Cursor / Telegram capture — both skills share ~/.memex/data/memex.db so the corpus is unified. Memex runtime emits zero outbound network traffic." \
  --tags "memex,openclaw,memory,mcp,mcp-server,install,setup,ai-memory,local-first,verbatim,linux,macos,systemd,launchagent,vps,workstation,session-capture,sqlite,fts5,parallelclaw,gateway,server-side-agent,cross-platform" \
  --clawscan-note "Skill installs memex-mvp (open-source MIT, github.com/parallelclaw/memex-mvp) via 'npm install -g memex-mvp@latest'. Registers a Linux systemd user-service at ~/.config/systemd/user/memex-sync.service (or macOS LaunchAgent on darwin), then enables it via 'systemctl --user enable --now'. Attempts 'loginctl enable-linger \$USER' so the daemon survives SSH logout — if this needs sudo, skill prints the manual command for the user to run (sudo is NEVER invoked from the skill itself). Edits the OpenClaw gateway config (typically ~/.openclaw/openclaw.json or similar) to add a 'memex' entry under mcpServers — merge-not-overwrite, other MCP servers preserved untouched. Optionally falls back to 'nohup memex-sync &' on systems without systemd-user (container setups). Memex itself runs entirely locally — zero outbound network traffic at runtime. All commands shown to user before execution. Source code for every step: github.com/parallelclaw/memex-mvp."

echo ""
HANDLE=$(npx -y clawhub whoami 2>&1 | tail -1 | awk '{print $NF}')
echo "Done. Verify at https://clawhub.ai/${HANDLE}/install-memex-claw"

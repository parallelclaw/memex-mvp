#!/usr/bin/env bash
# Memex MVP installer
# Run with:  bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMEX_DIR="$HOME/.memex"

echo "▶ Memex MVP installer"
echo

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install from https://nodejs.org/ or:"
  echo "    brew install node    # macOS"
  exit 1
fi
NODE_VER="$(node --version)"
echo "✓ Node.js $NODE_VER"

# 2. Install dependencies
echo "▶ Installing dependencies (this may take a minute, better-sqlite3 compiles native code)…"
cd "$SCRIPT_DIR"
npm install --silent
echo "✓ Dependencies installed"

# 3. Create memex dir + inbox
mkdir -p "$MEMEX_DIR/inbox"
mkdir -p "$MEMEX_DIR/data/conversations"
echo "✓ ~/.memex/inbox/ created"

# 4. Make server.js executable
chmod +x "$SCRIPT_DIR/server.js"

# 5. Print Claude config snippet
CLAUDE_CONFIG_SNIPPET=$(cat <<EOF
{
  "mcpServers": {
    "memex": {
      "command": "node",
      "args": ["$SCRIPT_DIR/server.js"]
    }
  }
}
EOF
)

echo
echo "════════════════════════════════════════════════════════════════"
echo "✅  Installed."
echo "════════════════════════════════════════════════════════════════"
echo
echo "Next steps:"
echo
echo "1. Drop a Telegram Desktop JSON export into:"
echo "      $MEMEX_DIR/inbox/"
echo
echo "2. Add this to your Claude MCP config."
echo
echo "   ─ Claude Desktop / Claude Code:"
echo "      Edit ~/.config/claude/claude_desktop_config.json (Linux)"
echo "      or  ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)"
echo
echo "   Add or merge this block:"
echo
echo "$CLAUDE_CONFIG_SNIPPET"
echo
echo "3. Restart Claude. Ask: \"What did I discuss with my Telegram bot?\""
echo
echo "Inbox path:    $MEMEX_DIR/inbox/"
echo "Database path: $MEMEX_DIR/data/memex.db"
echo "Logs:          $MEMEX_DIR/data/memex.log"
echo

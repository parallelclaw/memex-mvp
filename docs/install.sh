#!/usr/bin/env bash
# shellcheck shell=bash
#
# memex one-line installer.
#
# Usage:
#   curl -fsSL https://memex.parallelclaw.ai/install.sh | bash
#
# What this does:
#   1. Verifies Node 20.x–24.x is installed
#   2. Installs memex-mvp from npm — auto-fixes EACCES (system Node prefix)
#   3. Installs memex-sync daemon (macOS LaunchAgent)
#   4. Installs Claude Code SessionStart hook (auto-context, "Brian Chesky moment")
#   5. Backfills existing AI sessions into the index
#   6. Auto-registers memex in Claude Code CLI if detected
#   7. Prints next steps for other MCP clients (Cursor, Cline, Continue, Zed)
#
# Everything is idempotent — re-running is safe.
#
# Source: https://github.com/parallelclaw/memex-mvp/blob/main/docs/install.sh

set -eu

# ----- styling ----------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'
  CYAN=$'\033[0;36m'
  DIM=$'\033[2m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED="" GREEN="" YELLOW="" BLUE="" CYAN="" DIM="" BOLD="" RESET=""
fi

info()  { printf '%s→%s %s\n' "$BLUE" "$RESET" "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()   { printf '%s✗%s %s\n' "$RED"   "$RESET" "$*" >&2; }
step()  { printf '\n%s━━━%s %s %s━━━%s\n' "$CYAN" "$RESET" "$BOLD$*$RESET" "$CYAN" "$RESET"; }

# Curl-pipe-bash safety: stdin may not be a TTY. We avoid interactive prompts
# in that case and use sensible defaults.
INTERACTIVE=0
if [ -t 0 ]; then INTERACTIVE=1; fi

# Allow non-interactive overrides:
#   MEMEX_INSTALL_YES=1     accept all defaults (no prompts, used in CI)
#   MEMEX_AUTO_CONTEXT=no   skip the SessionStart hook
: "${MEMEX_INSTALL_YES:=0}"
: "${MEMEX_AUTO_CONTEXT:=yes}"

confirm() {
  # confirm "Question?" → returns 0 (yes) by default. Y/Enter accepts,
  # n declines. Auto-accepts in non-interactive or MEMEX_INSTALL_YES mode.
  local prompt="$1"
  if [ "$INTERACTIVE" = "0" ] || [ "$MEMEX_INSTALL_YES" = "1" ]; then
    return 0
  fi
  printf '%s [Y/n] ' "$prompt"
  local reply
  read -r reply </dev/tty || return 0
  case "${reply:-Y}" in
    [YyЯяДд]*|"") return 0 ;;
    *) return 1 ;;
  esac
}

# ----- greeting ---------------------------------------------------------------
cat <<EOF

${BOLD}${CYAN}memex${RESET} ${DIM}— local-first cross-agent AI memory${RESET}

This installer will:
  ${DIM}1.${RESET} Install ${BOLD}memex-mvp${RESET} from npm
  ${DIM}2.${RESET} Auto-fix npm prefix on EACCES (so no future ${BOLD}sudo${RESET} ever needed)
  ${DIM}3.${RESET} Set up the auto-capture daemon (macOS LaunchAgent)
  ${DIM}4.${RESET} Install Claude Code SessionStart hook (auto-context magic)
  ${DIM}5.${RESET} Backfill existing AI sessions
  ${DIM}6.${RESET} Wire memex into Claude Code CLI if detected

Idempotent — safe to re-run. Reversible — see end of script for uninstall hints.

EOF

if [ "$INTERACTIVE" = "1" ] && [ "$MEMEX_INSTALL_YES" != "1" ]; then
  printf 'Continue? [Y/n] '
  read -r REPLY </dev/tty || REPLY="Y"
  case "${REPLY:-Y}" in
    [YyЯяДд]*|"") : ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# ----- step 1: Node.js --------------------------------------------------------
step "Step 1 / 6  ·  Node.js check"

if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found."
  cat <<EOF

Install Node.js first:
  ${CYAN}brew install node${RESET}          ${DIM}(macOS — recommended)${RESET}
  ${CYAN}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash${RESET}
  ${CYAN}…or download from https://nodejs.org${RESET}

Then re-run this installer.
EOF
  exit 1
fi

NODE_VER=$(node -p "process.versions.node" 2>/dev/null || echo "0.0.0")
NODE_MAJOR=$(printf '%s' "$NODE_VER" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js $NODE_VER is too old. memex requires 20.x – 24.x."
  echo "Upgrade with:  ${CYAN}brew upgrade node${RESET}"
  exit 1
fi

if [ "$NODE_MAJOR" -ge 25 ]; then
  warn "Node.js $NODE_VER is newer than tested (last tested: 24.x)."
  echo "memex may work but better-sqlite3 native bindings can fail on Node 25+."
  echo "Recommended fallback: ${CYAN}brew install node@22 && brew unlink node && brew link --overwrite node@22${RESET}"
  if ! confirm "Continue anyway?"; then exit 1; fi
fi

ok "Node.js v$NODE_VER detected"

# ----- step 2: install memex --------------------------------------------------
step "Step 2 / 6  ·  Installing memex-mvp from npm"

NPM_LOG=$(mktemp -t memex-npm.XXXXXX)
trap 'rm -f "$NPM_LOG"' EXIT

attempt_npm_install() {
  # Returns 0 on success, 1 on EACCES (caller will retry with prefix-fix),
  # 2 on any other failure (fatal).
  if npm install -g memex-mvp@latest >"$NPM_LOG" 2>&1; then
    return 0
  fi
  if grep -q "EACCES" "$NPM_LOG" 2>/dev/null; then
    return 1
  fi
  return 2
}

set +e
attempt_npm_install
NPM_RC=$?
set -e

if [ "$NPM_RC" = "0" ]; then
  ok "memex-mvp installed"
  # Find where THIS install landed so the rest of the script uses the
  # freshly-installed copy, not an older one earlier in PATH.
  NPM_PREFIX=$(npm prefix -g 2>/dev/null || true)
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/memex" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
elif [ "$NPM_RC" = "1" ]; then
  warn "Hit EACCES — your Node lives in a system directory."
  cat <<EOF

I'll fix this by moving npm's install location to your home directory.
After this, ${GREEN}no ${BOLD}npm install -g${RESET}${GREEN} ever needs sudo again${RESET}, for any package.

EOF
  if confirm "Apply the permanent prefix fix?"; then
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    ok "npm prefix → $HOME/.npm-global"

    # Detect shell rc file and add PATH if not already there
    RC_FILE=""
    if [ -f "$HOME/.zshrc" ]; then RC_FILE="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then RC_FILE="$HOME/.bashrc"
    elif [ -n "${ZDOTDIR:-}" ] && [ -f "$ZDOTDIR/.zshrc" ]; then RC_FILE="$ZDOTDIR/.zshrc"
    fi

    if [ -n "$RC_FILE" ]; then
      if ! grep -q "npm-global/bin" "$RC_FILE" 2>/dev/null; then
        {
          printf '\n'
          printf '# Added by memex installer — npm-global bin in PATH so npm install -g works without sudo\n'
          printf 'export PATH=~/.npm-global/bin:$PATH\n'
        } >> "$RC_FILE"
        ok "Updated $RC_FILE — open a new terminal for it to take effect"
      else
        ok "$RC_FILE already has npm-global in PATH"
      fi
    else
      warn "Couldn't detect ~/.zshrc or ~/.bashrc. Add this to your shell rc file manually:"
      echo "  export PATH=~/.npm-global/bin:\$PATH"
    fi

    # Update PATH for the rest of THIS script
    export PATH="$HOME/.npm-global/bin:$PATH"

    info "Retrying npm install -g memex-mvp..."
    npm install -g memex-mvp@latest
    ok "memex-mvp installed at $HOME/.npm-global/lib/node_modules/memex-mvp"
  else
    info "Falling back to one-time sudo install..."
    sudo npm install -g memex-mvp@latest
    ok "memex-mvp installed via sudo at /usr/local/lib/node_modules/memex-mvp"
    warn "You'll need sudo again for future npm install -g commands."
    warn "To switch to the permanent fix later: re-run this installer."
  fi
else
  err "npm install failed (non-EACCES). Last 20 lines of output:"
  tail -20 "$NPM_LOG" >&2
  exit 1
fi

# Make sure `memex` is on PATH for the rest of this script
if ! command -v memex >/dev/null 2>&1; then
  for candidate in "$HOME/.npm-global/bin" "/usr/local/bin"; do
    if [ -x "$candidate/memex" ]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi
if ! command -v memex >/dev/null 2>&1; then
  err "memex installed but not found on PATH. Try opening a new terminal and re-running."
  exit 1
fi

ok "memex $(memex --version 2>/dev/null | awk '{print $2}') ready at $(command -v memex)"

# Detect orphaned old sudo-installed copy. Common after migrating from
# system-Node prefix (/usr/local/lib) to user prefix (~/.npm-global/lib).
# We don't auto-remove it (requires sudo), just inform.
ACTIVE_BIN=$(command -v memex 2>/dev/null || true)
OLD_SUDO_PKG="/usr/local/lib/node_modules/memex-mvp"
if [ -d "$OLD_SUDO_PKG" ] && [ "$ACTIVE_BIN" != "/usr/local/bin/memex" ]; then
  warn "Found older sudo-installed memex copy in $OLD_SUDO_PKG (~60 MB, harmless but unused)."
  echo "  Clean up when convenient: ${CYAN}sudo npm uninstall -g memex-mvp${RESET}"
fi

# ----- step 3: daemon + auto-context hook -------------------------------------
step "Step 3 / 6  ·  Auto-capture daemon + Brian Chesky hook"

# memex-sync install reads --auto-context flag (yes/no) — we pass it from env
if memex-sync install --auto-context "$MEMEX_AUTO_CONTEXT" >/dev/null 2>&1; then
  ok "memex-sync daemon registered (LaunchAgent: com.parallelclaw.memex.sync)"
  if [ "$MEMEX_AUTO_CONTEXT" = "yes" ]; then
    ok "Claude Code SessionStart hook installed (auto-context magic)"
  fi
else
  warn "memex-sync install returned non-zero. Try manually: memex-sync install"
fi

# ----- step 4: backfill -------------------------------------------------------
step "Step 4 / 6  ·  Backfilling existing AI sessions"

echo "Walking ~/.claude/projects/, Cowork sessions, Cursor state.vscdb, configured Obsidian vaults..."
if memex-sync scan >/dev/null 2>&1; then
  ok "Backfill complete"
else
  warn "Backfill had issues but the daemon will catch new sessions from now on"
fi

# ----- step 5: Claude Code MCP auto-wiring ------------------------------------
step "Step 5 / 6  ·  MCP client setup"

MEMEX_BIN=$(command -v memex)

if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q "^memex"; then
    ok "Claude Code: memex MCP already registered"
  else
    info "Detected Claude Code CLI. Registering memex as MCP server..."
    if claude mcp add memex --scope user -- "$MEMEX_BIN" >/dev/null 2>&1; then
      ok "Claude Code: memex registered (scope: user)"
    else
      warn "Couldn't auto-register memex in Claude Code. Run this yourself:"
      echo "    ${CYAN}claude mcp add memex --scope user -- $MEMEX_BIN${RESET}"
    fi
  fi
else
  info "Claude Code CLI (\`claude\`) not detected — skipping auto-wiring."
  echo "  If you use Claude Code, install it first, then run:"
  echo "    ${CYAN}claude mcp add memex --scope user -- $MEMEX_BIN${RESET}"
fi

cat <<EOF

${DIM}For other MCP clients, add this entry to their config:${RESET}

  ${CYAN}{${RESET}
  ${CYAN}  "mcpServers": {${RESET}
  ${CYAN}    "memex": { "command": "$MEMEX_BIN" }${RESET}
  ${CYAN}  }${RESET}
  ${CYAN}}${RESET}

  ${DIM}Cursor:${RESET}   ~/.cursor/mcp.json
  ${DIM}Cline:${RESET}    VS Code settings.json → cline.mcpServers
  ${DIM}Continue:${RESET} ~/.continue/config.json
  ${DIM}Zed:${RESET}      ~/.config/zed/settings.json → context_servers

EOF

# ----- step 6: summary --------------------------------------------------------
step "Step 6 / 6  ·  Done"

cat <<EOF
${GREEN}${BOLD}✓ memex is installed and capturing.${RESET}

${BOLD}Quick checks:${RESET}
  ${CYAN}memex --version${RESET}            $(memex --version 2>/dev/null)
  ${CYAN}memex overview${RESET}             corpus snapshot
  ${CYAN}memex-sync status${RESET}          daemon health
  ${CYAN}memex hook status${RESET}          auto-context hook state
  ${CYAN}memex telegram check${RESET}       Telegram capture pipeline status (v0.10+)

${BOLD}Next:${RESET}
  1. ${YELLOW}Restart Claude Code${RESET} (Cmd+Q + reopen) so the SessionStart hook activates.
  2. Open Claude Code in any project. Ask: ${DIM}"what was I working on here?"${RESET}
     → Claude answers from auto-context, no tool calls needed. That's the moment.
  3. ${BOLD}Want Telegram chats indexed too?${RESET} Export from Telegram Desktop (chat → ⋮ → Export
     chat history → JSON or HTML). memex auto-detects in ~/Downloads/Telegram Desktop/
     and asks per-chat consent. Run ${CYAN}memex telegram check${RESET} to verify setup.

${BOLD}Full guide:${RESET} memex help    ${DIM}|${RESET}    ${BOLD}Disable auto-context:${RESET} memex hook uninstall
${BOLD}Repo:${RESET}       https://github.com/parallelclaw/memex-mvp

EOF

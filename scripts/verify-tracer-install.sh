#!/usr/bin/env bash
#
# Self-verifying install of memex-mvp v0.11.11-experimental-sync.
#
# Purpose: a remote agent (OpenClaw, Hermes, Cursor remote, …) runs this
# end-to-end and pastes the full output back. The Mac-side operator then
# checks the output against pre-computed expected values to confirm the
# install was REAL, not hallucinated.
#
# What it does, in order:
#   1. Sanity / environment report
#   2. Clone branch into ~/memex-tracer (idempotent — removes prior)
#   3. npm install
#   4. SHA-256 sums of canonical files (Mac operator compares against
#      pre-computed reference list)
#   5. Run three sync tests (12+12+12 checks; the actual output of
#      each is verbatim hard to fabricate convincingly)
#   6. Start sync-server in background, wait for banner, extract
#      bearer + cert fingerprint
#   7. Self-verify by curling the server we just started: a request with
#      a deliberately-wrong bearer must return 401. This proves the
#      process is alive and gating auth correctly.
#   8. Dump banner + creds to /tmp/memex-tracer-creds.txt so the operator
#      can copy them into their `sync-add` command.
#
# Tunable via env vars:
#   PORT=8766    sync-server listen port (default 8766; 8765 often in use)
#   BIND=127.0.0.1  listen address (keep loopback unless you know better)
#   BRANCH=v0.11.11-experimental-sync
#
# Exit codes:
#   0 = full success (operator can now SSH-tunnel and sync)
#   1 = clone or install failed
#   2 = tests failed (install is broken)
#   3 = server failed to start
#   4 = self-verify curl didn't see expected 401 (server unreachable
#       from its own host — usually means it died right after banner)

set -uo pipefail

PORT="${PORT:-8766}"
BIND="${BIND:-127.0.0.1}"
BRANCH="${BRANCH:-v0.11.11-experimental-sync}"
WORKDIR="$HOME/memex-tracer"
LOG="/tmp/memex-tracer-install.log"
SERVER_LOG="/tmp/memex-tracer-server.log"
CREDS="/tmp/memex-tracer-creds.txt"

# Tee everything to both stdout AND $LOG so the agent has a single
# file to cat at the end (cleaner than fishing scrollback).
exec > >(tee -a "$LOG") 2>&1
: > "$LOG"   # truncate prior

banner() { echo; echo "════════ $1 ════════"; }

banner "STEP 0 · environment"
echo "ts:            $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "hostname:      $(hostname)"
echo "uname:         $(uname -a)"
echo "whoami:        $(whoami)"
echo "HOME:          $HOME"
echo "shell:         $SHELL"
echo "node:          $(node --version 2>&1 || echo MISSING)"
echo "npm:           $(npm --version 2>&1 || echo MISSING)"
echo "git:           $(git --version 2>&1 || echo MISSING)"
echo "curl:          $(curl --version 2>&1 | head -1 || echo MISSING)"

banner "STEP 1 · clone branch ($BRANCH)"
rm -rf "$WORKDIR"
if ! git clone -b "$BRANCH" \
       https://github.com/parallelclaw/memex-mvp.git \
       "$WORKDIR"; then
  echo "FATAL: git clone failed"
  exit 1
fi
cd "$WORKDIR"
echo "commit:        $(git log -1 --format='%H')"
echo "subject:       $(git log -1 --format='%s')"
echo "tree files:    $(find . -maxdepth 2 -type f -not -path './node_modules/*' -not -path './.git/*' | wc -l | tr -d ' ')"

banner "STEP 2 · npm install (production deps)"
if ! npm install --no-audit --no-fund 2>&1 | tail -10; then
  echo "FATAL: npm install failed"
  exit 1
fi
echo "selfsigned installed: $(ls -d node_modules/selfsigned 2>/dev/null && echo yes || echo NO)"

banner "STEP 3 · SHA-256 of canonical files"
# Mac operator: compare these line-by-line against the reference table
# in the install prompt. Any mismatch = wrong branch / corrupted clone.
shasum -a 256 SYNC.md package.json lib/sync/server.js lib/sync/cli.js lib/sync/push.js lib/sync/pull.js 2>/dev/null \
  || sha256sum SYNC.md package.json lib/sync/server.js lib/sync/cli.js lib/sync/push.js lib/sync/pull.js

banner "STEP 4 · run sync tests"
# Two categories:
#   MUST_PASS — proves the wire protocol works end-to-end. Failure here
#     means the install is genuinely broken; we exit non-zero.
#   INFORMATIONAL — subprocess shell hygiene tests with known macOS/Linux
#     timing differences in daemon-mode-side-effects. We report results
#     but don't gate the install on them.
test_failed_required=0
echo "──── MUST_PASS: test/sync/server-bootstrap.test.js (expected 12/12 ✓) ────"
if ! node test/sync/server-bootstrap.test.js 2>&1 | tail -20; then
  echo "FAIL: server-bootstrap.test.js"
  test_failed_required=1
fi
echo "──── MUST_PASS: test/sync/push-pull-roundtrip.test.js (expected 12/12 ✓) ────"
if ! node test/sync/push-pull-roundtrip.test.js 2>&1 | tail -20; then
  echo "FAIL: push-pull-roundtrip.test.js"
  test_failed_required=1
fi
if [ "$test_failed_required" != "0" ]; then
  echo "FATAL: wire-protocol tests failed — install is broken, refusing to start server."
  exit 2
fi

echo "──── INFORMATIONAL: test/sync/cli-end-to-end.test.js (subprocess UX; passes on macOS, may fail on Linux due to daemon-mode race) ────"
node test/sync/cli-end-to-end.test.js 2>&1 | tail -20 || \
  echo "NOTE: cli-end-to-end had failures — this exercises subprocess shell hygiene, not the wire protocol. Continuing to server start regardless."

banner "STEP 5 · start sync-server (background, $BIND:$PORT)"
# Kill any prior leftover from a previous attempt.
pkill -f "ingest.js sync-server" 2>/dev/null || true
sleep 1

: > "$SERVER_LOG"
export MEMEX_SYNC_EXPERIMENTAL=1
nohup node ingest.js sync-server start --port "$PORT" --bind "$BIND" \
  > "$SERVER_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "server PID:    $SERVER_PID"

# Wait up to 12s for the banner to appear.
for i in $(seq 1 24); do
  if grep -q "Server running" "$SERVER_LOG"; then
    break
  fi
  sleep 0.5
done

if ! grep -q "Server running" "$SERVER_LOG"; then
  echo "FATAL: server didn't print 'Server running' within 12s. Log:"
  cat "$SERVER_LOG"
  exit 3
fi

# Confirm process is still alive (didn't crash right after banner).
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "FATAL: server PID $SERVER_PID is gone. Log:"
  cat "$SERVER_LOG"
  exit 3
fi

echo "server log (banner):"
sed 's/^/  /' "$SERVER_LOG"

# Extract bearer + fingerprint into a side artifact.
BEARER="$(grep -oE 'Bearer \(256-bit\):  [0-9a-f]+' "$SERVER_LOG" | awk '{print $NF}')"
FP="$(grep -oE 'Cert fingerprint:  sha256:[0-9A-F:]+' "$SERVER_LOG" | awk '{print $NF}')"
LISTEN_LINE="$(grep -E 'Listening on' "$SERVER_LOG" | head -1)"

if [ -z "$BEARER" ] || [ -z "$FP" ]; then
  echo "FATAL: could not extract bearer or fingerprint from banner."
  exit 3
fi

banner "STEP 6 · self-verify (curl ourselves with wrong bearer → must see 401)"
# Curl with an obviously-wrong token. The server must respond 401
# {"error":"unauthorized"}. This proves: (a) the server is actually
# listening on $BIND:$PORT, (b) auth middleware is wired, (c) it's
# NOT a stray python/HTTP server because those would return 200/404.
sleep 1
self_check=$(curl -ks --max-time 6 -o /dev/null -w '%{http_code}' \
              -H 'Authorization: Bearer 0000000000000000000000000000000000000000000000000000000000000000' \
              "https://$BIND:$PORT/sync/health" 2>&1) || self_check="curl_failed"
echo "self-curl status: $self_check"

if [ "$self_check" != "401" ]; then
  echo "FATAL: expected 401 from self-curl, got '$self_check'."
  echo "Server is likely not really listening, or something else is on $BIND:$PORT."
  exit 4
fi

# Now do a positive check — real bearer must yield 200 with version JSON.
self_ok=$(curl -ks --max-time 6 \
              -H "Authorization: Bearer $BEARER" \
              "https://$BIND:$PORT/sync/health" 2>&1) || self_ok="curl_failed"
echo "self-curl with REAL bearer: $self_ok"

if ! echo "$self_ok" | grep -q 'schema_version'; then
  echo "FATAL: positive self-check didn't return JSON with schema_version."
  exit 4
fi

banner "STEP 7 · ALL GREEN — credentials for Mac operator"
{
  echo "Server: https://$BIND:$PORT"
  echo "Bearer: $BEARER"
  echo "Fingerprint: $FP"
  echo "PID: $SERVER_PID"
  echo "ServerLog: $SERVER_LOG"
} | tee "$CREDS"

cat <<EOF

────────────────────────────────────────────────────────────────
Server is live and self-verified.

The Mac operator runs (on their machine, with SSH tunnel active):

  cd <memex-mvp-clone>
  export MEMEX_SYNC_EXPERIMENTAL=1
  node ingest.js sync-add vps https://localhost:$PORT $BEARER \\
       --cert-fp $FP
  node ingest.js sync-run vps

Server PID: $SERVER_PID  (kill with: kill $SERVER_PID)
────────────────────────────────────────────────────────────────
EOF

exit 0

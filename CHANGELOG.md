# Changelog

Notable changes to memex-mvp. Older history lives in the git log.

## 0.14.0 — provenance: know which machine captured every row

In a synced mesh, all nodes' captures share the same `source` labels — two
OpenClaw instances both write `source='openclaw'`, and when they bridge the
same Telegram account they even interleave into ONE conversation. Two agents
in a row misread their own synced DB because of this (one invented a
nonexistent `source='vps1'` to look for — telling). v0.14 stamps every row
with the node that captured it.

### Added
- **`origin` column on messages** — stamped at capture time on every local
  write path (capture daemon, MCP imports, Telegram import, store_document,
  sync self-test, OpenClaw plugin). Value resolution: `MEMEX_ORIGIN` env →
  `origin` in `~/.memex/config.json` → sanitised short hostname, which is
  then **persisted** so a later hostname change doesn't fork the node's
  identity. Rename your node by editing `origin` in config.json.
- **Wire carries provenance** — sync pull/push move `origin` verbatim in both
  directions; a synced row keeps the origin of the node that captured it,
  never the receiver's. Old peers interoperate (unknown field ignored;
  their rows arrive as NULL = "pre-provenance era").
- **`memex_search(origin: "vps1")`** — filter recall by capture node.
- **`memex_get_conversation`** tags each line `[@origin]` when a conversation
  interleaves rows from more than one node (the merged-Telegram-chat case);
  single-origin chats stay untagged. JSON format always includes `origin`.
- **`memex_overview`** shows a per-origin breakdown when the corpus is
  multi-node.

### Notes
- No blind backfill: a node cannot tell its own pre-v0.14 rows from peer rows
  that synced in before provenance existed, and fabricating provenance is
  worse than NULL. Re-imports of local source files DO backfill origin via
  the conflict branch (`COALESCE(existing, incoming)` — never overwrites).
- The OpenClaw plugin (`plugins/memex-openclaw`) ships separately from the
  npm package — update it on agent nodes to start stamping there.

## 0.13.0 — `sync-join`: cross-device memory in two copy-paste steps

Multi-device sync goes from "for operators" to "for lazy users". Laptop with
Claude/Cursor + a server with an agent: the agent runs three commands and
hands you a `memex-join:` token; you paste **one command** on the laptop.
Dogfooded end-to-end by migrating the maintainer's own live mesh — every step
below shipped only after surviving that.

### Added
- **`memex-sync sync-join <memex-join:...>`** — one-command spoke setup:
  token validation → SSH probe (prints your pubkey + exact instructions if
  access is missing) → durable forward tunnel (launchd KeepAlive / systemd
  Restart=always; `ExitOnForwardFailure`, `ServerAlive 30×3`, explicit IPv4
  loopback) → pinned-cert health check → remote registration → first sync →
  15-min auto-sync schedule → hourly watchdog → **marker self-test** that
  proves a note round-trips before declaring success (`✓ end-to-end verified:
  … 3.4s` on the live pair). Flags: `--alias`, `--local-port`, `--every`,
  `--no-watchdog`, `--no-selftest`.
- **`memex-sync sync-server invite --join [--ssh-target u@h]`** — hub-side
  join-token emission (`memex-join:` = pair blob + `ssh_target`, host pinned
  to 127.0.0.1, TTL 30m). The server stays loopback-only; nothing is ever
  exposed publicly — all traffic rides inside SSH on port 22.
- **`memex-sync sync-watchdog`** — read-only hourly health pass (installed by
  join): remotes' `last_sync_at` freshness + tunnel unit state; on silence
  writes `~/.memex/sync-alert.txt` + desktop notification. The "tunnel died
  silently for 6 days" failure mode, productized away.
- **`sync-status`** now reports the tunnel keeper (route, self-healing state)
  and watchdog alongside server/schedule/remotes.

### Changed
- **No env var after joining** — a successful `sync-join` persists
  `sync.enabled: true`; every sync command then works in any shell without
  `MEMEX_SYNC_EXPERIMENTAL=1`.
- **Replication is resumable** — cursors persist after every clean pull page
  and push batch, so an interrupted first sync (network reset, sleep, Ctrl-C)
  resumes instead of restarting from zero; transient network errors
  (ECONNRESET/EPIPE/ETIMEDOUT/ECONNREFUSED) retry in place with backoff tuned
  to the tunnel's ~15s self-heal.
- **Re-joining a known hub keeps cursors** — if the token's cert fingerprint
  matches the existing remote's, sync-join preserves cursor state instead of
  forcing a full re-replication of an already-converged pair.
- **Docs lead with the lazy flow** — landing page, README (EN/RU), SYNC.md
  quickstart, HELP.md section, MULTI_MACHINE.md legacy patterns marked
  deprecated.

### Fixed
- Tunnel-keeper script generation emitted a broken line continuation (`\ \`)
  when no SSH identity file was configured — ssh received a stray empty
  argument and the tunnel flapped forever. Regression-tested, including
  backslash hygiene of every continuation line.

## 0.12.0 — agent retrieval: reach any part of memory

Sharper recall for agents querying memex — especially across long sessions and
narrow time windows. Backward-compatible: every new parameter is optional and
defaults to the previous behaviour.

### Added
- **`memex_get_conversation` paging** — new `offset` and `order` (`asc`|`desc`)
  parameters, plus a `total` count in the output. A long session (e.g. 3000
  messages) can now return its **freshest** tail (`order:"desc"`) or be paged
  end-to-end — previously only the first ~N (oldest) were reachable. Fixes a real
  gap found live: an agent could not show the June messages of a 2900-message
  Claude Code session.
- **`memex_search` date-range filter** — `since_ts` / `until_ts` (Unix seconds,
  inclusive) restrict results to a window ("what did we discuss about X in June").
  A true filter, distinct from `sort` (orders only) and `half_life_days` (boosts
  only). Numeric bounds naturally exclude undated rows.
- **`memex_search` within-conversation scope** — `conversation_id` confines a
  keyword search to ONE session (exact id, unlike the fuzzy `chat` title match).
  Pair it with `memex_get_conversation` paging to locate, then read around a hit
  in a huge session.
- **Retrieval recipes** baked into the tool descriptions and `HELP.md` (new
  "Рецепты поиска для агентов" table) so agents discover these paths without
  guessing — date window, within-session search, freshest-first, page-a-giant.

### Fixed
- **`memex_get_conversation` no longer hides the tail of long conversations** —
  the handler always sorted `ts ASC LIMIT N` with no offset, so the newest
  messages of any session past the limit were unreachable.
- **`test/sync/mcp-invite.test.js` is now hermetic** — the liveness-warning
  assertion used a hard-coded port and failed on hosts that actually run a
  sync-server on 8766; it now probes a guaranteed-closed port.

## 0.11.11 — experimental multi-device sync

First cut of **local-first, multi-device sync** — converge two machines'
`memex.db` over the network with no cloud relay. Gated behind
`MEMEX_SYNC_EXPERIMENTAL=1`; the wire protocol may change before it graduates
to stable. Full guide + spec in [SYNC.md](SYNC.md).

### Added
- **Sync engine** — HTTP push/pull + per-peer cursors. Conflict-free via the
  existing `UNIQUE(source, conversation_id, msg_id)` constraint (verbatim memory
  is append-only — nothing to merge). TLS with self-signed cert + **fingerprint
  pinning**, 256-bit bearer auth.
- **CLI** (`memex-sync sync-*`):
  - `sync-server start | install | uninstall | status` — run the hub, optionally
    as a durable systemd-user / LaunchAgent service that survives reboot.
  - `sync-server invite [--host H] [--port N] [--ttl 30]` — print a one-paste
    `memex-pair:` token (bundles host + port + cert fingerprint + bearer, with TTL).
  - `sync-pair <blob> [--alias vps]` — register a remote from a pair token.
  - `sync-add <alias> <url> <bearer> (--cert-fp F | --insecure)` — explicit form.
  - `sync-run <alias> | --all` — one bidirectional sync.
  - `sync-schedule install [--every 15m] | uninstall | status` — hands-off
    auto-sync on a timer.
  - `sync-list / sync-remove / sync-status`.
- **`memex_sync_invite` MCP tool** — lets an agent emit a pairing token from a
  plain-language request ("set up sync with my Mac"). Surfaced only when
  `MEMEX_SYNC_EXPERIMENTAL=1` is set in the MCP server's environment.

### Reliability
- **Adaptive push batching** — pre-flights payload size and shrinks before the
  2 MB body cap; backstops 413 / EPIPE by halving and retrying.
- **No silent row loss** — pulled rows are applied with retry; on the FTS5
  "database disk image is malformed" error the index is rebuilt once and the
  batch retried; if rows still won't apply, sync aborts **without advancing the
  cursor** (loud failure over silent loss). Skips are counted and surfaced.
- **busy_timeout** on the sync connection to ride out the capture daemon's
  concurrent writes.

### Verified live
- Bidirectional Mac ↔ VPS sync over the public internet (32k+ rows each side,
  cert-pinned), durable-server restart with credentials preserved, hands-off
  auto-sync of a fresh conversation within one interval, and the full
  agent-chat-phrase → pair-token → sync wow-flow.

### Dependencies
- Added `selfsigned` (self-signed TLS cert generation for the sync server).

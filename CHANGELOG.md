# Changelog

Notable changes to memex-mvp. Older history lives in the git log.

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

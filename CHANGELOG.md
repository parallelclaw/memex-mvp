# Changelog

Notable changes to memex-mvp. Older history lives in the git log.

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

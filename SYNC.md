# memex sync — multi-device replication

> **Status:** experimental in v0.11.11+. Enable with `MEMEX_SYNC_EXPERIMENTAL=1`.
> Wire protocol may change before v0.12. Pin your memex version on both sides.

A pair of memex instances (laptop + VPS, or two laptops, or any N) keep their
`~/.memex/data/memex.db` files **converging** — same conversations and messages
visible from every device, no cloud relay, no shared file system.

This document is **both** the operational guide and the wire-protocol spec.
Implementers and users read different sections.

---

## Table of contents

1. [Why this exists](#why-this-exists) — what problem we're solving
2. [How it works (30s version)](#how-it-works-30s-version) — for users
3. [Transports](#transports) — SSH, Tailscale, HTTPS pair, mDNS
4. [Setup walkthrough](#setup-walkthrough) — `memex sync setup`
5. [Wire protocol (spec)](#wire-protocol-spec) — for implementers
6. [Security model](#security-model)
7. [Trade-offs we made](#trade-offs-we-made)
8. [Out of scope (deliberately)](#out-of-scope-deliberately)

---

## Why this exists

memex is a **local-first** SQLite memory: every device captures its own AI
conversations into its own `memex.db`. Without sync, the Mac doesn't see what
the VPS captured, and vice versa.

The naïve fix — point Syncthing/Dropbox/iCloud at the `.db` file — corrupts
SQLite within hours under concurrent writes (documented [downstream of
claude-mem](https://github.com/thedotmack/claude-mem/issues/1037)).

memex sync solves it by treating each device's database as **append-only
authoritative** and exchanging **deltas** over HTTP. Conflicts cannot happen
because verbatim memory is never edited — we only ever insert.

---

## How it works (30s version)

```
   ┌──────────────────────┐       HTTP push/pull        ┌──────────────────────┐
   │  Mac                 │  ◀──── every 15 min ────▶  │  VPS                 │
   │  memex.db (Mac side) │                              │  memex.db (VPS side) │
   │                      │   POST /sync/push  ───▶    │                      │
   │  Claude Code         │   GET  /sync/pull  ◀───    │  OpenClaw, Hermes    │
   │  Telegram            │                              │  cron jobs           │
   └──────────────────────┘                              └──────────────────────┘
```

1. **VPS** runs `memex sync server enable` — generates a self-signed TLS cert
   and a bearer token, prints a one-line **pair blob**.
2. **Mac** runs `memex sync pair memex-pair:...` — stores the blob, validates
   the cert against its pinned fingerprint, can now talk to VPS.
3. Every 15 min (configurable), Mac runs `memex sync run` — it:
   - pulls rows from VPS with `id > last_seen_cursor` and INSERT-OR-IGNOREs them
   - pushes rows VPS hasn't seen yet
   - advances both cursors

Dedup is automatic via the existing `UNIQUE(source, conversation_id, msg_id)`
constraint — same row from two directions never double-inserts.

---

## Transports

Sync runs over HTTP/JSON. **How the bytes reach VPS** is independent of the
wire protocol — pick one:

| Transport | Best for | User setup steps |
|---|---|---|
| **SSH tunnel** | User already SSHes into VPS | Zero (autossh installed on demand) |
| **Tailscale** | Both devices on same tailnet | Zero (auto-detected) |
| **HTTPS + pair blob** | VPS only via agent/bot (no SSH) | One paste from agent chat |
| **mDNS LAN** | Two devices on same Wi-Fi, no VPS | Zero (auto-discovery) |
| **Caddy + public HTTPS** | Advanced, want public access | Domain + Caddy install |

`memex sync setup` probes the environment and recommends the leanest path.

### SSH tunnel (default for SSH-capable users)

Mac runs `autossh -N -L 8765:localhost:8765 user@vps` as a LaunchAgent. Sync
client talks to `http://localhost:8765`, bytes flow through SSH to VPS:8765.

Pro: zero new accounts, encryption from SSH.
Con: tunnel-keeper daemon (autossh handles reconnect).

### Tailscale (if available)

Mac talks to `http://memex-vps.tail-abc.ts.net:8765` directly. WireGuard
encryption and identity built in.

Pro: works through NAT, identity per device.
Con: requires Tailscale account (free for personal, 100 devices).

### HTTPS + pair blob (lazy-user path)

VPS exposes `https://<host>:8765` with a self-signed cert. Client pins the
cert fingerprint baked into the pair blob. Bearer token in header authenticates
the request. No DNS, no Let's Encrypt, no SSH key — one paste from agent chat.

Pro: zero user terminal access to VPS required.
Con: VPS must have a reachable public IP/hostname.

### mDNS LAN (no-VPS scenario) — planned

Two devices on the same Wi-Fi would announce themselves as `_memex._tcp.local`
and pair via trust-on-first-use, no VPS required. **Not built yet** — until then,
two LAN machines can still pair by running the server on one and `sync-add`-ing
its LAN IP from the other.

Pro: no VPS, no cloud, no account.
Con: only when both devices on same network.

---

## Setup walkthrough

> All commands are gated behind `MEMEX_SYNC_EXPERIMENTAL=1` in v0.11.x.
> The CLI lives under the existing `memex-sync` binary (`memex-sync sync-*`).

### Scenario 1 — lazy path: VPS you only reach through an agent

The hub (VPS) runs the server durably; the spoke (laptop) pairs with one paste.

**On the VPS, once** (or have your agent run it):

```sh
export MEMEX_SYNC_EXPERIMENTAL=1
memex-sync sync-server install --port 8766 --bind 0.0.0.0   # durable systemd/launchd service
```

**Get a pairing token.** Either ask your agent in chat —

> "set up memex sync with my Mac" / "сгенерируй паринг-код для синка"

— and it calls the **`memex_sync_invite`** MCP tool (requires
`MEMEX_SYNC_EXPERIMENTAL=1` in the memex MCP server's env), or run it by hand:

```sh
memex-sync sync-server invite --host <public-ip>      # prints memex-pair:...
```

**On the laptop, one paste:**

```sh
export MEMEX_SYNC_EXPERIMENTAL=1
memex-sync sync-pair memex-pair:eyJ2IjoxLCJob3N0Ijoi...   # decodes host+port+cert_fp+token
memex-sync sync-run vps                                   # first sync
memex-sync sync-schedule install --every 15m             # hands-off from here
```

Done. New conversations propagate within the interval, both directions.

### Scenario 2 — Mac + VPS over an SSH tunnel

If you have SSH to the VPS, skip the public bind. Run the server on loopback,
forward the port yourself, and pass `--host localhost` to invite:

```sh
# VPS
memex-sync sync-server install --port 8766 --bind 127.0.0.1
memex-sync sync-server invite --host localhost            # blob targets localhost

# Mac — keep this tunnel up (autossh/LaunchAgent automation is a follow-up)
ssh -N -L 8766:localhost:8766 user@vps &
memex-sync sync-pair memex-pair:...                       # → https://localhost:8766
memex-sync sync-run vps
```

### Scenario 3 — Tailscale

Both machines on one tailnet: `invite --host <vps>.tail-xxxx.ts.net`, then
`sync-pair` on the laptop. WireGuard handles encryption + NAT; the cert pin in
the blob still applies.

### Manual fallback (no pair blob)

`sync-pair` is just sugar over `sync-add`. The explicit form:

```sh
memex-sync sync-add vps https://<host>:8766 <bearer-hex> --cert-fp sha256:AA:BB:...
# or, over a transport you already trust (SSH tunnel / Tailscale):
memex-sync sync-add vps https://localhost:8766 <bearer-hex> --insecure
```

### Command reference

| Command | Side | What |
|---|---|---|
| `sync-server install / uninstall / status` | hub | durable server service |
| `sync-server start` | hub | foreground server |
| `sync-server invite [--host H] [--port N] [--ttl 30]` | hub | print a pair blob |
| `sync-pair <blob> [--alias vps]` | spoke | register a remote from a blob |
| `sync-add <alias> <url> <bearer> (--cert-fp F \| --insecure)` | spoke | register a remote explicitly |
| `sync-run <alias> \| --all` | spoke | one bidirectional sync |
| `sync-schedule install [--every 15m] / uninstall / status` | spoke | hands-off auto-sync timer |
| `sync-list / sync-remove <alias> / sync-status` | spoke | inspect / manage remotes |
| `memex_sync_invite` (MCP tool) | hub | agent emits a pair blob from a chat phrase |

> **Not yet automated (manual today, planned):** autossh tunnel management,
> Tailscale auto-detection, and mDNS LAN discovery (`_memex._tcp.local` for two
> machines on the same Wi-Fi with no VPS). The transports themselves work today
> via the manual steps above.

---

## Wire protocol (spec)

> Implementers: this is the source of truth. Anything that diverges from this
> section is a bug.

### Endpoints

```
POST /sync/push
  Authorization: Bearer <token>
  Content-Type: application/json
  Body: {
    "rows": [Row, Row, ...]    // 1..1000 messages
  }

  Response 200: {
    "accepted":     N,           // rows inserted (newly seen by us)
    "deduplicated": M,           // rows we already had (UNIQUE constraint hit)
    "last_id":      <int>        // our local id of the highest-ranked row
                                  // — useful for client log/debug
  }
  Response 401: { "error": "unauthorized" }
  Response 400: { "error": "bad_request", "detail": "..." }
  Response 413: { "error": "payload_too_large" } // >2MB body
```

```
GET /sync/pull?since=<int>&limit=<int>
  Authorization: Bearer <token>

  Query:
    since   — local id of caller's last-seen row from us; 0 for first pull
    limit   — max rows to return; default 500, max 1000

  Response 200: {
    "rows":         [Row, Row, ...],
    "next_cursor":  <int>,        // id of the last row in this batch
    "has_more":     bool,         // true → caller should call again with
                                   // since=next_cursor immediately
    "server_now":   <int>         // our wall clock at response time (ms epoch)
                                   // — informational
  }
```

```
GET /sync/health
  Authorization: Bearer <token>     // optional — token gates extra detail

  Response 200: {
    "version":     "0.11.11",
    "schema_version": 12,
    "row_count":   <int>,            // total messages in our DB
    "last_id":     <int>             // highest message id we hold
  }
```

### Row shape

A `Row` is exactly the JSON representation of a `messages` table row, plus
the parent `conversation` metadata necessary to materialize the row on the
other side:

```json
{
  "source":          "claude-code",
  "conversation_id": "claude-code-<uuid>",
  "msg_id":          "<source-specific-stable-id>",
  "uuid":            "<v4-uuid>",
  "role":            "user|assistant|system|tool|boundary|summary",
  "sender":          "me|claude-code|...",
  "text":            "raw verbatim content",
  "ts":              1716800000,      // source-original timestamp (seconds)
  "edited_at":       1716800042000,   // ms; null if never edited
  "channel":         "telegram|kimi-web|system|null",
  "metadata":        "{...json-string...}",
  "conversation": {
    "title":         "...",
    "first_ts":      1716700000,
    "last_ts":       1716800000,
    "project_path":  "/Users/x/work|null",
    "parent_conversation_id": "...|null"
  }
}
```

**Required fields:** `source`, `conversation_id`, `role`, `text`, `ts`.
**Stable identity for dedup:** `(source, conversation_id, msg_id)` — `msg_id`
may be null but if so the row is considered ephemeral and is NOT synced.
**Portable global identity:** `uuid` — populated by writer; if absent on a
synced row, receiver generates one on insert (so future pulls can refer to it).

### Cursor semantics

A **cursor** is one integer: the receiver's local `messages.id` of the last
row it observed from this peer. Cursor is **per-peer, per-direction**:

```
client_config.json:
  "remotes": {
    "vps": {
      "url": "http://localhost:8765",
      "bearer": "...",
      "pulled_to": 18472,    // we've pulled VPS rows up to its id 18472
      "pushed_to": 9341      // we've pushed our rows up to our id 9341
    }
  }
```

Both endpoints are **strictly monotonic per peer**. Pull returns rows with
`id > since` ordered ASC by id. Push always sends rows with `id > pushed_to`
ordered ASC. Receivers never assume cursor monotonicity beyond a single peer.

### Idempotency

Push is **at-least-once**. Two identical push requests produce identical state
on the server (UNIQUE constraint absorbs dupes). The client is free to retry
indefinitely.

Pull is **at-least-once**. The client may receive the same row twice across
retries (e.g. network failure mid-batch). It must INSERT OR IGNORE on its side.

### Conversation upsert

`messages` and `conversations` are separate tables linked by `conversation_id`.
On every push, the receiver:

1. UPSERTs `conversations` row from `row.conversation` (latest values win on
   `title`, `last_ts`, `message_count`).
2. INSERT OR IGNOREs the message via UNIQUE.

This way a conversation that exists only on Mac becomes a real row on VPS the
first time any of its messages arrives.

### Schema-version handshake

`GET /sync/health` reports `schema_version`. Client and server must match
**major schema version**. If client < server schema version: client refuses to
sync, prints "upgrade memex on this side". If client > server: same.

Schema versions bump only when wire shape changes (column adds that affect
sync). Pure additive changes that don't ship over the wire don't bump.

Initial sync schema version: **12**.

### Error semantics

| Code | Meaning | Client action |
|------|---------|---------------|
| 200 | OK | Continue |
| 400 | Bad request body | Log + abort; don't retry; this is a bug |
| 401 | Unauthorized | Token rotation needed; abort sync until reconfigured |
| 409 | Schema mismatch | Print upgrade instruction; abort |
| 413 | Payload too large | Reduce batch size and retry |
| 429 | Rate limited (too many concurrent pushes) | Honor Retry-After header |
| 500 | Server error | Exponential backoff, retry |

### Rate limits

The server may rate-limit per-token at **10 push requests per minute** and
**60 pull requests per minute**. Bursting above this returns 429 with
`Retry-After: <seconds>` header.

These limits exist to bound the worst case of a misconfigured client and are
generous for normal operation.

---

## Security model

### Authentication

**Bearer tokens** — 256-bit random, generated by `memex sync invite` on the
server side. Token is in `Authorization: Bearer <hex>` header on every request.

Tokens are stored on disk in `~/.memex/config.json` (mode 0600).

`memex sync rotate-token` invalidates the current token and prints a new pair
blob. Pre-existing connected clients break until they re-pair.

### Transport encryption

| Transport | How encryption is achieved |
|-----------|----------------------------|
| HTTPS + pair blob | Self-signed TLS, client pins server cert fingerprint |
| SSH tunnel | SSH transport |
| Tailscale | WireGuard tunnel between nodes |
| mDNS LAN | TLS with pinned fingerprint (same as HTTPS path) |
| Caddy + public HTTPS | Let's Encrypt-issued cert |

**Self-signed certs are pinned**: client refuses to talk to the server if the
TLS cert fingerprint doesn't match what was baked into the pair blob. This is
the same mechanism Plex/Tailscale/etc. use for device-to-device trust.

### Threat model

| Threat | Mitigation |
|--------|------------|
| Attacker on network sees bearer token | TLS encryption blocks |
| Attacker MITMs and replaces TLS cert | Cert pinning rejects |
| Stolen bearer token | `memex sync rotate-token` invalidates |
| Replay attack | Idempotent endpoints — no harm; receiver dedups |
| Malicious peer pushes garbage rows | Rate limit + payload size cap; rows still need valid `source/conv_id/msg_id` shape |
| Compromised peer pulls all our data | Bearer auth is binary (token = full access); for least-privilege you'd need per-source ACLs (future work) |

### Out of scope for security v1

- Per-conversation ACL (a peer can pull all your conversations or none)
- E2E encryption of payloads (we rely on transport encryption)
- mTLS (you can layer it on if you use Caddy)
- Signed rows (verifiable origin) — possible v2 if needed

---

## Trade-offs we made

| Choice | Why | Lose |
|---|---|---|
| HTTP push/pull + cursors | Replicache 2026 consensus pattern; idempotent; simple | Real-time — sync is up to 15 min stale |
| Local AUTOINCREMENT id as cursor | Per-DB monotonic, zero design overhead | Cursors not portable; each peer has its own |
| Self-signed cert + pinning | Zero DNS/CA infrastructure | Browser tooling can't poke the endpoint |
| Bearer token (not OAuth) | Days vs weeks to ship | Manual rotation |
| UNIQUE-constraint dedup | We don't edit verbatim — perfect fit | Cannot reconcile two divergent edits to the same logical row (we don't do that) |
| Skip CRDT / cr-sqlite | Maintenance risk + extension dependency | If we ever want concurrent-edit reconciliation, we'd need to revisit |
| Hub-and-spoke for 2 nodes | P2P degenerate at N=2; VPS always-on anyway | Single point of failure (mitigated: laptop keeps full local copy) |
| Schema-version handshake | Refuse to silently corrupt data on version skew | Coupling clients to specific server versions |

---

## Out of scope (deliberately)

- **Selective sync per conversation** — v2. v1 syncs everything.
- **Web UI for sync state** — `memex sync status` CLI is the surface.
- **Multi-VPS / N-device sync** — works (each Mac points at one VPS) but the
  config UX is single-pair-only in v1.
- **Sync of archived conversations** — currently archive is local-only flag.
  TBD whether archives should sync.
- **End-to-end encryption** — transport encryption is enough for v1 given the
  threat model.
- **Cloud relay** — never. Against memex's local-first principle.

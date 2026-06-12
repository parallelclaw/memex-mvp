# memex sync — multi-device replication

> **Status:** engine experimental since v0.11.11; the **`sync-join` lazy flow is
> the v0.13 front door**. After one successful `sync-join`, no
> `MEMEX_SYNC_EXPERIMENTAL` env var is needed (the join persists
> `sync.enabled: true`). Manual/advanced commands on a machine that never
> joined still want the env var. Pin your memex version on both sides.

A pair of memex instances (laptop + VPS, or two laptops, or any N) keep their
`~/.memex/data/memex.db` files **converging** — same conversations and messages
visible from every device, no cloud relay, no shared file system.

## Quickstart (the lazy path — 2 steps)

The canonical setup: your laptop (Claude/Cursor) + one always-on server where
your agent lives. **Step 1 — paste to the agent on the server:**

```
Set up memex sync as a hub and give me a join token for my laptop:
1. npm install -g memex-mvp@latest   (skip if installed)
2. memex-sync sync-server install --bind 127.0.0.1
3. memex-sync sync-server invite --join
Send me the memex-join:... line.
```

**Step 2 — one command on the laptop:**

```sh
memex-sync sync-join memex-join:eyJ2...
```

That orchestrates everything: SSH probe (prints your pubkey + instructions if
access is missing), a self-healing forward tunnel (launchd/systemd KeepAlive),
pinned-cert health check, first sync (resumable if interrupted), 15-min
auto-sync, hourly watchdog, and a **marker self-test** that proves a note
round-trips before declaring success. Everything below this section is the
operational detail and the wire-protocol spec.

This document is **both** the operational guide and the wire-protocol spec.
Implementers and users read different sections.

---

## Table of contents

1. [Why this exists](#why-this-exists) — what problem we're solving
2. [How it works (30s version)](#how-it-works-30s-version) — for users
3. [Transports](#transports) — SSH, Tailscale, HTTPS pair, mDNS
4. [Setup walkthrough](#setup-walkthrough) — manual steps behind `sync-join`
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

`memex-sync sync-join` (v0.13) automates the SSH-tunnel transport end-to-end —
the canonical lazy path. The full environment-probing wizard that picks among
ALL transports is Roadmap §1.

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

---

## Deployed patterns (what's been proven live)

The "lazy-user mesh" got real-world stress tests over several days. These are
patterns we observed working end-to-end, in order of decreasing dependence on
network privilege.

### A. VPS-as-hub on a public port (the assumed default)

VPS exposes the sync-server on some port (e.g., 8766 or 443 behind nginx).
Spokes dial it directly. Works when: VPS firewall + spokes' egress both allow
the port.

**Fragility we hit:** ISP/VPN/cloud-SG can silently start blocking the port
that "worked yesterday" — without a guest reboot or any user change. We saw
this on a HOSTKEY VPS where 8766 just stopped passing externally. Public
ports are subject to anyone's firewall above the OS.

### B. SSH tunnel (spoke initiates `ssh -L`) ⭐ THE CANONICAL PATTERN — automated by `sync-join`

Spoke `ssh -L 8766:localhost:8766 user@vps` over the existing port 22; sync
client talks to `localhost:8766`. Hub doesn't expose 8766 publicly; the
spoke's Mac VPN/proxy mostly relays SSH (it usually does to standard ports).

This is what `memex-sync sync-join` builds (v0.13): the always-on server is
the hub on loopback, the laptop dials out with a supervised `-L` tunnel.
Strictly better than C for the common laptop+server case — the authoritative
always-reachable node is the one that's actually always on. **Live since
2026-06-11** on the maintainer's own Mac↔VPS pair (migrated off pattern C
via `sync-join` itself; built-in marker self-test round-tripped in 3.4s).

### C. Mac-as-hub via reverse SSH tunnel (`ssh -R`) ⭐

The inversion that solved everything when public ports failed across the board:

```
   Mac runs sync-server on localhost:8766 (non-privileged, no root)
   Mac runs:  ssh -fN -R 8766:127.0.0.1:8766 user@vps

   On the VPS, sshd creates a LOOPBACK listener on 127.0.0.1:8766
   that forwards through the existing SSH connection back to Mac.

   The VPS-side memex agent then runs:
     sync-add mac https://localhost:8766 <mac-bearer> --insecure
     sync-run mac
     sync-schedule install --every 5m
```

The radical property: **the only port traversed is 22, which is already open
on every VPS by definition (otherwise you couldn't have provisioned it).**
No firewall change anywhere. The sync-server is bound to loopback on both
ends — nothing public, anywhere. Cloud SG, ufw, the Mac's full-tunnel VPN
proxy — all irrelevant.

The trade-off: the Mac is a laptop. When it sleeps or the network changes,
the SSH tunnel dies. The VPS's scheduler then sees `peer unreachable` for
each tick until Mac wakes and re-establishes the tunnel. Acceptable for
"used-daily-driver" workflows; sync pauses, never loses data.

### D. Transit-hub: chained `ssh -R` for a node Mac can't reach directly

Pattern C breaks when the Mac's VPN proxy refuses to relay SSH to a particular
destination (we saw this on Mac → Alibaba Asia: banner-exchange timeout even
though SSH worked fine to a European VPS). The fix: that node initiates its
own `ssh -R` to a third node that Mac CAN reach.

```
                              Mac (sync-server localhost:8766)
                              ▲
                              │  ssh -fN -R 8766:localhost:8766 (Mac → VPS-EU)
                              │
                              VPS-EU (transit-hub, openclaw user, no sudo)
                              ├ localhost:8766 = Mac via Mac's tunnel
                              └ localhost:8767 = Asia VPS via its own tunnel
                              ▲
                              │  ssh -fN -R 8767:localhost:8766 (Asia VPS → VPS-EU)
                              │
                              Asia VPS (sync-server localhost:8766)
```

The transit-hub runs `sync-run --all` periodically and converges everyone.
No spoke ever exposes a public port; the transit-hub only exposes port 22
(which was already open); the only required network capability anywhere is
"outbound SSH to one node the other spokes can also reach outbound."

This generalizes: any number of spokes can join the same transit-hub by
reverse-tunneling in. The transit-hub's bearer is the only thing that's
shared. Each spoke needs SSH access to the transit-hub (one pubkey paste
into `~/.ssh/authorized_keys` per spoke, no sudo).

**Real session evidence:** the 3-node mesh (Mac in San Francisco / VPN + a
HOSTKEY VPS in Milan + an Alibaba VPS in Asia) ran this exact topology after
every other public-port approach hit a firewall wall. 33k + 7k rows synced
cleanly via SSH tunnels at ~165 s/round.

**Topology update (2026-06-11):** the Mac↔VPS-EU leg has since migrated to
the canonical pattern B via `sync-join` (VPS-EU is now the hub on loopback;
the Mac dials in with a supervised `-L` tunnel). The Asia spoke still uses
its D-style reverse tunnel into VPS-EU, whose 5-min schedule keeps the
third node converged — C/D remain the right tools when a node can't be a
normal `-L` client.

---

## Roadmap / backlog

Surfaced while taking sync from tracer-bullet to a live 3-node mesh
(Mac + two VPSes). Ordered roughly by priority.

### 1. Mesh-bootstrap wizard ⭐ (top priority, the consolidating product feature)

The end-state of everything else below. A prompt-driven, agent-mediated
setup that empirically discovers reachability between user's nodes, picks
the best topology automatically (deployed pattern A → B → C → D from above,
in decreasing order of "ideal" reachability), and emits ready-to-paste
prompts for each agent. The user never has to know whether their setup is
"VPS-as-hub" or "Mac-as-hub" or "transit-hub" — the wizard figures it out
and explains the choice.

**UX sketch** (interactive, via Mac CLI or a memex MCP tool):

```
$ memex-sync mesh bootstrap

Wizard: Which agents do you have? (multi-select)
        [ ] OpenClaw  [ ] Hermes  [ ] Kimi  [ ] Custom

Wizard: For each, paste the probe prompt into the agent's chat and paste the
        reply back here. (The probe is read-only — `whoami`, `nc -z github.com:443`,
        `ss -ltn`, `sudo -ln`, etc.)

[Wizard parses all replies]

Wizard: Building reachability matrix…
        ✓ Mac can reach OpenClaw-VPS on :22 (banner OK, ~120ms)
        ✗ Mac can reach Kimi-VPS on :22 (banner timeout — your VPN proxy
          relays SSH to Europe, drops it to Asia)
        ✓ Kimi-VPS can reach OpenClaw-VPS on :22 (Asia → Europe, ~280ms)
        ✓ All three reach github.com:443 — internet works everywhere

Wizard: Best plan: **Mac-as-hub with OpenClaw-VPS as transit**.
        Why: Kimi can't be reached from Mac directly (proxy block); but
        Kimi CAN reach OpenClaw-VPS, which Mac CAN reach. So OpenClaw-VPS
        becomes a transit point. (Deployed pattern D from SYNC.md.)
        No public ports needed anywhere.

        [show topology diagram]
        [confirm: y/n]

Wizard: Generating setup prompts. Paste each into the indicated chat:

        — Prompt for OpenClaw:  [add Mac pubkey + add Kimi pubkey + sync-add mac + sync-schedule]
        — Prompt for Kimi:      [ssh -R outbound to OpenClaw]
        — Mac will:             [ssh -R outbound to OpenClaw + start local sync-server]

Wizard: Paste OpenClaw's reply confirming pubkeys added…
        Paste Kimi's reply confirming ssh -R up…

Wizard: Establishing Mac's ssh -R… [does it]
        Verifying via marker propagation… [posts a marker to local sync-server,
          polls each agent over their tunneled connection until the marker
          appears in their DB]
        ✓ marker reached OpenClaw in 8s
        ✓ marker reached Kimi in 14s (via transit)
        Mesh up.

Wizard: Installing durability layer…
        ✓ LaunchAgent on Mac with autossh-style retry for ssh -R to OpenClaw
        ✓ systemd-user on Kimi for ssh -R to OpenClaw with restart
        Mesh self-heals on Mac sleep/network change.
```

**Implementation shape:**

- `lib/sync/bootstrap.js` — a state-machine wizard.
- `memex_mesh_bootstrap` MCP tool — agent-facing entry; Mac's Claude Code
  invokes it, the conversation IS the wizard.
- `scripts/probe-prompt.sh` (or generated) — the standard read-only probe
  any agent runs once and replies with structured output.
- Topology decision is the empirical heart: a reachability matrix +
  preference order (A > B > C > D in the deployed-patterns section).
- Marker propagation is the end-to-end test: posts a known message via Mac's
  sync-server, polls each remote until it appears, gives a per-hop latency.

This is the consolidating feature that absorbs items 2, 3, and the older
auto-hub election idea: every constituent decision (which port to use, when
to fall back to SSH, when to ssh -R, whether to ssh-R-chain) becomes a
branch in the wizard's decision tree, made from empirical data rather than
operator guesswork.

### 1b. Self-healing tunnels — durability that ships to every user ⭐

When the mesh runs on patterns C or D (SSH reverse tunnels), the tunnels
themselves are fragile: laptop sleep, network change, VPN toggle, or VPS reboot
kills them. **This is not theoretical — it cost real data.** On 2026-06-07 the
Mac↔VPS1 tunnel had been dead since a sleep on ~06-02; six days of OpenClaw
research (incl. the whole ECC investigation, ~125 rows) sat stranded on the VPS
and never reached the main store. The 5-min schedule kept firing into a dead
tunnel and **failed silently**. Two lessons drive this design:

  1. **Auto-heal** so breaks are rare and short.
  2. **Never fail silently** — when a break *can't* self-heal (key rotated, VPS
     gone, account suspended), the user must find out in hours, not days. The
     second matters more than the first.

#### Proven reference implementation (live, 2026-06-07)

Hand-built and verified on the Mac hub — this is the prototype the product
should generate:

- `~/.memex/sync-tunnel.sh` — `exec ssh -N … -o ServerAliveInterval=30
  -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 127.0.0.1:8766:127.0.0.1:8766
  openclaw@VPS` (foreground, no `-f`; explicit IPv4 loopback to avoid the
  earlier `::1`-only bind bug).
- `~/Library/LaunchAgents/com.parallelclaw.memex.synctunnel.plist` — `KeepAlive=true`
  + `RunAtLoad=true` + `ThrottleInterval=15`. launchd respawns ssh whenever it
  exits (sleep/wake, network change, drop).
- **Self-test passed**: killed the ssh PID → launchd respawned it in ~15s →
  loopback listener + sync endpoint (cert D2:96) back automatically.

#### Architectural decision: supervise the tunnel *inside the memex daemon*

The reference is a "dumb" OS supervisor over a raw `ssh`. The product should go
one level up: **fold tunnel supervision into the long-running memex process**
(the sync-server / capture daemon the OS already keeps alive). Then the OS keeps
ONE thing alive (memex); memex keeps the tunnel alive. Benefits:

- **One supervisor tree**, not two (OS→ssh becomes OS→memex→ssh).
- memex still delegates crypto/transport to `ssh` (no SSH reimpl) but owns
  **retry/backoff, error classification, and health** — so it can show status
  and surface failure (impossible when ssh is an opaque sibling of launchd).
- `ssh` stays a child process; on hub nodes no *new* OS unit is needed (reuse
  the existing sync-server unit). Spoke-only nodes (no server) get a dedicated
  keeper unit.

#### Components

1. **In-daemon tunnel keeper.** Tunnel spec in `config.json`
   (`{peer, direction, local_port, remote_port, ssh_target, identity}`).
   Supervisor loop: spawn ssh → on exit, **classify** the failure:
   - *auth failure* → STOP + surface (don't loop forever on a dead key);
   - *network unreachable* → exponential backoff (cap ~2 min);
   - *bind conflict* (stale remote listener after a drop) → fast retry, the
     listener clears within seconds;
   - *clean drop* → immediate re-establish.
2. **Zombie-tunnel detection.** TCP-up ≠ data-flowing (the `nc -z` lies through
   the Xray proxy bit us already). Keeper periodically curls `/sync/health` with
   the bearer *through* the tunnel; if TCP is up but data is dead, recycle it.
3. **OS-unit generation** (extend `lib/sync/service.js`, which already builds
   server + schedule units). Add tunnel-keeper variants only where a spoke runs
   no server: `buildTunnelLaunchAgentPlist` (KeepAlive) / `buildTunnelSystemdUnit`
   (`Restart=always` + `RestartSec` + linger). Reuse the existing
   `MEMEX_SYNC_EXPERIMENTAL` injection + log-path conventions.
4. **Observability — `memex sync status`.** Per peer: tunnel state
   (up/healing/down), last successful sync, last heal time, consecutive
   failures, last error class. Turns "it silently broke" into a glance.
5. **Failure surfacing (the core lesson).** When a peer's sync has been failing
   past a threshold (e.g. tunnel down > 1 h), surface it loudly:
   - a line in the SessionStart auto-context: *"⚠️ sync to peer X down 6 days —
     N conversations not backed up"*;
   - optionally an OS notification.
   This is what would have caught the 2026-06-07 incident on day one.
6. **Install UX + proof.** `memex sync durability install` (or the wizard's final
   step): detect OS → generate + load unit(s) → **run the kill→respawn self-test**
   → report "self-healing active (verified)". Shipping the self-test means the
   user gets *proof*, not a promise.

#### Edge cases the productized version must handle

- **Idempotency** — re-install must not stack duplicate tunnels/units.
- **Passphrase keys** — reference key had none; a protected key needs
  agent/keychain integration (`UseKeychain`/`AddKeysToAgent` on macOS, ssh-agent
  on Linux). Detect and guide.
- **Multiple peers** — a hub may dial out to N spokes; the keeper manages N specs.
- **No-VPS users** — patterns C/D need one publicly-reachable sshd (the VPS as
  rendezvous). Users with two laptops and no VPS have nowhere to dial; that
  segment needs a relay (bring-your-own $5 VPS, or a future managed
  memex-relay — see the OSS-free / managed-tunnels-paid split noted in backlog
  discussion). Don't pretend SSH-R covers them.

### 2. `sync-server invite` external-reachability check

`memex_sync_invite` currently probes only the *local* port (127.0.0.1). It
happily emits a blob whose `host` is a public IP that's actually firewalled at
the cloud layer (the Alibaba case). It should additionally attempt an external
reachability hint and warn: "listening locally but the public host may be
blocked by your cloud Security Group — verify, or pair the spoke outbound to an
already-reachable hub instead."

### 3. Transport auto-management (deferred from Phase 6)

The transports work today via manual steps; automate the setup:
- **autossh** LaunchAgent/systemd to keep an SSH tunnel up (for SSH-reachable
  hubs without an open public port).
- **Tailscale** auto-detect + `tailscale up` from a prompt (needs a one-time
  auth key — moves the human action to the TS console, doesn't remove it).
- **mDNS LAN** discovery (`_memex._tcp.local`) for two machines on the same
  Wi-Fi with no VPS.

### 4. Kimi Code CLI capture bridge

The standalone Kimi Code CLI writes `~/.kimi/sessions/<uuid>/context.jsonl`
(roles `_system_prompt`/`_checkpoint`/…) which the capture daemon doesn't watch
or parse. (Kimi accessed *through* OpenClaw — channel `kimi-web` — is already
captured.) An inbox-bridge (`kimi-to-memex` → `~/.memex/inbox/`) keeps the sync
engine untouched and isolates us from Moonshot format changes. Low priority —
the OpenClaw path already covers the common case.

### 5. Push-side skip surfacing

`POST /sync/push` applies rows via the shared row-applier, which counts `skipped`,
but the HTTP response doesn't return it to the pushing client (only the pull path
surfaces skips). A server-side FTS corruption could silently drop pushed rows
without the client knowing. Mirror the pull-side retry/abort on the server, or
return `skipped` in the push response so the client can react.

### 6. Provenance: per-row `origin` (node identity) ⭐ next minor candidate

In a synced mesh, nothing records WHICH node captured a row. Two live failures
on the maintainer's 3-node mesh (2026-06-12), both from agents querying their
own synced DB:

- An agent looked for its peer's sessions, found no `source='vps1'` (a label
  it *invented* — telling: that's how users expect it to work), and concluded
  sync was broken. The 12,826 peer rows were present all along — blended into
  the same `source='openclaw'` its own capture uses.
- Sharper: **conversation-key collision across nodes.** Two OpenClaw instances
  (different VPSes) both capture the same human's Telegram presence, keyed by
  the same Telegram id → both write `openclaw-tg-<id>` and sync MERGES two
  different agents' dialogues into ONE interleaved conversation. msg_id-dedup
  keeps it lossless, but "what did I discuss with agent A vs agent B" is
  unanswerable.

Fix shape (additive, wire-compatible):
- `origin` column on messages (e.g. short host label or stable node id),
  stamped at CAPTURE time, carried verbatim on the wire like `channel`.
- `origin:` filter in `memex_search` + origin shown in `get_conversation`
  headers; `memex_overview` breaks counts down per origin.
- Do NOT namespace conversation ids by node — same-chat dedup across nodes is
  a feature (live capture + export of the same chat must still converge).
  Provenance belongs on the row, not in the key.
- Backfill: existing rows get the local node's origin at migration time on
  each node BEFORE the next sync round (rows already replicated elsewhere
  keep NULL = "pre-provenance era"; honest and cheap).

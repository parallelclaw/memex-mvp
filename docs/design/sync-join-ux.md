# `memex sync join` — lazy-user UX spec (sync MVP)

**Status:** design, pre-implementation (2026-06-09).
**Scope:** the canonical 2-node case ONLY — Claude/Cursor on a Mac ↔ one
always-on agent (OpenClaw today) on a VPS. No multi-node mesh, no transit hub,
no Kimi. Harness-agnostic by construction (see §7).

## 1. Goal / promise

> "You have Claude/Cursor on your Mac and an agent on a VPS. Connect their
> memory in **2 copy-paste steps**. No ports, no firewall, no manual SSH keys,
> no manual services. It stays synced, self-heals after sleep, and tells you if
> it breaks."

## 2. Architecture (locked)

- **VPS = always-on hub.** Runs `sync-server` on **127.0.0.1** (loopback —
  never exposed to the internet, zero firewall / Security-Group changes, no
  sudo for low ports). The agent already captures into this memex.
- **Mac = client.** A durable **forward** SSH tunnel `ssh -L
  <localPort>:127.0.0.1:<remotePort> <ssh_target>` reaches the VPS server over
  loopback. Mac syncs to `https://127.0.0.1:<localPort>`.
- **Always tunnel** for the MVP (no direct-port probing). SSH (port 22) is never
  firewalled and the VPS owner already has SSH — so the tunnel always works and
  needs zero network config. Direct public port = future "advanced" opt-in,
  encoded by *omitting* `ssh_target` from the token (§4).
- Durability/observability reuse what we already built & field-tested:
  `sync-tunnel.sh` + launchd/systemd KeepAlive, the hourly watchdog, the
  schedule timer.

## 3. The two steps

### Step 1 — on the VPS (one prompt to the agent)
The agent runs a single bootstrap that:
1. `memex sync-server install` → durable loopback server (survives reboot).
2. Ensures bearer + self-signed cert exist.
3. Emits a **join token** (§4) and prints: *"Paste on your Mac:
   `memex sync join <token>`"*.

The agent has shell on the VPS, so it can also add the Mac's pubkey to
`authorized_keys` when needed (§5) — the user never edits authorized_keys.

### Step 2 — on the Mac (one command)
```
memex sync join <token>
```
Orchestration (each step idempotent, re-runnable):
1. **Parse + validate** token (prefix, not expired, required fields).
2. **Probe SSH** `ssh -o BatchMode=yes -o ConnectTimeout=8 <ssh_target> true`.
   - OK → continue (happy path for VPS owners — no key exchange at all).
   - Fail → print Mac pubkey + fallback instruction (§5), exit 2.
3. **Durable tunnel:** write `~/.memex/sync-tunnel.sh` + load launchd unit
   (`com.parallelclaw.memex.synctunnel`, KeepAlive). Pick `localPort` 8766, or
   next free if busy.
4. **Verify tunnel** `curl -sk https://127.0.0.1:<localPort>/sync/health` →
   must present a cert whose fingerprint == token `cert_fp` (else §6 stale-cert).
5. **Register remote** (`sync-add`/`sync-pair`) alias `vps`, url loopback,
   bearer, cert_fp.
6. **First sync** `sync-run vps` → show pulled/pushed.
7. **Schedule** `sync-schedule install --every 15m`.
8. **Watchdog** install (hourly health → notification + alert file).
9. **Marker self-test:** write a unique local marker, sync, confirm it reached
   the VPS and a VPS marker reached the Mac; print round-trip time; delete both
   markers. (This is the exact test we ran live 2026-06-09 — now built in.)
10. **Success summary** + `memex sync status` hint.

## 4. Join token

`memex-join:` + base64url(JSON). Extends the existing pair-blob with `ssh_target`:
```
{ v:1, ssh_target:"openclaw@203.0.113.7", port:8766,
  bearer:"<64hex>", cert_fp:"sha256:…", exp:<unix> }
```
- `ssh_target` **present** → Mac sets up the SSH tunnel (canonical case).
- `ssh_target` **absent** → token = today's pair-blob; Mac connects directly to
  `host:port` (advanced/clean-VPS case). One token type, both patterns.
- **Sensitive** (carries bearer) → short TTL (default 30m), treat like a password.

## 5. Key exchange — delegated, never manual

Chicken-and-egg: the VPS can't know the Mac pubkey at Step 1.
- **Happy path:** VPS owner already has SSH Mac→VPS → §3.2 probe passes → done.
- **Fallback:** probe fails → `join` prints the Mac's `~/.ssh/id_ed25519.pub`
  (generates one if absent) and: *"Give this key to your VPS agent (it will add
  it to authorized_keys), then re-run `memex sync join <token>`."* The agent
  appends it. User re-runs. **User never touches authorized_keys by hand.**

## 6. Error branches (message → next action)

| Condition | Message / action |
|---|---|
| Token malformed | "Not a valid join token — re-copy the whole line." |
| Token expired | "Token expired (>TTL). Ask your agent to emit a fresh one." |
| SSH probe fails | pubkey-paste fallback (§5), exit 2. |
| Tunnel up, cert ≠ token fp | "Server fingerprint doesn't match the token — token is stale or wrong host. Re-emit on the VPS." (MITM/stale guard) |
| Local port all busy | "Couldn't bind a local port — close another tunnel or pass --port." |
| Tunnel up, sync refused | "Tunnel up but nothing answers — is the server running? On VPS: `memex sync-server status`." |
| Marker test inconclusive | **Warn, don't fail:** "Setup complete; round-trip not confirmed in 30s — data may sync on the next cycle. Check `memex sync status`." |

## 7. Harness-agnostic (why this also covers Hermes later)

The **Mac side is identical** regardless of what runs on the VPS — it only speaks
memex-sync over a tunnel. Only **Step 1's prompt** is agent-specific. So adding
Hermes = a different Step-1 prompt + a Hermes capture adapter; **zero** change to
`sync join`. (Capture is harness-specific; transport is not.)

## 8. Companion: `memex sync status`

One glance: remote alias, tunnel state (up/healing/down), last successful sync,
schedule + watchdog state, last error class. Turns "it silently broke" into a
line. (Productizes the watchdog signal.)

## 9. Reuse vs new

- **Reuse:** `sync-server install`, pair-blob, `sync-add`/`sync-pair`,
  `sync-run`, `sync-schedule install`, our `sync-tunnel.sh` + watchdog patterns.
- **New:** `memex sync join` orchestrator; `ssh_target` field + `memex-join:`
  prefix on the blob; tunnel-as-launchd built by `join` (forward `-L`);
  marker self-test as a reusable verify step; `memex sync status` polish.

## 10. Out of scope (MVP)

Multi-node mesh / transit hub; no-VPS (laptop↔phone) → needs a relay (later,
monetization); direct-public-port as default; Windows/Linux client polish
(Mac-first); Hermes capture adapter (separate fast-follow milestone).

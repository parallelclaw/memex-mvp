# memex-bot — Telegram capture surface for memex

A Telegram bot that lets you capture thoughts, voice notes, and forwarded
messages on the go. Everything you send (or forward) flows into the same
FTS5 corpus as the rest of your memex memory.

## How it works

```
You message @your_memex_bot
    ↓
bot process (long-poll getUpdates)
    ↓
builds Telegram-export-format JSON snippet
    ↓
~/.memex/inbox/bot-<ts>-<msg_id>.json
    ↓
[memex MCP server's existing inbox watcher imports → memex.db]
```

The bot writes JSON files in the same shape as a Telegram Desktop export.
The existing `importTelegram` parser in `server.js` ingests them. **Zero new
ingest code path** — voice transcripts, forwards, and direct messages all
land as ordinary `tg-<your_user_id>` conversation rows, indistinguishable
from imported chats.

## What's captured

| Input                 | Stored as                                                      |
|-----------------------|----------------------------------------------------------------|
| Text message          | `text` field, `from = "me"`                                    |
| Forwarded message     | `↪ Forwarded from <X>:\n\n<text>` (so it's searchable via FTS5)|
| Voice note (v0.2+)    | Nexara transcript prefixed with `🎙`; original OGG kept on disk|
| Photos / documents    | _Not yet — acknowledged with a warning so you know._           |

Idempotency is automatic: each message uses Telegram's stable `msg.id` and
the `messages` table has `UNIQUE(source, conversation_id, msg_id)`. Restarts
and re-emits are safe.

## Setup

### 1. Create a bot

Talk to [@BotFather](https://t.me/BotFather) on Telegram:

1. `/newbot`
2. Give it a name (shown to you only) and a username (must end in `bot`).
3. Save the **HTTP API token** BotFather gives you.

### 2. Find your numeric Telegram user_id

Talk to [@userinfobot](https://t.me/userinfobot) — it replies with your
numeric `id`. Save it.

### 3. Write `~/.memex/bot.config.json`

```json
{
  "telegram_bot_token": "1234567890:ABCdef...",
  "allowlist_user_ids": [123456789],
  "voice_enabled": true,
  "nexara_api_key": "nx-..."
}
```

- `telegram_bot_token` — required.
- `allowlist_user_ids` — required. Only these Telegram user_ids can talk to
  the bot; everyone else gets a polite reject. The bot is single-user.
- `nexara_api_key` — optional; only needed for voice transcription.
- `voice_enabled` — defaults to `true` if `nexara_api_key` is set,
  otherwise off. Set explicitly to `false` to disable even with a key.

### 4. Run it

Foreground (debug):
```sh
npx memex-bot
```

Or as a launchd autostart agent (macOS):
```sh
npx memex-bot install
```

Then send a test message to your bot. Within a few seconds:
1. A JSON file appears in `~/.memex/inbox/`.
2. The memex MCP server's inbox watcher imports it.
3. It's searchable via `memex_search` and visible in `memex_recent`.

### CLI

```
memex-bot                run foreground
memex-bot install        register macOS LaunchAgent
memex-bot uninstall      remove LaunchAgent (config preserved)
memex-bot restart        reload after a config edit
memex-bot status         show installed/running/offset/last-activity
memex-bot logs           tail -f the bot log
```

## Bot commands

| Command            | What it does                                            |
|--------------------|---------------------------------------------------------|
| `/help` or `/start`| Print usage                                             |
| `/search <query>`  | Top-3 FTS5 matches across all memex sources             |
| `/recent`          | 5 most recent captured messages, any source             |

Anything else is captured as text. Unknown slash-commands are too — so a
typo never silently swallows your thought.

## Offline behavior

**The bot is local-only — no cloud relay.** When your laptop is asleep or
offline:

- Telegram buffers updates ~24 hours server-side. The bot picks them up on
  next poll.
- For longer gaps, **export the bot chat from Telegram Desktop** and drop
  the resulting `result.json` into `~/.memex/inbox/`. The `UNIQUE`
  constraint dedupes against anything already captured, so it's safe to
  re-import overlapping ranges.

This is a deliberate design choice: cloud relays would break memex's
local-first wedge for what amounts to a convenience feature. If you need
guaranteed delivery for a 3-week trip, plan for the manual export step.

## Files & paths

| Thing                  | Path                                                            |
|------------------------|-----------------------------------------------------------------|
| Config                 | `~/.memex/bot.config.json`                                      |
| Inbox JSONs            | `~/.memex/inbox/bot-<ts>-<msg_id>.json` → archived after import |
| Voice OGGs             | `~/.memex/data/conversations/telegram/media/<msg_id>.oga`       |
| Update offset state    | `~/.memex/data/bot-state.json`                                  |
| Log                    | `~/.memex/data/bot.log`                                         |
| LaunchAgent plist (mac)| `~/Library/LaunchAgents/com.parallelclaw.memex.bot.plist`       |

## Architecture notes

- **No webhook** — long-polling via `getUpdates` only. No public URL, no
  HTTPS, no port forwarding. Works behind any NAT.
- **No new ingest code path** — bot writes files; the existing inbox
  watcher in `server.js` parses them.
- **Read-only DB access** for `/search` and `/recent`. The bot opens
  `memex.db` in `readonly` mode; WAL allows concurrent readers alongside
  the running MCP server.
- **No new dependencies.** Native `fetch` and `FormData` (Node 18+, which
  memex already requires) handle Telegram and Nexara HTTP. `better-sqlite3`
  was already in the parent `package.json`.

## Out of scope (for now)

- Webhook mode
- Cloud relay / always-on infrastructure
- Multi-user (bot serves exactly one TG user_id)
- Rich UI inside bot (button-based memory browser)
- LLM auto-summarization (would break memex's verbatim principle)
- Tag/category system (FTS5 + recency boost is enough for discovery)
- URL fetching (paste link → ingest cleaned HTML)
- Periodic reminders ("you haven't captured anything in 7 days")

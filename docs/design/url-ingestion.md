# Design · URL ingestion via `memex_store_document`

Status: design (not yet implemented)
Target version: v0.6.0
Last updated: 2026-05-14

## Goal

Let users save the content of any public web page (Perplexity research threads, articles, AI chat shares, GitHub issues, …) into their memex memory through their AI agent — so that content becomes searchable across all MCP-compatible clients alongside captured Claude Code / Cowork / Cursor / Telegram conversations.

## Non-goals (v0.6.0)

- Telegram bot URL auto-ingestion (deferred to a later release; the bot can already store URL-as-text)
- Browser bookmarklet / extension (deferred to v0.7.x)
- Auto-fetch and traversal of links inside saved pages
- Custom per-site parsers (ChatGPT/Gemini/Claude.ai share formats) — store as single document
- Memex performing any outbound HTTP itself

## Architectural principle

**Memex stays 100% passive (no outbound network calls). The agent does all fetching using its own tools (WebFetch, WebSearch, shell `curl`). Memex only stores what it's handed and teaches the agent how to handle edge cases.**

```
┌─────────────────────────────────────────────────────────────┐
│ Agent (Claude Code / Cursor / Cline / Continue / Zed)       │
│   • fetches URL via its own tools                            │
│   • applies the Jina-trick if Cloudflare-blocked             │
│   • passes raw content to memex                              │
└─────────────────────────────────────────────────────────────┘
                          ↓
            memex_store_document(content, url, title)
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Memex (passive):                                             │
│   1. Sniffs content for known failure patterns               │
│   2. Stores verbatim if valid                                │
│   3. Returns conversation_id + actionable warnings if not    │
└─────────────────────────────────────────────────────────────┘
```

Memex teaches the agent the Jina-trick through three layers (defined below):

1. **Tool description** — compact reference, read at registration
2. **SERVER_INSTRUCTIONS** — full reference in master prompt
3. **Runtime warnings** — reactive coaching on failed stores

If the agent ignored ① and ②, ③ corrects on-the-fly. Resilient teaching.

---

## Tool spec: `memex_store_document`

```javascript
{
  name: 'memex_store_document',
  description: '<see "Channel 1" below>',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The fetched page content as text/markdown. You (the agent) fetch this yourself via WebFetch or shell tools. Memex stores it verbatim — no LLM processing, no summarization.'
      },
      url: {
        type: 'string',
        description: 'The original source URL (used for conversation_id, deduplication, and metadata). For non-URL pastes, omit; memex will assign a synthetic ID.'
      },
      title: {
        type: 'string',
        description: 'Page title or document name. Becomes the conversation title in memex_list_conversations. If omitted, memex extracts from content (first heading or fallbacks).'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags stored in metadata (e.g. ["research", "perplexity"]). For future tag-based filtering.'
      },
      refresh: {
        type: 'boolean',
        default: false,
        description: 'If URL already ingested, set true to refetch and replace stored content. Default false = no-op with note "already in memex".'
      }
    },
    required: ['content']
  }
}
```

Returns:

```javascript
{
  conversation_id: string | null,  // null if stored: false
  title: string,
  length: number,                  // characters stored
  stored: boolean,
  source: "web",
  url: string,
  fetched_via: "agent",            // always — memex never fetches
  warnings: Warning[]              // see "Runtime warnings" section
}
```

---

## Schema additions

New `source` enum value: `"web"`

### Conversation_id construction

```javascript
function urlToConvId(url) {
  // Canonicalize: lowercase host, strip tracking params, normalize trailing slash
  const canonical = canonicalize(url);
  const hash = sha256(canonical).slice(0, 12);
  return `web-${hash}`;
}
```

Examples:
- `https://www.perplexity.ai/search/abc-123` → `web-7f3a9d8e1b4c`
- `https://en.wikipedia.org/wiki/Memex` → `web-a1b2c3d4e5f6`

Stable across re-ingests of the same URL → free deduplication.

### Conversation row

```
conversation_id: "web-<hash>"
source: "web"
title: <page title>
first_ts: <first ingest ts>
last_ts: <latest ingest ts>
message_count: <number of versions stored, usually 1>
project_path: NULL
parent_conversation_id: NULL
```

### Message row

```
source: "web"
conversation_id: "web-<hash>"
msg_id: <ts of ingest as string — unique per refetch>
role: "document"
sender: <domain>           e.g. "perplexity.ai", "github.com"
text: <full content verbatim>
ts: <ingest ts>
edited_at: <ingest ts>     (used for refresh ordering)
uuid: NULL
metadata: {
  url: "<original URL>",
  canonical_url: "<canonicalized>",
  title: "<page title>",
  fetched_via: "agent",
  captured_via: "mcp-tool" | "user-paste",
  domain: "<domain>",
  fetched_at: <ts>,
  tags: ["..."],
  content_length: <number>,
  warnings_at_store: [...]   // for audit if anything sniffed
}
```

### FTS5 indexing

`messages_fts` already indexes by `text, sender, conversation_id, source`. Web documents flow in via the same triggers — no schema change needed.

### `memex_list_sources` output

Add `"web"` to the enumerated sources. Will show:

```
Source: web
  Conversations: 12
  Messages: 12
  Latest: 2 hours ago
```

---

## Channel 1 · Tool description (copy-paste ready)

```
Save an external document (web page, AI chat share, pasted text) to memex memory. Memex stores verbatim what you pass — it does NOT fetch URLs itself, that's your job (memex stays 100% local, no outbound network calls).

TYPICAL FLOW for a URL:
  content = WebFetch("https://example.com/article")
  memex_store_document(content, url="https://example.com/article", title="...")

⚠ THE JINA TRICK — memorize this:
Many modern pages (Perplexity, npm.com, X/Twitter, Medium, ChatGPT shares) sit behind Cloudflare bot-protection. Server-side fetches return "Just a moment..." / 403 / "cf-mitigated: challenge" instead of the real content.

Workaround: prepend `https://r.jina.ai/` to the URL.
  Before: https://www.perplexity.ai/search/abc123
  After:  https://r.jina.ai/https://www.perplexity.ai/search/abc123

Jina AI Reader (https://jina.ai/reader/) bypasses Cloudflare (runs a real browser server-side) and returns clean markdown. Free, no API key needed for personal use. Both http:// and https:// after `r.jina.ai/` work.

Heuristic — when to retry through Jina:
  • HTTP 403 with cf-mitigated header
  • Body contains "Just a moment..." / "Verifying you are human" / cf-turnstile
  • Body < 500 bytes from a substantive page
  • Body is mostly <script src="...turnstile..."> nonsense

PERPLEXITY THREADS need to be made PUBLIC first (Share → Public link in Perplexity). Private threads return "This thread is private" even via Jina — memex will detect this on store and tell you what to say to the user.

PRIVATE / LOGIN-WALLED content (NYT paywall, your private ChatGPT chats) can't be fetched server-side. Tell the user — don't try to scrape.

PROACTIVE OFFER: When the user shares a substantive URL they're DISCUSSING or RESEARCHING (not just casually mentioning), offer to save it. Especially for Perplexity threads — that research is ephemeral and worth preserving.

Returns: {conversation_id, title, length, stored, warnings[]}

If stored=false, the `warnings` array tells you exactly what went wrong and how to fix it — surface that message to the user.
```

---

## Channel 2 · SERVER_INSTRUCTIONS section (copy-paste ready)

Add this section to the existing SERVER_INSTRUCTIONS block in `server.js` (between the existing search-tools section and the safety section):

```
══ DOCUMENT INGESTION (web pages, articles, AI chat shares) ══

memex_store_document accepts content YOU fetch and stores it verbatim.
Memex never fetches by itself — that's your job. Reasons:
  • Memex stays 100% local (no outbound network egress narrative)
  • You have better tools (WebFetch, WebSearch, shell curl)
  • You have context for error recovery (can ask user to paste)

THE JINA TRICK (full reference):

Modern web is mostly Cloudflare-protected. Server-side fetchers
(including most agent WebFetch implementations) hit a JS challenge and
return interstitial content instead of the page itself. The free
workaround is Jina AI Reader:

  Original:  https://example.com/whatever
  Wrapped:   https://r.jina.ai/https://example.com/whatever

This works for:
  ✓ Perplexity shared threads (must be Public!)
  ✓ npm.com package pages
  ✓ X/Twitter threads (public ones)
  ✓ Medium articles
  ✓ Substack public posts
  ✓ Most modern SaaS marketing pages

This doesn't help for:
  ✗ Login-walled content (paywall, private accounts)
  ✗ SPA with no SSR (Jina gets empty initial HTML)
  ✗ Geo-restricted content

DETECTION HEURISTIC — when to retry through Jina:
After your first WebFetch, retry through Jina if you see:
  • HTTP 403 with header `cf-mitigated: challenge`
  • Body contains "Just a moment..." / "Verifying you are human"
  • Body contains `cf-turnstile` or `cf_chl_opt`
  • Body < 500 bytes from a page that should be substantive
  • Page is just a script tag pulling Cloudflare challenge JS

After Jina retry, if you get clean markdown — pass to memex_store_document.
If Jina ALSO returns "This thread is private" / "Sign in" / login form —
that's authentication, not Cloudflare. Jina bypasses Cloudflare, not auth.
Tell the user what to do (see Perplexity-specific guidance below).

PERPLEXITY-SPECIFIC:
Perplexity shared threads need to be marked "Public" by the owner.
The URL in your browser address bar (perplexity.ai/search/<id>) is the
OWNER'S private URL, not the shareable one. The user must:
  1. Open the thread in Perplexity
  2. Click Share → toggle Public link
  3. Copy the new URL Perplexity shows
  4. Give you THAT URL

If memex_store_document returns warning type=perplexity-private, surface
the message verbatim — it has the exact instructions.

PROACTIVE OFFER (TIMING):
When user shares a URL they're DISCUSSING or RESEARCHING:
  "I can save this to your memex memory — you'll be able to search
   it from any AI chat later. Want me to?"

Don't offer for:
  • URLs you're already analyzing in the current turn
  • Same URL twice in one session
  • Casual passing mentions ("like example.com/foo")
  • URLs that are just navigation aids in conversation

Example moments where offering is right:
  • User just finished Perplexity research and is about to move on
  • User pasted a long article they want to discuss
  • User shared a documentation page they keep returning to
  • User shared an AI chat with ChatGPT/Gemini they want to keep
```

---

## Channel 3 · Runtime warnings

When the agent calls `memex_store_document(content, url, ...)`, memex sniffs the content for known failure patterns and either:
- **Blocks the store** (returns `stored: false`) — for clear-cut failure signals
- **Stores with warning** (returns `stored: true` + warnings) — for ambiguous cases

### Blocking warnings (`stored: false`)

These prevent storage and tell the agent to retry differently.

#### `cloudflare-challenge`

**Detection:** content matches any of:
- `/Just a moment\.\.\./i`
- `/Verifying you are human/i`
- `/cf-turnstile/i`
- `/cf_chl_opt/i`
- HTTP 403 was returned to agent (memex can't see this directly — relies on content pattern)

**Warning:**

```
type: "cloudflare-challenge"
message: "The content you passed looks like a Cloudflare bot-challenge page, not the actual content. The page is protected by Cloudflare and your direct fetch was blocked.

Retry by prepending https://r.jina.ai/ to the URL:

  WebFetch(\"https://r.jina.ai/<original-url>\")

Jina AI Reader runs a real browser server-side and bypasses Cloudflare. Returns clean markdown. Free for personal use, no API key needed.

If Jina ALSO fails or returns 'private/login required', the page needs authentication — Jina can't bypass that."
```

#### `perplexity-private`

**Detection:** URL contains `perplexity.ai` AND content contains any of:
- `This thread is private`
- `Sign in if you are the owner of this thread`
- `request access` (in Perplexity-shaped pages)

**Warning:**

```
type: "perplexity-private"
message: "This Perplexity thread is marked private — even Jina Reader can't access it (this is an authentication wall, not Cloudflare bot protection).

Tell the user: 'To save this Perplexity thread to memex, you need to make it public first:
  1. Open the thread in Perplexity
  2. Click Share (top right)
  3. Toggle "Public link" on
  4. Copy the new shareable URL Perplexity shows
  5. Send me THAT URL — it'll work'

The URL in the user's address bar (perplexity.ai/search/<id>) is the owner's private URL, not the shareable one."
```

### Non-blocking warnings (`stored: true` with warning)

These store the content but flag potential issues for the agent to mention.

#### `suspiciously-small`

**Detection:** content length < 200 bytes (after trim).

**Warning:**

```
type: "suspiciously-small"
message: "The content you passed is very short (<200 bytes). The page might have been blocked, redirect-failed, or be JS-rendered with no SSR. Stored as-is — consider verifying with the user that this is what they expected."
```

#### `login-required` (not blocking, often legit)

**Detection:** content contains login-related markers like:
- `Sign in to continue`
- `Please log in`
- `Login required`
- `<form action="/login"`

**Warning:**

```
type: "login-required"
message: "The page appears to require login (visible login form / sign-in prompt). The content you stored may be a login page, not the actual content the user wanted. Ask the user to paste the content manually if this isn't what they expected."
```

#### `paywalled` (not blocking)

**Detection:** content contains payment-related markers:
- `Subscribe to read`
- `Continue reading with subscription`
- `paywall`
- `metered access`

**Warning:**

```
type: "paywalled"
message: "The page appears to be paywalled (subscription/payment prompt detected). The content stored may just be the teaser. If the user has access, they can paste the full content manually."
```

#### `no-title` (informational)

**Detection:** no `<h1>`, no `<title>`, no first non-empty line that looks like a title.

**Warning:**

```
type: "no-title"
message: "Couldn't extract a title from the content. Stored with a generic title based on the URL/domain. The user can rename later if needed."
```

### Detection implementation

```javascript
// lib/store-doc/detect.js
const PATTERNS = {
  cloudflareChallenge: [
    /Just a moment\.\.\./i,
    /Verifying you are human/i,
    /cf-turnstile/i,
    /cf_chl_opt/i,
  ],
  perplexityPrivate: [
    /This thread is private/i,
    /Sign in if you are the owner of this thread/i,
  ],
  loginRequired: [
    /Sign in to continue/i,
    /Please log in/i,
    /<form[^>]+action=["']\/?login/i,
  ],
  paywalled: [
    /Subscribe to read/i,
    /Continue reading with subscription/i,
    /paywall/i,
  ],
};

function detectIssues(content, url) {
  const issues = [];
  // ... pattern matching ...
  // Returns array of {type, blocking, message}
}
```

Patterns may grow over time as new failure modes appear in real use.

---

## Channel 4 · HELP.md section (copy-paste ready)

Add new use case #8 to `HELP.md`:

```markdown
### 8. 🔗 Save URLs to memex from anywhere (Perplexity, articles, AI shares)

You're reading something — a Perplexity research thread, a long article, a GitHub discussion, an AI chat share — and want it to live in your memex memory, searchable from any AI chat forever.

**In any MCP-aware AI agent (Claude Code, Cursor, Cline, Continue, Zed):**

> Save https://perplexity.ai/share/<id> to memex
> Add this article to my memex: https://example.com/great-post
> Capture this ChatGPT conversation: https://chat.openai.com/share/<id>

What happens behind the scenes:
1. The agent fetches the URL using its own WebFetch tool
2. If the page is Cloudflare-protected (Perplexity, npm.com, Twitter, Medium, …), the agent auto-retries via `r.jina.ai` — a free proxy that bypasses Cloudflare bot challenges
3. The agent calls `memex_store_document(content, url, title)`
4. Memex stores the content as a `web` source conversation, searchable like any AI chat

**For Perplexity threads specifically:** the thread must be PUBLIC. In Perplexity:
- Open your thread → click Share → toggle "Public link" → copy that URL → give it to the agent
- The URL in your address bar (`perplexity.ai/search/<id>`) is your OWNER URL, not the shareable one

If you forget, memex will detect the private-thread response and tell you exactly what to do.

**Login-walled or paywalled content can't be fetched by the agent.** For those, paste the content directly:

> Save this text to memex (title: "..."): <paste content>

**Search across all your saved content:**

> Search memex for what Perplexity said about [topic] last week

`memex_search` returns hits from your AI chats AND your saved URLs in one query — all chronologically ranked.

**Pro tip:** Tag URLs at save time for later filtering:

> Save https://... to memex, tag it "research" and "perplexity"
```

---

## Decisions

### D1 · Re-ingest behavior (`refresh` parameter)

**Default:** skip if already in memex. Agent gets warning `already-ingested` and the existing `conversation_id`.

**Opt-in via `refresh: true`:** refetch and replace the stored content. The old content is overwritten — single message per URL.

**Rationale:** users usually save things once. Refresh is the explicit "I know the article changed" case. Avoids accidental duplication and bloat.

### D2 · Sniff strictness

- **Block** (`stored: false`) for: `cloudflare-challenge`, `perplexity-private`. Clear failure signals — storing the challenge page or "private" placeholder pollutes the corpus.
- **Store + warn** for: `suspiciously-small`, `login-required`, `paywalled`, `no-title`. These can be legitimate short pages or partial content the user knew about.

**Rationale:** false positives on suspicious-but-legitimate content (e.g. a real 200-byte FAQ entry) are worse than false negatives on edge cases. Cloudflare-challenge pages are 100% noise; never useful to store.

### D3 · Jina explicitness

In tool description and SERVER_INSTRUCTIONS, **name `r.jina.ai` explicitly** with the exact syntax.

**Rationale:** agents need concrete actionable instructions. Abstract "use a Cloudflare-bypass proxy" gives nothing to actually execute. If Jina changes (renamed, deprecated, replaced), we update memex's text in one release.

### D4 · One tool, not two

No separate `memex_ingest_url` that fetches. Memex remains passive. Agents do the fetching.

**Rationale:**
- Verbatim principle: memex never modifies content (no LLM interpretation)
- Local-first narrative: zero outbound network calls during normal operation
- Composability: agents already have WebFetch with their own engineering invested
- Fewer dependencies in memex's codebase

### D5 · Synthetic IDs for non-URL pastes

If user pastes content with no URL (e.g. screenshot OCR, copied text), `url` is omitted. Memex generates:

```
conversation_id: "web-paste-<hash-of-content>"
url: null
metadata.captured_via: "user-paste"
```

Still searchable via `memex_search`. Still deduplicated (same content = same conversation_id).

---

## Out of scope (deferred to later versions)

- **Telegram bot URL auto-fetch** — bot will eventually use a shared `lib/fetch-url.js` library, but that's v0.7.x work
- **Browser bookmarklet / extension** — needs a localhost HTTP endpoint on the daemon; v0.7.x
- **Recursive link following** — explicitly NO; user must ingest each URL they want
- **Custom site parsers** — store all sites as one document; structured parsing of Perplexity turns, ChatGPT thread structure, etc. is future work
- **Vision-based ingestion** — screenshots, PDFs, images. Different ingestion path, not URL-based
- **Auto-summarization** — explicitly NO, breaks verbatim principle
- **Tag-based search filtering** — `tags` field is captured at store time but `memex_search` doesn't filter by it yet; minor add for v0.6.x

---

## Implementation plan (when this gets coded)

Suggested commit sequence for v0.6.0:

1. **Schema migration** — add `source: "web"` recognition; no DB schema change since the existing `messages` table is generic. Adjust `memex_list_sources` to enumerate `web`.

2. **`lib/store-doc/canonicalize.js`** — URL canonicalization (lowercase host, strip tracking params, etc.)

3. **`lib/store-doc/detect.js`** — pattern detection per Channel 3 specs above.

4. **`lib/store-doc/extract-title.js`** — title extraction (markdown H1, HTML `<title>`, URL slug fallback)

5. **`memex_store_document` tool implementation** in `server.js`:
   - Input validation
   - Detection → blocking warnings → return early if blocked
   - Conversation upsert (with `refresh` handling)
   - Message insert
   - Non-blocking warnings appended to response

6. **Tool description + SERVER_INSTRUCTIONS edits** — copy from Channels 1 and 2 above.

7. **HELP.md update** — use case 8.

8. **Tests** — new `test/store-document.test.js`:
   - Happy path: stores content, returns conversation_id
   - cloudflare-challenge detection: returns stored:false + warning
   - perplexity-private detection: returns stored:false + warning
   - Deduplication: same URL twice → second call returns "already ingested"
   - `refresh: true`: replaces content
   - Synthetic ID for `url: null` paste

9. **Landing page update** — add Use Case 7 about URL ingestion (EN + RU)

10. **Release as v0.6.0** with changelog entry "Adds memex_store_document — agents can now save web pages, AI chat shares, and pasted documents into memex memory. Teaches the Jina AI Reader trick for Cloudflare-protected pages."

Estimated effort: **1–2 days of focused work** for v0.6.0 (no fetch logic to write, just storage + detection + teaching texts).

---

## Open questions for v0.6.x and beyond

- Should `memex_search` get a `source: "web"` filter shortcut? (currently `source` parameter exists, so this works for free — no change needed)
- Should we add a `domain` filter to `memex_search`? (`domain: "perplexity.ai"` would find all saved Perplexity content)
- Should `memex_list_conversations` get a `domain` filter? Same reasoning.
- For Channel 3 patterns: should detection regexes be loaded from a config file so users can extend? Probably not — community-curated patterns in source are more reliable than user-edited config that drifts.

---

## Privacy notes for README

When this ships, README needs to note:

> Memex itself makes ZERO outbound network calls — not for ingestion, not for telemetry, not for anything. When you ask memex to save a URL, your AI agent fetches the URL, not memex. If the agent uses Jina AI Reader (https://jina.ai) for Cloudflare-protected pages, the URL (but not the content of your other memex memory) is visible to Jina. This is the agent's choice, not memex's — memex never sees Jina.

This preserves the local-first narrative while being transparent about the agent-level Jina exposure.

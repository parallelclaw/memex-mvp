// Tests for lib/store-doc/* — the pure-function modules backing
// memex_store_document. We don't boot the MCP server here (that would
// open the real DB and would also be slow); we test the three modules
// in isolation. The handler logic (refresh, dedup, insert) is covered
// by an integration test against an in-memory DB at the bottom.

import {
  canonicalize,
  extractDomain,
} from '../lib/store-doc/canonicalize.js';
import {
  detectIssues,
  isBlocked,
} from '../lib/store-doc/detect.js';
import { extractTitle } from '../lib/store-doc/extract-title.js';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assertEq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// -----------------------------------------------------------------------------
console.log('canonicalize:\n');

test('lowercases scheme + host', () => {
  assertEq(
    canonicalize('HTTPS://Example.COM/Foo'),
    'https://example.com/Foo'
  );
});

test('drops fragment', () => {
  assertEq(
    canonicalize('https://example.com/foo#section-2'),
    'https://example.com/foo'
  );
});

test('strips utm_* tracking params', () => {
  assertEq(
    canonicalize('https://example.com/foo?utm_source=newsletter&utm_medium=email&keep=this'),
    'https://example.com/foo?keep=this'
  );
});

test('strips fbclid / gclid / igshid', () => {
  assertEq(
    canonicalize('https://example.com/foo?fbclid=abc&gclid=xyz&igshid=qwe'),
    'https://example.com/foo'
  );
});

test('drops trailing slash on non-root paths', () => {
  assertEq(
    canonicalize('https://example.com/foo/'),
    'https://example.com/foo'
  );
});

test('keeps trailing slash on root', () => {
  assertEq(
    canonicalize('https://example.com/'),
    'https://example.com/'
  );
});

test('two URLs with different tracking → same canonical', () => {
  const a = canonicalize('https://example.com/post?utm_source=twitter');
  const b = canonicalize('https://example.com/post/?fbclid=abc#footer');
  assertEq(a, b);
});

test('unparseable input returned unchanged', () => {
  assertEq(canonicalize('not a url'), 'not a url');
  assertEq(canonicalize(''), '');
});

test('extractDomain strips www', () => {
  assertEq(extractDomain('https://www.example.com/path'), 'example.com');
  assertEq(extractDomain('https://sub.example.com/path'), 'sub.example.com');
});

// -----------------------------------------------------------------------------
console.log('\ndetectIssues:\n');

test('cloudflare-challenge: blocking, with Jina retry hint', () => {
  const warnings = detectIssues(
    '<html><body>Just a moment...<script src="cf-turnstile.js"></script></body></html>',
    'https://example.com/'
  );
  assert(warnings.length === 1, `expected 1 warning, got ${warnings.length}`);
  assertEq(warnings[0].type, 'cloudflare-challenge');
  assertEq(warnings[0].blocking, true);
  assert(warnings[0].message.includes('r.jina.ai'), 'message should mention Jina');
  assertEq(isBlocked(warnings), true);
});

test('perplexity-private: blocking, only with perplexity URL', () => {
  const warnings = detectIssues(
    '# Perplexity\n\nThis thread is private. Sign in if you are the owner.',
    'https://www.perplexity.ai/search/abc'
  );
  assert(warnings.length === 1);
  assertEq(warnings[0].type, 'perplexity-private');
  assertEq(warnings[0].blocking, true);
  assert(warnings[0].message.includes('Public'), 'message should explain Share→Public');
});

test('perplexity-private NOT triggered when URL not perplexity', () => {
  const warnings = detectIssues(
    'This thread is private on our private Slack',
    'https://example.com/'
  );
  // No perplexity hint anywhere → no perplexity-private warning
  // (note: suspiciously-small is expected here, the content is short)
  const perpWarn = warnings.find((w) => w.type === 'perplexity-private');
  assert(!perpWarn, `expected NO perplexity-private warning, got: ${JSON.stringify(perpWarn)}`);
});

test('suspiciously-small: non-blocking, only with URL', () => {
  const warnings = detectIssues('tiny', 'https://example.com/');
  assertEq(warnings.length, 1);
  assertEq(warnings[0].type, 'suspiciously-small');
  assertEq(warnings[0].blocking, false);
});

test('suspiciously-small NOT triggered for short pastes (no URL)', () => {
  const warnings = detectIssues('tiny user note', null);
  // No URL → user paste → short is fine
  assertEq(warnings.length, 0);
});

test('login-required: non-blocking', () => {
  const warnings = detectIssues(
    'Please log in to continue. This page requires authentication.',
    'https://example.com/'
  );
  // suspiciously-small is also tripped by the short content, that's expected
  const loginWarn = warnings.find((w) => w.type === 'login-required');
  assert(loginWarn, 'expected login-required warning');
  assertEq(loginWarn.blocking, false);
});

test('paywalled: non-blocking', () => {
  const warnings = detectIssues(
    'You\'ve reached your free article limit. Subscribe to read the full article.',
    'https://example.com/'
  );
  const payWarn = warnings.find((w) => w.type === 'paywalled');
  assert(payWarn, 'expected paywalled warning');
  assertEq(payWarn.blocking, false);
});

test('clean substantive content: no warnings', () => {
  const longGoodContent = '# Vannevar Bush\n\n' + 'As We May Think is a 1945 essay. '.repeat(50);
  const warnings = detectIssues(longGoodContent, 'https://example.com/article');
  assertEq(warnings.length, 0);
});

test('blocking detector stops further checks', () => {
  // Cloudflare challenge content also short, but blocking detector wins
  const warnings = detectIssues('Just a moment...', 'https://example.com/');
  assertEq(warnings.length, 1);
  assertEq(warnings[0].type, 'cloudflare-challenge');
});

// -----------------------------------------------------------------------------
console.log('\nextractTitle:\n');

test('markdown H1 wins', () => {
  const t = extractTitle('# Memex Essay\n\nbody...', 'https://example.com/foo');
  assertEq(t, 'Memex Essay');
});

test('HTML <title> as fallback when no markdown H1', () => {
  const t = extractTitle('<html><head><title>Page Title</title></head><body>...</body></html>', null);
  assertEq(t, 'Page Title');
});

test('HTML <h1> as fallback when no title tag', () => {
  const t = extractTitle('<body><h1>Just the H1</h1></body>', null);
  assertEq(t, 'Just the H1');
});

test('HTML entities decoded', () => {
  const t = extractTitle('<title>Tom &amp; Jerry &#39;Show&#39;</title>', null);
  assertEq(t, "Tom & Jerry 'Show'");
});

test('first non-empty short line as fallback', () => {
  const t = extractTitle('A short first line\n\nmore body here', null);
  assertEq(t, 'A short first line');
});

test('URL slug as fallback', () => {
  const t = extractTitle('long body with no headings...'.repeat(50), 'https://example.com/blog/great-post-about-memex');
  assertEq(t, 'great post about memex');
});

test('domain fallback when no path (www stripped)', () => {
  // extract-title also strips www. for cleaner display — same as extractDomain
  const t = extractTitle('long body...'.repeat(50), 'https://www.example.com');
  assertEq(t, 'example.com');
});

test('"Untitled document" final fallback', () => {
  const t = extractTitle('', null);
  assertEq(t, 'Untitled document');
});

test('truncates long titles', () => {
  const long = '# ' + 'A'.repeat(300);
  const t = extractTitle(long, null);
  assert(t.length <= 201, `expected ≤201 chars, got ${t.length}`);
  assert(t.endsWith('…'), 'should end with ellipsis');
});

test('Jina prefix is stripped — H1 inside is used', () => {
  const jinaOutput = [
    'Title: Some App Shell Title',
    '',
    'URL Source: https://example.com/article',
    '',
    'Published Time: Fri, 15 May 2026 00:00:00 GMT',
    '',
    'Markdown Content:',
    '# Real Article Title',
    '',
    'Body of article...',
  ].join('\n');
  const t = extractTitle(jinaOutput, 'https://example.com/article');
  assertEq(t, 'Real Article Title');
});

test('Jina prefix is stripped — H2 used when no H1 (Perplexity case)', () => {
  // Replicates the exact shape Jina returns for a Perplexity thread
  const jinaOutput = [
    'Title: Perplexity',
    '',
    'URL Source: https://www.perplexity.ai/search/abc',
    '',
    'Published Time: Fri, 15 May 2026 00:00:00 GMT',
    '',
    'Markdown Content:',
    'New',
    '',
    '⌘K',
    '',
    'Computer',
    '',
    '## когда выйдет фильм день разоблачения',
    '',
    'Фильм «День разоблачения» выходит...',
  ].join('\n');
  const t = extractTitle(jinaOutput, 'https://www.perplexity.ai/search/abc');
  assertEq(t, 'когда выйдет фильм день разоблачения');
});

test('Non-Jina content with H2 only — H2 used as fallback', () => {
  const md = '## Subtopic heading\n\nBody...';
  const t = extractTitle(md, null);
  assertEq(t, 'Subtopic heading');
});

test('H1 still wins over H2 when both present', () => {
  const md = '## Subtopic\n\n# Main heading\n\nBody...';
  const t = extractTitle(md, null);
  assertEq(t, 'Main heading');
});

test('Jina prefix detection — non-Jina content unaffected', () => {
  // If first 500 chars don't contain "URL Source: http", treat as raw
  const md = 'Title: Looks like Jina but is not\n\n# Real H1\n';
  const t = extractTitle(md, null);
  // Without "URL Source:" marker, prefix is NOT stripped, so first-line
  // fromMarkdownH1 still picks up the H1
  assertEq(t, 'Real H1');
});

test('Jina prefix without "Markdown Content:" line — falls back gracefully', () => {
  // Some Jina edge cases may omit the marker — we should still try to extract
  const malformed = [
    'Title: Page',
    'URL Source: https://example.com',
    '',
    '# Real H1',
  ].join('\n');
  const t = extractTitle(malformed, null);
  // Even without strip, fromMarkdownH1 finds # Real H1
  assertEq(t, 'Real H1');
});

// -----------------------------------------------------------------------------
console.log('\nstore_document integration (in-memory DB):\n');

// Mini integration test: spin up the same SQLite schema memex uses,
// simulate the handler's main path (canonicalize → detect → upsert),
// and confirm the rows look right.
function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, conversation_id TEXT, msg_id TEXT,
      role TEXT, sender TEXT, text TEXT, ts INTEGER, metadata TEXT,
      edited_at INTEGER, uuid TEXT,
      UNIQUE(source, conversation_id, msg_id)
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      source TEXT, title TEXT,
      first_ts INTEGER, last_ts INTEGER, message_count INTEGER,
      parent_conversation_id TEXT, project_path TEXT,
      archived_at INTEGER
    );
  `);
  return db;
}

function simulateStore(db, { content, url, title }) {
  // Mirror the handler's logic
  const warnings = detectIssues(content, url);
  if (isBlocked(warnings)) return { stored: false, warnings };

  const canonical = url ? canonicalize(url) : '';
  const idSource = canonical || content;
  const hash = createHash('sha256').update(idSource).digest('hex').slice(0, 12);
  const convId = canonical ? `web-${hash}` : `web-paste-${hash}`;
  const resolvedTitle = title || extractTitle(content, url);
  const now = Math.floor(Date.now() / 1000);
  const domain = url ? extractDomain(url) : null;

  db.prepare(
    `INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata, edited_at, uuid)
     VALUES ('web', ?, ?, 'document', ?, ?, ?, ?, ?, NULL)`
  ).run(convId, String(now), domain || 'web', content, now, JSON.stringify({ url, title: resolvedTitle }), now);

  db.prepare(
    `INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count)
     VALUES (?, 'web', ?, ?, ?, 1)
     ON CONFLICT(conversation_id) DO UPDATE SET
       title = excluded.title, last_ts = excluded.last_ts`
  ).run(convId, resolvedTitle, now, now);

  return { stored: true, conversation_id: convId, title: resolvedTitle, warnings };
}

test('happy path: stores web document with auto-extracted title', () => {
  const db = setupDb();
  const r = simulateStore(db, {
    content: '# Great Article\n\nBody content here with enough text to look substantive.',
    url: 'https://example.com/great-article',
  });
  assertEq(r.stored, true);
  assertEq(r.title, 'Great Article');
  assert(r.conversation_id.startsWith('web-'), `expected web- prefix, got ${r.conversation_id}`);

  const row = db.prepare('SELECT * FROM messages WHERE source = ?').get('web');
  assertEq(row.conversation_id, r.conversation_id);
  assertEq(row.role, 'document');
  assertEq(row.sender, 'example.com');
  db.close();
});

test('cloudflare-challenge content is NOT stored', () => {
  const db = setupDb();
  const r = simulateStore(db, {
    content: 'Just a moment... cf-turnstile loading',
    url: 'https://www.perplexity.ai/share/foo',
  });
  assertEq(r.stored, false);
  assertEq(r.warnings[0].type, 'cloudflare-challenge');
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  assertEq(count, 0);
  db.close();
});

test('perplexity-private content is NOT stored', () => {
  const db = setupDb();
  const r = simulateStore(db, {
    content: '# Perplexity\nThis thread is private. Sign in...',
    url: 'https://www.perplexity.ai/search/abc-123',
  });
  assertEq(r.stored, false);
  assertEq(r.warnings[0].type, 'perplexity-private');
  db.close();
});

test('same URL → same conversation_id (deduplication)', () => {
  const idFor = (url) => {
    const can = canonicalize(url);
    return 'web-' + createHash('sha256').update(can).digest('hex').slice(0, 12);
  };
  const a = idFor('https://example.com/post?utm_source=newsletter');
  const b = idFor('https://example.com/post/#section');
  assertEq(a, b, 'tracking-stripped URLs should produce identical IDs');
});

test('paste (no URL) gets web-paste- prefix', () => {
  const db = setupDb();
  const r = simulateStore(db, {
    content: 'A handwritten note pasted by the user.\nLine two.',
    url: null,
  });
  assertEq(r.stored, true);
  assert(r.conversation_id.startsWith('web-paste-'), `got ${r.conversation_id}`);
  db.close();
});

// -----------------------------------------------------------------------------

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

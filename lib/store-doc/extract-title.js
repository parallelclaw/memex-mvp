/**
 * Extract a title from fetched page content.
 *
 * Strategy (first hit wins):
 *   0. Strip Jina Reader prefix block if present (Jina prepends
 *      `Title: …\nURL Source: …\nPublished Time: …\nMarkdown Content:\n`
 *      to its output; the literal "Title:" line is often useless boilerplate
 *      like "Title: Perplexity" rather than the actual thread title)
 *   1. Markdown H1 — `# Title text`
 *   2. Markdown H2 — `## Title text`  (Perplexity threads start with H2)
 *   3. HTML <title> — `<title>Page Title</title>`
 *   4. HTML <h1>  — `<h1>Page Title</h1>`
 *   5. First non-empty line if short enough to look like a title
 *   6. URL slug fallback — last meaningful path segment, decoded
 *   7. Domain fallback — just the domain name
 *   8. "Untitled document"
 *
 * Returns a trimmed string up to MAX_LEN characters. Always returns a
 * non-empty string (worst case "Untitled document").
 */

const MAX_LEN = 200;

function trimTitle(s) {
  if (!s) return '';
  let t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN).trim() + '…';
  return t;
}

/**
 * Jina AI Reader (r.jina.ai/<url>) wraps every page in a metadata
 * prefix:
 *
 *   Title: <browser tab title>
 *
 *   URL Source: <original URL>
 *
 *   Published Time: <date>
 *
 *   Markdown Content:
 *   <actual page markdown follows here>
 *
 * The "Title:" line is frequently a generic app shell ("Perplexity",
 * "Twitter / X", "GitHub") rather than the actual document title — so
 * we strip the whole prefix and run title extraction against the real
 * markdown body. The actual H1/H2 inside is what we want.
 *
 * Detection is keyed on "URL Source: http" near the top — that line
 * is unique to Jina's output format. If it's not present, content is
 * returned unchanged (non-Jina source).
 */
function stripJinaPrefix(content) {
  // Quick gate: look for URL Source line in the first ~500 chars
  if (!/^URL Source:\s*https?:\/\//m.test(content.slice(0, 500))) {
    return content;
  }
  // Find the "Markdown Content:" delimiter and slice everything after it
  const m = content.match(/^Markdown Content:\s*\n/m);
  if (!m) return content;
  return content.slice(m.index + m[0].length);
}

function fromMarkdownH1(content) {
  // Single # at start of line, then space(s), then text.
  const m = content.match(/^[ \t]*#[ \t]+([^\r\n]+?)[ \t]*$/m);
  return m ? trimTitle(m[1]) : '';
}

function fromMarkdownH2(content) {
  // ## at start of line — used as fallback when H1 absent
  // (Perplexity, Jina-fetched Twitter threads, many blog "subtopic" layouts).
  const m = content.match(/^[ \t]*##[ \t]+([^\r\n]+?)[ \t]*$/m);
  return m ? trimTitle(m[1]) : '';
}

function fromHtmlTitle(content) {
  const m = content.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? trimTitle(decodeEntities(m[1])) : '';
}

function fromHtmlH1(content) {
  // Inner text only — strip nested tags like <span>...</span>
  const m = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  const inner = m[1].replace(/<[^>]+>/g, '');
  return trimTitle(decodeEntities(inner));
}

function fromFirstLine(content) {
  // First non-empty line, but only if it looks like a heading
  // (short-ish, no markdown junk).
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip leading markdown decorators / metadata
    if (/^[#\-=*>|`]/.test(line)) continue;
    if (line.length > 0 && line.length <= 120) {
      return trimTitle(line);
    }
    // First substantive line is too long — give up on this strategy
    break;
  }
  return '';
}

function fromUrlSlug(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    // Last meaningful path segment
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length) {
      const slug = decodeURIComponent(segs[segs.length - 1])
        .replace(/[-_]+/g, ' ')
        .replace(/\.(html?|md|pdf|txt)$/i, '')
        .trim();
      if (slug) return trimTitle(slug);
    }
    // No useful path — fall through to domain
    return trimTitle(u.hostname.replace(/^www\./, ''));
  } catch (_) {
    return '';
  }
}

// Minimal HTML-entity decode for &amp; &lt; &gt; &quot; &apos; &#39; &#nnn;
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * @param {string} content - fetched page content
 * @param {string|null} url - source URL (used for slug fallback)
 * @returns {string} a non-empty trimmed title
 */
export function extractTitle(content, url) {
  const safe = typeof content === 'string' ? content : '';
  const body = stripJinaPrefix(safe);

  return (
    fromMarkdownH1(body) ||
    fromMarkdownH2(body) ||
    fromHtmlTitle(body) ||
    fromHtmlH1(body) ||
    fromFirstLine(body) ||
    fromUrlSlug(url) ||
    'Untitled document'
  );
}

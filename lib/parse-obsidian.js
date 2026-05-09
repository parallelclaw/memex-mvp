/**
 * Obsidian vault parser.
 *
 * Walks a vault root directory (folder containing .obsidian/ subdir),
 * yields one logical "conversation" per .md file. Each note becomes a
 * single user-authored message in memex.
 *
 * Why one-note-per-conversation: notes don't have natural turn structure,
 * splitting on H2 would be artificial and fragment search context.
 * memex_search will return the whole note as one hit, with FTS5 snippet
 * highlighting the matched terms — that's the right granularity for PKM.
 *
 * Privacy posture:
 *   - Vault is opt-in; user provides path explicitly (env var or auto-detect).
 *   - .obsidian/, .trash/, .git/ are skipped.
 *   - Notes with frontmatter `memex: false` are skipped.
 *   - .memexignore in vault root supports gitignore-style patterns (TODO).
 *   - Sync-conflict files (e.g. "* (conflict).md", "*.sync-conflict-*") skipped.
 */

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * Auto-detect Obsidian vaults in standard macOS locations.
 * Returns array of absolute vault root paths.
 */
export function autodetectObsidianVaults() {
  const candidates = [
    join(homedir(), 'Documents'),
    join(homedir(), 'Obsidian'),
    join(homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
    join(homedir(), 'Documents', 'Obsidian'),
  ];
  const found = new Set();
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    walkForObsidianFolder(root, 3, found);
  }
  return [...found];
}

function walkForObsidianFolder(dir, depth, found) {
  if (depth < 0) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }
  // Is THIS dir a vault?
  if (entries.some((e) => e.isDirectory() && e.name === '.obsidian')) {
    found.add(dir);
    return; // don't descend further into a vault — nested vaults are unusual
  }
  // Recurse one level deeper
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'Library') continue;
    walkForObsidianFolder(join(dir, e.name), depth - 1, found);
  }
}

/**
 * Decide whether a path inside a vault should be skipped entirely.
 */
const SKIP_PATTERNS = [
  /(^|\/)\.obsidian(\/|$)/,
  /(^|\/)\.trash(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /\.DS_Store$/,
  /\.sync-conflict-/,
  /\(conflict\)\.md$/i,
];
export function shouldSkipPath(relPath) {
  for (const re of SKIP_PATTERNS) if (re.test(relPath)) return true;
  return false;
}

/**
 * Walk a vault, yielding paths to .md files we should process.
 */
export function* walkVault(vaultRoot) {
  const stack = [vaultRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(vaultRoot, full);
      if (shouldSkipPath(rel)) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        yield { absolute: full, relative: rel };
      }
    }
  }
}

/**
 * Minimal YAML parser for typical Obsidian frontmatter (flat key:value,
 * inline arrays [a, b, c], multi-line "key:\n  - item" arrays). Returns
 * an object. Unknown structures fall through silently.
 */
function parseSimpleYaml(text) {
  const result = {};
  let currentArrayKey = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Multi-line array continuation: "  - item"
    const arrM = line.match(/^\s+-\s+(.*)$/);
    if (arrM && currentArrayKey && Array.isArray(result[currentArrayKey])) {
      result[currentArrayKey].push(stripQuotes(arrM[1].trim()));
      continue;
    }

    const kvM = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (!kvM) {
      currentArrayKey = null;
      continue;
    }
    const key = kvM[1].trim();
    const value = kvM[2].trim();

    if (value === '') {
      // Multi-line array
      currentArrayKey = key;
      result[key] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Inline array
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      currentArrayKey = null;
    } else {
      result[key] = coerceScalar(stripQuotes(value));
      currentArrayKey = null;
    }
  }
  return result;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function coerceScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

/**
 * Split a markdown file into { frontmatter, body }.
 * Returns frontmatter:{} when no `--- ... ---` block at the top.
 */
function splitFrontmatter(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { frontmatter: {}, body: raw };
  }
  // Find closing fence
  const closeRe = /\n---\s*(\n|$)/;
  const closeMatch = raw.slice(4).match(closeRe);
  if (!closeMatch) return { frontmatter: {}, body: raw };
  const closeIdx = 4 + closeMatch.index;
  const yamlText = raw.slice(4, closeIdx);
  const after = raw.slice(closeIdx + closeMatch[0].length).replace(/^\n+/, '');
  let fm = {};
  try { fm = parseSimpleYaml(yamlText); } catch (_) {}
  return { frontmatter: fm, body: after };
}

function firstH1(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function parseMaybeDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse a single .md file in a vault.
 * Returns { title, body, frontmatter, created, updated, hash } or null
 * if the file should be skipped (e.g. memex: false).
 */
export function parseNote(filePath, vaultRoot) {
  let raw, stat;
  try {
    raw = readFileSync(filePath, 'utf-8');
    stat = statSync(filePath);
  } catch (_) {
    return null;
  }
  if (!raw.trim()) return null; // empty file — nothing to ingest

  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter.memex === false) return null;

  const fileBase = basename(filePath, '.md');
  const title =
    (typeof frontmatter.title === 'string' && frontmatter.title.trim()) ||
    firstH1(body) ||
    fileBase;

  const created = parseMaybeDate(frontmatter.created) || stat.birthtimeMs || stat.mtimeMs;
  const updated = parseMaybeDate(frontmatter.updated || frontmatter.modified) || stat.mtimeMs;

  // Stable hash for change detection (body only — frontmatter mtime changes don't trigger reindex)
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 16);

  return {
    title,
    body,
    frontmatter,
    created,
    updated,
    hash,
    relativePath: relative(vaultRoot, filePath),
  };
}

/**
 * Build a stable short id for a note within a vault.
 * Uses sha1(vaultName + '/' + relativePath) so multi-vault setups don't collide.
 */
export function noteShortId(vaultRoot, relativePath) {
  const vaultName = basename(vaultRoot);
  const seed = `${vaultName}/${relativePath}`;
  return createHash('sha1').update(seed).digest('hex').slice(0, 8);
}

export function vaultSlug(vaultRoot) {
  return basename(vaultRoot)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 30);
}

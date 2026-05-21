/**
 * MemoryCorpusSupplement adapter — exposes memex contents to OpenClaw's
 * built-in `memory_search` and `memory_get` tools.
 *
 * The OpenClaw runtime ships memory-core, which provides workspace-based
 * memory (MEMORY.md / USER.md / memory/YYYY-MM-DD.md). Plugins can
 * REGISTER A SUPPLEMENT — additional rows that show up in the same tool
 * output, prefixed/labelled so the model knows which corpus a row came
 * from.
 *
 * This is the strategic positioning: memex doesn't REPLACE memory-core,
 * it ADDS to it. The model sees a single `memory_search` tool, gets
 * results from BOTH built-in workspace memory AND memex's verbatim
 * cross-client corpus, in one shot.
 *
 * Multi-plugin coexistence: Mem0, Memoria, memex can all register
 * their own supplements. OpenClaw merges results.
 */

const CORPUS_LABEL = 'memex';

/**
 * Build the supplement object that gets handed to OpenClaw's
 * `registerMemoryCorpusSupplement(pluginId, supplement)` call.
 *
 * Contract (from OpenClaw 2026.5.4 plugin-sdk/memory-state.d.ts):
 *
 *   supplement.search({ query, maxResults, agentSessionKey })
 *     → Promise<MemoryCorpusSearchResult[]>
 *
 *   supplement.get({ lookup, fromLine, lineCount, agentSessionKey })
 *     → Promise<MemoryCorpusGetResult | null>
 */
export function buildCorpusSupplement(store, logger) {
  return {
    async search({ query, maxResults = 10 } = {}) {
      try {
        const rows = store.search(query || '', maxResults);
        return rows.map((r) => toSearchResult(r));
      } catch (err) {
        logger?.warn?.(`memex-openclaw: corpus search failed: ${err.message}`);
        return [];
      }
    },

    async get({ lookup }) {
      // `lookup` is the id we returned in search results' `id` field.
      // We use the message row id as a string for portability.
      try {
        const numericId = parseInt(String(lookup).replace(/^memex:/, ''), 10);
        if (!Number.isFinite(numericId)) return null;
        const row = store.getById(numericId);
        return row ? toGetResult(row) : null;
      } catch (err) {
        logger?.warn?.(`memex-openclaw: corpus get failed: ${err.message}`);
        return null;
      }
    },
  };
}

/**
 * Map a memex row (from store.search) to OpenClaw's
 * MemoryCorpusSearchResult shape:
 *
 *   { corpus, path, title?, kind?, score, snippet, id?,
 *     startLine?, endLine?, citation?, source?,
 *     provenanceLabel?, sourceType?, sourcePath?, updatedAt? }
 */
function toSearchResult(row) {
  const date = row.ts ? new Date(row.ts * 1000).toISOString() : undefined;
  return {
    corpus: CORPUS_LABEL,
    id: `memex:${row.id}`,
    path: `memex://${row.conversation_id}/#msg-${row.id}`,
    title: titleFromRow(row),
    kind: row.channel || 'openclaw',
    score: 1.0, // memex returns ranked-by-ts; bm25 inside FTS would refine
    snippet: row.preview || '',
    source: 'openclaw',
    provenanceLabel: row.channel
      ? `memex • ${row.channel}`
      : 'memex • openclaw',
    sourceType: 'verbatim',
    sourcePath: row.conversation_id,
    updatedAt: date,
  };
}

/**
 * Map a memex row (from store.getById) to OpenClaw's
 * MemoryCorpusGetResult shape:
 *
 *   { corpus, path, title?, kind?, content, fromLine, lineCount,
 *     id?, provenanceLabel?, sourceType?, sourcePath?, updatedAt? }
 */
function toGetResult(row) {
  const date = row.ts ? new Date(row.ts * 1000).toISOString() : undefined;
  const lineCount = row.text ? row.text.split('\n').length : 1;
  return {
    corpus: CORPUS_LABEL,
    id: `memex:${row.id}`,
    path: `memex://${row.conversation_id}/#msg-${row.id}`,
    title: titleFromRow(row),
    kind: row.channel || 'openclaw',
    content: row.text || '',
    fromLine: 1,
    lineCount,
    provenanceLabel: row.channel
      ? `memex • ${row.channel}`
      : 'memex • openclaw',
    sourceType: 'verbatim',
    sourcePath: row.conversation_id,
    updatedAt: date,
  };
}

function titleFromRow(row) {
  const role = row.role || '?';
  const when = row.ts
    ? new Date(row.ts * 1000).toISOString().slice(0, 10)
    : '?';
  // First ~40 chars of text → title-ish
  const preview = (row.text || row.preview || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return preview
    ? `[${when} ${role}] ${preview}${preview.length === 40 ? '…' : ''}`
    : `${role} @ ${when}`;
}

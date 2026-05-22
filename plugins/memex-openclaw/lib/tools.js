/**
 * Memex tool definitions for OpenClaw's `api.registerTool()`.
 *
 * v0.1.0 attempted to expose memex contents via OpenClaw's bundled-only
 * `registerMemoryCorpusSupplement()` — that function turned out NOT to
 * be exported to external (npm-installed) plugins. v0.1.1 switched to
 * the universally-available `api.registerTool()` API.
 *
 * v0.1.4 fixes Bug 5 from the 2026-05-22 VPS test: the registration
 * signature was wrong. v0.1.1–0.1.3 called
 *   api.registerTool('memex_search', { handler, ... })  // two args
 * but OpenClaw 2026.5.x expects ONE object with `name` and `execute`:
 *   api.registerTool({ name, label, description, parameters, execute })
 * The wrong signature caused `definition.name.trim()` to throw on
 * `'memex_search'.name` (= undefined) → register() logged
 * "tool registration FAILED" → no tools available to the model.
 *
 * Confirmed against bundled `tavily` plugin's `createTavilySearchTool`
 * — same shape, including the `jsonResult()` helper that pairs a
 * pretty-printed `content[0].text` with a raw `details` payload.
 *
 * Progressive disclosure pattern preserved:
 *   memex_search(query)  → IDs + 100-char previews (cheap, Tier 1)
 *   memex_get(ids)       → full verbatim text (only when needed, Tier 2)
 */

/**
 * OpenClaw-compatible tool result. Mirrors the internal `jsonResult()`
 * helper used by bundled plugins (tavily, etc.):
 *   - content[0].text → JSON.stringify(payload, null, 2) (model-visible)
 *   - details         → raw payload (for UI / tracing, not parsed by model)
 */
function jsonResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/**
 * Register memex_search + memex_get tools on the OpenClaw plugin API.
 *
 * @param {object} api - OpenClaw plugin API (passed to register(api))
 * @param {object} store - MemexStore instance
 * @param {object} logger - api.logger
 */
export function registerMemexTools(api, store, logger) {
  // Tool 1: memex_search — Tier 1 (cheap, returns IDs + previews)
  api.registerTool({
    name: 'memex_search',
    label: 'Memex Search',
    description:
      'Search the memex verbatim corpus across all captured sources (OpenClaw + Hermes + Claude Code + Telegram + etc.). ' +
      'Returns abbreviated records — id, role, channel, 100-char preview. ' +
      'Call memex_get(ids) afterwards to fetch full text. ' +
      'Use this BEFORE memex_get to find what is relevant; rarely call memex_get directly.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'FTS5 query. Simple keywords work; phrases use double quotes. ' +
            'Example: install ffmpeg or "docker compose" production.',
        },
        limit: {
          type: 'integer',
          description: 'Max results (default 10, max 50).',
        },
      },
      required: ['query'],
    },
    execute: async (_toolCallId, rawParams) => {
      const query = rawParams?.query || '';
      const limit = Math.min(
        Math.max(parseInt(rawParams?.limit, 10) || 10, 1),
        50,
      );
      try {
        const rows = store.search(query, limit);
        if (!rows.length) {
          return jsonResult({
            results: [],
            hint: 'No matches. Try different keywords.',
          });
        }
        return jsonResult({
          results: rows,
          count: rows.length,
          hint: 'Call memex_get(ids=[...]) for full verbatim text of records you want to read.',
        });
      } catch (err) {
        logger?.error?.(`memex_search failed: ${err.message}`);
        return jsonResult({ error: err.message });
      }
    },
  });

  // Tool 2: memex_get — Tier 2 (full text by ID)
  api.registerTool({
    name: 'memex_get',
    label: 'Memex Get',
    description:
      'Fetch full verbatim text of specific records by ID. ' +
      'Call this after memex_search to read the records that look relevant. ' +
      'Returns the original text in full, not a summary.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Record IDs returned by memex_search.',
        },
      },
      required: ['ids'],
    },
    execute: async (_toolCallId, rawParams) => {
      const ids = rawParams?.ids;
      try {
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResult({
            error: 'ids must be a non-empty array of integers',
          });
        }
        // Cap at 20 to avoid runaway token usage.
        const capped = ids.slice(0, 20);
        const truncated = ids.length > capped.length;
        const records = capped
          .map((id) => store.getById(id))
          .filter(Boolean);
        const out = { records, count: records.length };
        if (truncated) {
          out.truncated = true;
          out.hint = `Capped at 20 records; ${ids.length - 20} more were not fetched.`;
        }
        return jsonResult(out);
      } catch (err) {
        logger?.error?.(`memex_get failed: ${err.message}`);
        return jsonResult({ error: err.message });
      }
    },
  });

  logger?.info?.('memex-openclaw: registered tools memex_search, memex_get');
}

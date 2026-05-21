/**
 * Memex tool definitions for OpenClaw's `api.registerTool()`.
 *
 * v0.1.0 attempted to expose memex contents via OpenClaw's bundled-only
 * `registerMemoryCorpusSupplement()` — that function turned out NOT to
 * be exported to external (npm-installed) plugins. v0.1.1 switches to
 * the universally-available `api.registerTool()` API.
 *
 * Trade-off: the model now has TWO distinct tools (memex_search +
 * memex_get) instead of the OpenClaw-merged memory_search experience.
 * In exchange we don't depend on internal API surface.
 *
 * Progressive disclosure pattern preserved:
 *   memex_search(query)  → IDs + 100-char previews (cheap, Tier 1)
 *   memex_get(ids)       → full verbatim text (only when needed, Tier 2)
 */

/**
 * Register memex_search + memex_get tools on the OpenClaw plugin API.
 *
 * @param {object} api - OpenClaw plugin API (passed to register(api))
 * @param {object} store - MemexStore instance
 * @param {object} logger - api.logger
 */
export function registerMemexTools(api, store, logger) {
  // Tool 1: memex_search — Tier 1 (cheap, returns IDs + previews)
  api.registerTool('memex_search', {
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
    handler: async ({ query, limit }) => {
      try {
        const rows = store.search(query || '', limit || 10);
        if (!rows.length) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                results: [],
                hint: 'No matches. Try different keywords.',
              }),
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: rows,
              count: rows.length,
              hint: 'Call memex_get(ids=[...]) for full verbatim text of records you want to read.',
            }),
          }],
        };
      } catch (err) {
        logger?.error?.(`memex_search failed: ${err.message}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: err.message }),
          }],
        };
      }
    },
  });

  // Tool 2: memex_get — Tier 2 (full text by ID)
  api.registerTool('memex_get', {
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
    handler: async ({ ids }) => {
      try {
        if (!Array.isArray(ids) || ids.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'ids must be a non-empty array of integers' }),
            }],
          };
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
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(out),
          }],
        };
      } catch (err) {
        logger?.error?.(`memex_get failed: ${err.message}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: err.message }),
          }],
        };
      }
    },
  });

  logger?.info?.('memex-openclaw: registered tools memex_search, memex_get');
}

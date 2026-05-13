/**
 * Shared dialogue-only parser for Claude Code / Cowork JSONL.
 *
 * Used by both the MCP server (server.js, importing inbox files) and the
 * ingest daemon (ingest.js, reading deltas from raw source files).
 */

/** Skip these top-level event types — they're not dialogue. */
export const CLAUDE_CODE_SKIP_TYPES = new Set(['queue-operation', 'ai-title', 'summary']);

/** Auto-generated user messages produced by /compact, /resume, and
 *  continuation flows. They're real messages (we keep them in the
 *  index), but they're never useful as conversation titles. */
export const CONTINUATION_PREFIXES = [
  'This session is being continued',
  'Continue from where you left off',
  'Please continue from where you left off',
];

export function isContinuationBoilerplate(text) {
  for (const p of CONTINUATION_PREFIXES) if (text.startsWith(p)) return true;
  // XML/tag-wrapped artefacts (uploaded_files, system-reminder, command-name…)
  if (text.startsWith('<')) return true;
  return false;
}

/** Extract a clean dialogue message from a Claude Code JSONL record.
 *
 *  Handles both:
 *    1. Legacy flat shape (original spec):
 *       {"role":"user","content":"...","timestamp":"..."}
 *    2. Real nested shape (current Claude Code / Cowork on disk):
 *       {"type":"user","message":{"role":"user","content":"..."},"timestamp":"..."}
 *       {"parentUuid":"...","message":{"role":"assistant","content":[{type:"text",text:"..."},...]}}
 *
 *  Filters out everything that isn't human-readable dialogue:
 *    - queue-operation / ai-title / summary events
 *    - attachment-only records (deferred_tools_delta, skill_listing, plan_mode)
 *    - tool_use / tool_result / thinking / redacted_thinking / image content blocks
 *    - encrypted thinking signatures (multi-kilobyte base64 blobs)
 *
 *  Compaction handling:
 *    Records with isCompactSummary:true (synthetic summary fed back into model
 *    context by /compact) are returned with role='summary' so the importer
 *    can route them away from FTS5 indexing — otherwise the summary would
 *    double-count against the original raw discussion it summarises.
 *
 *  Returns null when the record should be skipped, otherwise
 *  { role, text, id, timestamp, uuid, parentUuid }.
 */
export function extractMessageFromRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Skip non-dialogue top-level event types
  if (CLAUDE_CODE_SKIP_TYPES.has(obj.type)) return null;

  // Skip attachment-only records (Claude Code harness bookkeeping)
  if (obj.attachment && !obj.message) return null;

  // Resolve role/content from either nested or flat shape
  const nested = obj.message;
  const fromNested = nested && typeof nested === 'object';
  let role = fromNested ? nested.role : obj.role;
  if (!role || typeof role !== 'string') return null;

  let rawContent;
  if (fromNested) {
    rawContent = nested.content;
  } else if (obj.content !== undefined) {
    rawContent = obj.content;
  } else {
    rawContent = obj.text;
  }

  // Normalise content into dialogue-only text
  let text = '';
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    const parts = [];
    for (const block of rawContent) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      // Only keep text-bearing blocks. Drop tool_use, tool_result, thinking,
      // redacted_thinking, image, and any future unknown block types.
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    text = parts.join('\n');
  }

  if (!text || !text.trim()) return null;

  // Claude Code marks the synthetic /compact summary message with
  // isCompactSummary:true (and isVisibleInTranscriptOnly:true). Re-tag
  // those as role='summary' so the importer can keep them in the messages
  // table for retrieval but exclude them from FTS5 — otherwise searching
  // for any topic discussed before a compaction would return both the
  // original raw turns AND the compressed summary mention, polluting rank.
  if (
    role === 'user' &&
    (obj.isCompactSummary === true || obj.isVisibleInTranscriptOnly === true)
  ) {
    role = 'summary';
  }

  const id = (fromNested && nested.id) || obj.id || null;
  const timestamp =
    obj.timestamp || (fromNested && nested.timestamp) || null;
  const uuid = obj.uuid || null;
  const parentUuid = obj.parentUuid || null;

  return { role, text, id, timestamp, uuid, parentUuid };
}

/** Detect a compact_boundary record.
 *
 *  Claude Code writes two record types when /compact (or auto-compact) fires:
 *    1. {type:"system", subtype:"compact_boundary", compactMetadata:{...}, ...}
 *       — boundary marker. parentUuid is reset to null. compactMetadata
 *       carries {trigger, preTokens, postTokens, durationMs,
 *       logicalParentUuid, preCompactDiscoveredTools}.
 *    2. {type:"user", isCompactSummary:true, message:{...}} — the
 *       AI-generated summary fed back into model context (handled by
 *       extractMessageFromRecord via role='summary').
 *
 *  We also recognise the daemon's inbox-emitted shape
 *  {type:"compact-boundary", metadata:{...}, ...} so server.js can import
 *  either the raw on-disk format or the daemon's snapshot.
 *
 *  Returns null when the record isn't a boundary, otherwise
 *  { timestamp, uuid, parentUuid, logicalParentUuid, metadata, id }.
 */
export function extractCompactBoundary(obj) {
  if (!obj || typeof obj !== 'object') return null;

  let metadata, raw;
  if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
    metadata = obj.compactMetadata || {};
    raw = obj;
  } else if (obj.type === 'compact-boundary') {
    metadata = obj.metadata || {};
    raw = obj;
  } else {
    return null;
  }

  return {
    timestamp: obj.timestamp || null,
    uuid: obj.uuid || null,
    parentUuid: obj.parentUuid || null,
    logicalParentUuid:
      obj.logicalParentUuid || (metadata && metadata.logicalParentUuid) || null,
    metadata,
    id: obj.id || null,
    raw,
  };
}

/** Pull an ai-title record out of a JSONL line, if present. */
export function extractAiTitle(obj) {
  if (
    obj &&
    obj.type === 'ai-title' &&
    typeof obj.aiTitle === 'string' &&
    obj.aiTitle.trim()
  ) {
    return obj.aiTitle.trim();
  }
  return null;
}

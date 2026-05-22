/**
 * Tests for the api.registerTool() handlers.
 * Run: `node --test tests/tools.test.js`
 *
 * v0.1.4 update: registration contract changed to match OpenClaw
 * 2026.5.x. `api.registerTool({ name, label, ..., execute })` — single
 * object with `execute(toolCallId, rawParams)`, not the previous
 * two-arg `registerTool('name', { handler })` shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemexStore } from '../lib/store.js';
import { registerMemexTools } from '../lib/tools.js';

/**
 * Minimal mock of the OpenClaw plugin API surface we use.
 * Tools are keyed by `definition.name`, matching the real
 * api.registerTool({ name, ... }) contract.
 */
function mockApi() {
  const tools = new Map();
  return {
    registeredTools: tools,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerTool(def) {
      if (!def || typeof def.name !== 'string') {
        throw new TypeError('registerTool({name, ...}) — name required');
      }
      tools.set(def.name, def);
    },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'memex-oc-tools-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  store.insertMessage({
    conversationId: 'openclaw-telegram-42', msgId: 'm-a', role: 'user',
    text: 'install ffmpeg please', ts: 1700000000, channel: 'telegram',
  });
  store.insertMessage({
    conversationId: 'openclaw-telegram-42', msgId: 'm-b', role: 'assistant',
    text: 'ffmpeg installed via apt', ts: 1700000001, channel: 'telegram',
  });
  store.insertMessage({
    conversationId: 'openclaw-cli-aabbccdd', msgId: 'm-c', role: 'user',
    text: 'unrelated whisper question', ts: 1700000002, channel: 'cli',
  });
  return {
    store,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('registerMemexTools: registers both memex_search and memex_get', () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    assert.equal(api.registeredTools.size, 2);
    assert.ok(api.registeredTools.has('memex_search'));
    assert.ok(api.registeredTools.has('memex_get'));
  } finally { cleanup(); }
});

test('memex_search: tool definition matches OpenClaw 2026.5 contract', () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_search');
    assert.equal(tool.name, 'memex_search');
    assert.equal(typeof tool.label, 'string');
    assert.ok(tool.description.includes('memex'));
    assert.equal(tool.parameters.type, 'object');
    assert.ok('query' in tool.parameters.properties);
    assert.deepEqual(tool.parameters.required, ['query']);
    assert.equal(typeof tool.execute, 'function');
  } finally { cleanup(); }
});

test('memex_search: execute returns OpenClaw jsonResult shape', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_search');
    const result = await tool.execute('call-1', { query: 'ffmpeg', limit: 10 });
    // OpenClaw shape: { content: [{type,text}], details: <payload> }
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, 'text');
    assert.ok(result.details, 'details payload should be present');
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed, result.details, 'content[0].text should serialise details');
    assert.equal(parsed.count, 2);
    assert.equal(parsed.results.length, 2);
    assert.match(parsed.hint, /memex_get/);
  } finally { cleanup(); }
});

test('memex_search: empty result includes helpful hint', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_search');
    const result = await tool.execute('call-2', { query: 'nonexistent-topic-xyz' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.results.length, 0);
    assert.match(parsed.hint, /different keywords/);
  } finally { cleanup(); }
});

test('memex_search: limit is clamped to [1, 50]', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_search');
    // Garbage limit should fall back to default behavior, not crash.
    const r1 = await tool.execute('c', { query: 'ffmpeg', limit: 'not-a-number' });
    assert.ok(Array.isArray(r1.content));
    // Insanely large limit should also be accepted (clamped to 50).
    const r2 = await tool.execute('c', { query: 'ffmpeg', limit: 9999 });
    assert.ok(Array.isArray(r2.content));
  } finally { cleanup(); }
});

test('memex_get: tool definition matches OpenClaw 2026.5 contract', () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_get');
    assert.equal(tool.name, 'memex_get');
    assert.equal(typeof tool.label, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.ok('ids' in tool.parameters.properties);
    assert.equal(tool.parameters.properties.ids.type, 'array');
    assert.deepEqual(tool.parameters.required, ['ids']);
    assert.equal(typeof tool.execute, 'function');
  } finally { cleanup(); }
});

test('memex_get: returns full text for known IDs', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const searchTool = api.registeredTools.get('memex_search');
    const searchResult = await searchTool.execute('s', { query: 'ffmpeg' });
    const ids = JSON.parse(searchResult.content[0].text).results.map((r) => r.id);

    const getTool = api.registeredTools.get('memex_get');
    const getResult = await getTool.execute('g', { ids });
    const parsed = JSON.parse(getResult.content[0].text);
    assert.equal(parsed.count, ids.length);
    for (const rec of parsed.records) {
      assert.ok(rec.text && rec.text.length > 0);
    }
  } finally { cleanup(); }
});

test('memex_get: rejects empty or non-array ids', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_get');
    const r1 = await tool.execute('g', {});
    assert.match(JSON.parse(r1.content[0].text).error, /non-empty array/);
    const r2 = await tool.execute('g', { ids: [] });
    assert.match(JSON.parse(r2.content[0].text).error, /non-empty array/);
  } finally { cleanup(); }
});

test('memex_get: caps at 20 records and reports truncation', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_get');
    // 25 ids — most won't resolve to real rows but the cap still triggers
    const result = await tool.execute('g', {
      ids: Array.from({ length: 25 }, (_, i) => i + 1),
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.truncated, true);
    assert.match(parsed.hint, /Capped at 20/);
  } finally { cleanup(); }
});

test('memex_get: missing IDs return as omitted records (not error)', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_get');
    const result = await tool.execute('g', { ids: [1, 99999, 2] });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.count, 2); // 1 and 2 exist, 99999 doesn't
  } finally { cleanup(); }
});

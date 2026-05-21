/**
 * Tests for the api.registerTool() handlers.
 * Run: `node --test tests/tools.test.js`
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
 * Stores tool registrations for later inspection.
 */
function mockApi() {
  const tools = new Map();
  return {
    registeredTools: tools,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerTool(name, def) {
      tools.set(name, def);
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

test('memex_search: tool definition has required schema fields', () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_search');
    assert.ok(tool.description.includes('memex'));
    assert.equal(tool.parameters.type, 'object');
    assert.ok('query' in tool.parameters.properties);
    assert.deepEqual(tool.parameters.required, ['query']);
    assert.equal(typeof tool.handler, 'function');
  } finally { cleanup(); }
});

test('memex_search: handler returns results in MCP content format', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_search');
    const result = await tool.handler({ query: 'ffmpeg', limit: 10 });
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, 'text');
    const parsed = JSON.parse(result.content[0].text);
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
    const result = await tool.handler({ query: 'nonexistent-topic-xyz' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.results.length, 0);
    assert.match(parsed.hint, /different keywords/);
  } finally { cleanup(); }
});

test('memex_get: tool definition has required schema fields', () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const tool = api.registeredTools.get('memex_get');
    assert.equal(tool.parameters.type, 'object');
    assert.ok('ids' in tool.parameters.properties);
    assert.equal(tool.parameters.properties.ids.type, 'array');
    assert.deepEqual(tool.parameters.required, ['ids']);
  } finally { cleanup(); }
});

test('memex_get: returns full text for known IDs', async () => {
  const { store, cleanup } = setup();
  try {
    const api = mockApi();
    registerMemexTools(api, store, api.logger);
    const searchTool = api.registeredTools.get('memex_search');
    const searchResult = await searchTool.handler({ query: 'ffmpeg' });
    const ids = JSON.parse(searchResult.content[0].text).results.map((r) => r.id);

    const getTool = api.registeredTools.get('memex_get');
    const getResult = await getTool.handler({ ids });
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
    const r1 = await tool.handler({});
    assert.match(JSON.parse(r1.content[0].text).error, /non-empty array/);
    const r2 = await tool.handler({ ids: [] });
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
    const result = await tool.handler({ ids: Array.from({ length: 25 }, (_, i) => i + 1) });
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
    const result = await tool.handler({ ids: [1, 99999, 2] });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.count, 2); // 1 and 2 exist, 99999 doesn't
  } finally { cleanup(); }
});

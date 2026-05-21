/**
 * Tests for the MemoryCorpusSupplement adapter.
 * Run: `node --test tests/corpus_supplement.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemexStore } from '../lib/store.js';
import { buildCorpusSupplement } from '../lib/corpus_supplement.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'memex-oc-cs-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  store.insertMessage({
    conversationId: 'openclaw-telegram-42', msgId: 'm-a', role: 'user',
    text: 'how do I install ffmpeg on Ubuntu', ts: 1700000000, channel: 'telegram',
  });
  store.insertMessage({
    conversationId: 'openclaw-telegram-42', msgId: 'm-b', role: 'assistant',
    text: 'use apt: sudo apt install ffmpeg', ts: 1700000001, channel: 'telegram',
  });
  store.insertMessage({
    conversationId: 'openclaw-cli-aabbccdd', msgId: 'm-c', role: 'user',
    text: 'unrelated whisper question', ts: 1700000002, channel: 'cli',
  });
  return {
    store,
    supplement: buildCorpusSupplement(store, console),
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('supplement: search returns rows mapped to MemoryCorpusSearchResult shape', async () => {
  const { supplement, cleanup } = setup();
  try {
    const results = await supplement.search({ query: 'ffmpeg', maxResults: 10 });
    assert.equal(results.length, 2);
    for (const r of results) {
      // Required fields per OpenClaw contract
      assert.equal(r.corpus, 'memex');
      assert.ok(typeof r.id === 'string' && r.id.startsWith('memex:'));
      assert.ok(typeof r.path === 'string');
      assert.equal(typeof r.score, 'number');
      assert.equal(typeof r.snippet, 'string');
      assert.equal(r.source, 'openclaw');
      assert.match(r.provenanceLabel || '', /memex/);
      assert.equal(r.sourceType, 'verbatim');
    }
  } finally { cleanup(); }
});

test('supplement: search empty query returns empty array', async () => {
  const { supplement, cleanup } = setup();
  try {
    const results = await supplement.search({ query: '' });
    assert.deepEqual(results, []);
  } finally { cleanup(); }
});

test('supplement: search malformed query returns empty (no throw)', async () => {
  const { supplement, cleanup } = setup();
  try {
    const results = await supplement.search({ query: '"unbalanced' });
    assert.deepEqual(results, []);
  } finally { cleanup(); }
});

test('supplement: get returns full row when looked up by memex:N id', async () => {
  const { supplement, cleanup } = setup();
  try {
    const search = await supplement.search({ query: 'ffmpeg' });
    const first = search[0];
    const full = await supplement.get({ lookup: first.id });
    assert.ok(full);
    assert.equal(full.corpus, 'memex');
    assert.equal(typeof full.content, 'string');
    assert.ok(full.content.length > 0);
    assert.equal(full.fromLine, 1);
    assert.ok(full.lineCount >= 1);
    assert.equal(full.sourceType, 'verbatim');
  } finally { cleanup(); }
});

test('supplement: get accepts raw numeric id (memex: prefix optional)', async () => {
  const { supplement, cleanup } = setup();
  try {
    const r = await supplement.get({ lookup: '1' });
    assert.ok(r);
    assert.equal(r.corpus, 'memex');
  } finally { cleanup(); }
});

test('supplement: get returns null for missing id', async () => {
  const { supplement, cleanup } = setup();
  try {
    const r = await supplement.get({ lookup: 'memex:99999' });
    assert.equal(r, null);
  } finally { cleanup(); }
});

test('supplement: get returns null for non-numeric lookup', async () => {
  const { supplement, cleanup } = setup();
  try {
    const r = await supplement.get({ lookup: 'garbage-id' });
    assert.equal(r, null);
  } finally { cleanup(); }
});

test('supplement: provenanceLabel includes channel when known', async () => {
  const { supplement, cleanup } = setup();
  try {
    const results = await supplement.search({ query: 'whisper' });
    const r = results[0];
    assert.match(r.provenanceLabel, /cli/);
  } finally { cleanup(); }
});

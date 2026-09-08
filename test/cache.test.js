// test/cache.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate cache persistence into a temp file.
process.env.CACHE_PATH = process.env.CACHE_PATH || path.join(os.tmpdir(), 'freegate-cache-test.json');
const CACHE_PATH_TMP = process.env.CACHE_PATH;

const { LRUCache } = require('../lib/cache');

function freshCache() {
  return new LRUCache(20, 60000, true, true); // skip load, useNormalize on
}

describe('LRUCache.getSemantic', () => {
  it('hits a near-duplicate rephrase of a cached dialog', () => {
    const c = freshCache();
    c.set('codestral', [{ role: 'user', content: 'исправь ошибку в коде ниже' }], 0.2, { answer: 'fixed' });
    const hit = c.getSemantic('codestral', [{ role: 'user', content: 'исправь ошибку в коде ниже пожалуйста' }], 0.2, 0.5);
    assert.ok(hit, 'expected a semantic hit');
    assert.deepEqual(hit.value, { answer: 'fixed' });
    assert.ok(hit.similarity >= 0.5);
  });

  it('misses when similarity below threshold', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'как дела' }], 0, { a: 1 });
    const miss = c.getSemantic('m', [{ role: 'user', content: 'напиши стих' }], 0, 0.9);
    assert.equal(miss, null);
  });

  it('misses when model differs', () => {
    const c = freshCache();
    c.set('model-a', [{ role: 'user', content: 'привет мир как дела' }], 0, { a: 1 });
    const miss = c.getSemantic('model-b', [{ role: 'user', content: 'привет мир как дела' }], 0, 0.5);
    assert.equal(miss, null);
  });

  it('misses when temperature differs', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'привет мир как дела' }], 0, { a: 1 });
    const miss = c.getSemantic('m', [{ role: 'user', content: 'привет мир как дела ' }], 1.0, 0.5);
    assert.equal(miss, null);
  });

  it('skips code-looking requests', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'исправь function foo() { return 1; }' }], 0, { a: 1 });
    const miss = c.getSemantic('m', [{ role: 'user', content: 'исправь function foo() { return 2; }' }], 0, 0.5);
    assert.equal(miss, null);
  });

  it('skips tool-state messages', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'hello world today' }], 0, { a: 1 });
    const miss = c.getSemantic('m', [
      { role: 'user', content: 'hello world today' },
      { role: 'tool', content: '{report: "x"}', tool_call_id: 't1' },
    ], 0, 0.5);
    assert.equal(miss, null);
  });

  it('skips non-string content arrays', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'hello world today' }], 0, { a: 1 });
    const miss = c.getSemantic('m', [
      { role: 'user', content: [{ type: 'text', text: 'hello world today' }] },
    ], 0, 0.5);
    assert.equal(miss, null);
  });

  it('returns null when normalized text is empty', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }], 0, { a: 1 });
    const miss = c.getSemantic('m', [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }] }], 0, 0.5);
    assert.equal(miss, null);
  });

  it('bumps semHits and stats', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'продолжай работу над проектом пожалуйста' }], 0.1, { ok: true });
    c.getSemantic('m', [{ role: 'user', content: 'продолжай работу над проектом' }], 0.1, 0.5);
    assert.equal(c.stats().semHits, 1);
  });

  it('increments misses (not hits) on a semantic miss', () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'hello world foo bar baz' }], 0, { ok: true });
    c.getSemantic('m', [{ role: 'user', content: 'совершенно другая тема' }], 0, 0.99);
    const s = c.stats();
    assert.equal(s.semHits, 0);
    assert.equal(s.misses, 1);
  });
});

describe('LRUCache grams persistence', () => {
  it('persists grams/model/temperature and restores them on load', async () => {
    // Write through the module's CACHE_PATH (isolated to a temp file).
    const c = new LRUCache(20, 60000, true, true);
    c.set('persist-model', [{ role: 'user', content: 'напиши резюме проекта полностью' }], 0.7, { ok: true });
    await c.persist();

    const data = JSON.parse(fs.readFileSync(CACHE_PATH_TMP, 'utf8'));
    const entry = (data.entries || []).find(e => e.model === 'persist-model');
    assert.ok(entry, 'entry persisted with model');
    assert.equal(entry.temperature, 0.7);
    assert.ok(Array.isArray(entry.grams) && entry.grams.length > 0, 'grams persisted');
    try { fs.unlinkSync(CACHE_PATH_TMP); } catch {}
  });
});

describe('LRUCache provider tag', () => {
  it('stores and returns providerKey via getProvider', () => {
    const c = freshCache();
    const msgs = [{ role: 'user', content: 'напиши функцию' }];
    c.set('m1', msgs, 0, { ok: true }, 'groq-gpt');
    assert.equal(c.getProvider('m1', msgs, 0), 'groq-gpt', 'provider key stored');
    // Отсутствующий → null
    assert.equal(c.getProvider('m1', [{ role: 'user', content: 'другой' }], 0), null, 'missing → null');
  });

  it('stores null providerKey when not passed', () => {
    const c = freshCache();
    const msgs = [{ role: 'user', content: 'x' }];
    c.set('m2', msgs, 0, { ok: true });
    assert.equal(c.getProvider('m2', msgs, 0), null, 'no provider → null');
  });

  it('getProvider works in-memory (persist covered by model/temperature test)', () => {
    const c = new LRUCache(20, 60000, true, true);
    const msgs = [{ role: 'user', content: 'голосовой тест кэша провайдера' }];
    c.set('mp', msgs, 0.3, { ok: true }, 'or-nemotron-35');
    assert.equal(c.getProvider('mp', msgs, 0.3), 'or-nemotron-35', 'provider tag readable');
    c.clear();
  });
});

// The auto-persist interval keeps the event loop alive; stop it so the
// process can exit (same pattern as proxy.test.js).
require('../lib/cache')._stopTimers();

describe('LRUCache.persist (atomic async)', () => {
  it('writes entries to disk via temp file + rename, no .tmp left', async () => {
    const c = freshCache();
    c.set('m', [{ role: 'user', content: 'привет мир как дела' }], 0, { a: 1 });
    await c.persist();
    assert.ok(fs.existsSync(CACHE_PATH_TMP), 'persisted file exists');
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH_TMP, 'utf8'));
    assert.equal(raw.entries.length, 1, 'one entry on disk');
    assert.ok(!fs.existsSync(CACHE_PATH_TMP + '.tmp'), 'no tmp file after persist');
    // A fresh (non-skipLoad) cache restores it
    const c2 = new LRUCache(20, 60000, false, true);
    const hit = c2.get('m', [{ role: 'user', content: 'привет мир как дела' }], 0);
    assert.deepEqual(hit, { a: 1 }, 'entry restored from disk');
    c2.clear();
  });

  it('does not persist entries larger than MAX_ENTRY_BYTES', async () => {
    const c = freshCache();
    c.set('big', [{ role: 'user', content: 'x' }], 0, { blob: 'y'.repeat(300 * 1024) });
    await c.persist();
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH_TMP, 'utf8'));
    assert.strictEqual(raw.entries.filter(e => e.key !== undefined && e.value).length, 0, 'oversized entry skipped');
    assert.ok(!fs.existsSync(CACHE_PATH_TMP + '.tmp'));
  });

  it('persistSync flushes synchronously (shutdown path)', () => {
    const c = freshCache();
    c.set('ms', [{ role: 'user', content: 'синхронный флаш тест' }], 0, { ok: true });
    const ok = c.persistSync();
    assert.strictEqual(ok, true);
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH_TMP, 'utf8'));
    assert.equal(raw.entries.length, 1);
    assert.ok(!fs.existsSync(CACHE_PATH_TMP + '.tmp'));
  });
});

// Cleanup temp file after tests.
after(() => {
  try { fs.unlinkSync(CACHE_PATH_TMP); } catch {}
  try { fs.unlinkSync(CACHE_PATH_TMP + '.tmp'); } catch {}
});
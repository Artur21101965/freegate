// lib/cache.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeMessages, looksLikeCode } = require('./normalize');
const { trigrams, dice } = require('./semcache');

const MAX_SIZE = 500;
const DEFAULT_TTL = 3600000; // 1 hour in ms
const MAX_ENTRY_BYTES = 256 * 1024; // don't persist responses larger than 256KB
const CACHE_PATH = process.env.CACHE_PATH || path.join(__dirname, '..', 'cache.json');

// Serialize atomic (tmp + rename) writes so concurrent persist calls from
// multiple instances can never interleave writes into the same tmp file.
let _writeChain = Promise.resolve();
function enqueuePersist(tmp, payload) {
  _writeChain = _writeChain
    .then(() => fs.promises.writeFile(tmp, payload, 'utf8'))
    .then(() => fs.promises.rename(tmp, CACHE_PATH))
    .catch(() => { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} });
  return _writeChain;
}

class LRUCache {
  constructor(maxSize = MAX_SIZE, ttl = DEFAULT_TTL, skipLoad = false, useNormalize = false) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
    this.semHits = 0;
    this.useNormalize = useNormalize;
    if (!skipLoad) this.load();
  }

  _key(model, messages, temperature, tools) {
    let raw;
    if (this.useNormalize) {
      const norm = normalizeMessages(messages);
      // Пустая нормализация (только картинки/инструменты без текста) НЕ должна
      // схлопывать разные запросы в один ключ — fallback на точное совпадение.
      raw = norm
        ? `${model}|${norm}|${temperature || 0}`
        : `${model}|${JSON.stringify(messages)}|${temperature || 0}`;
    } else {
      raw = `${model}|${JSON.stringify(messages)}|${temperature || 0}`;
    }
    // Инструменты (tools/tool_choice) влияют на ответ (tool_calls vs текст) —
    // без этого tool-запрос попадал на текстовый кэш и агент «останавливался».
    if (tools) raw += `|tools=${JSON.stringify(tools)}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  load() {
    // Restore persisted cache from disk (survives restarts)
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (data && Array.isArray(data.entries)) {
        const now = Date.now();
        for (const e of data.entries) {
if (now - e.created > this.ttl) continue;
      this.cache.set(e.key, { value: e.value, created: e.created, uses: e.uses || 0, model: e.model, temperature: e.temperature, grams: e.grams || null, providerKey: e.providerKey || null });
        }
        // Restore hit/miss counters so hitRate survives restarts
        if (typeof data.hits === 'number') this.hits = data.hits;
        if (typeof data.misses === 'number') this.misses = data.misses;
      }
    } catch {}
  }

  _buildPersistPayload() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of this.cache) {
      if (now - entry.created > this.ttl) continue;
      try {
        const size = Buffer.byteLength(JSON.stringify(entry.value));
        if (size > MAX_ENTRY_BYTES) continue;
        entries.push({ key, value: entry.value, created: entry.created, uses: entry.uses || 0, model: entry.model, temperature: entry.temperature, grams: entry.grams || null, providerKey: entry.providerKey || null });
      } catch {}
    }
    // Keep only the most recent 300 on disk to bound file size
    const trimmed = entries.slice(-300);
    return JSON.stringify({
      saved: Date.now(),
      hits: this.hits,
      misses: this.misses,
      entries: trimmed,
    });
  }

  // Async atomic persist (temp file + rename) with coalescing — regular saves
  // never block the event loop.
  async persist() {
    if (this._persisting) { this._repersist = true; return false; }
    this._persisting = true;
    let payload;
    try {
      payload = this._buildPersistPayload();
    } catch (err) {
      this._persisting = false;
      return false;
    }
    try {
      const tmp = CACHE_PATH + '.tmp';
      await enqueuePersist(tmp, payload);
    } catch (err) {
      // enqueuePersist swallows its own errors; nothing to do here.
    } finally {
      this._persisting = false;
      if (this._repersist) {
        this._repersist = false;
        return this.persist();
      }
    }
    return true;
  }

  // Synchronous atomic flush — shutdown path, must finish before exit.
  persistSync() {
    try {
      const payload = this._buildPersistPayload();
      const tmp = CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, CACHE_PATH);
      return true;
    } catch {
      try { if (fs.existsSync(CACHE_PATH + '.tmp')) fs.unlinkSync(CACHE_PATH + '.tmp'); } catch {}
      return false;
    }
  }

  get(model, messages, temperature, tools) {
    const key = this._key(model, messages, temperature, tools);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.created > this.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Hot entries: bump TTL + usage count so frequently-used responses
    // stay cached longer (mirrors DeepSeek-style high cache-hit rates).
    entry.created = Date.now();
    entry.uses = (entry.uses || 0) + 1;

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  // Семантический кэш: на промахе точного ключа ищем закэшированный диалог с
  // похожим нормализованным текстом (Dice по символьным триграммам). Отдаём
  // только при совпадении model+temperature и similarity >= minSimilarity.
  // Безопасность: код, сообщения с нестроковым content и role:'tool' никогда
  // не матчатся семантически (разный интент/состояние инструментов).
  getSemantic(model, messages, temperature, minSimilarity = 0.85) {
    // Guards mirror set()'s grams computation — anything that gets grams:null
    // in set() must not match here either.
    // НЕ инкрементируем this.misses здесь — это semantic guards, не real cache misses.
    // Только финальный промах (строка 135) считается miss.
    if (!Array.isArray(messages)) { return null; }
    const norm = normalizeMessages(messages);
    if (!norm || looksLikeCode(messages)) { return null; }
    if (messages.some(m => m && (typeof m.content !== 'string' || m.role === 'tool'))) { return null; }

    const qgrams = new Set(trigrams(norm));
    if (qgrams.size === 0) { return null; }

    let bestKey = null;
    let bestSim = 0;
    for (const [key, entry] of this.cache) {
      if (entry.model !== model || entry.temperature !== temperature) continue;
      if (!entry.grams || entry.grams.length === 0) continue;
      const sim = dice(qgrams, new Set(entry.grams));
      if (sim > bestSim) { bestSim = sim; bestKey = key; }
    }

    if (!bestKey || bestSim < minSimilarity) { this.misses++; return null; }

    const entry = this.cache.get(bestKey);
    // Bump TTL + usage like a regular hit so hot semantic entries stay cached.
    entry.created = Date.now();
    entry.uses = (entry.uses || 0) + 1;
    this.cache.delete(bestKey);
    this.cache.set(bestKey, entry);
    this.semHits++;
    return { value: entry.value, similarity: Math.round(bestSim * 1000) / 1000 };
  }

  set(model, messages, temperature, value, providerKey, tools) {
    const key = this._key(model, messages, temperature, tools);

    // Delete if exists (to update order)
    if (this.cache.has(key)) this.cache.delete(key);

    // Evict least-used entry if at capacity (not just oldest)
    if (this.cache.size >= this.maxSize) {
      let victim = null;
      let minUses = Infinity;
      for (const [k, e] of this.cache) {
        const u = e.uses || 0;
        if (u < minUses) { minUses = u; victim = k; }
      }
      if (victim) this.cache.delete(victim);
    }

    // Семантический индекс: триграммы нормализованного диалога + параметры
    // запроса. Для кода/content-массивов grams не строим (их и так не ищем).
    let grams = null;
    const norm = normalizeMessages(messages);
    if (norm && !looksLikeCode(messages) &&
        !(Array.isArray(messages) && messages.some(m => m && (typeof m.content !== 'string' || m.role === 'tool')))) {
      grams = new Set(trigrams(norm));
    }

    this.cache.set(key, { value, created: Date.now(), uses: 0, model, temperature, grams: grams ? [...grams] : null, providerKey: providerKey || null });
  }

  // Вернуть провайдер-источник кэш-записи (для диагностики: кэш-хит может
  // скрывать реальный источник ответа). null → записи нет/без провайдера.
  getProvider(model, messages, temperature) {
    const key = this._key(model, messages, temperature);
    const entry = this.cache.get(key);
    return entry ? (entry.providerKey || null) : null;
  }

  stats() {
    // Распределение кэш-записей по провайдерам-источникам (для дашборда).
    const byProvider = {};
    for (const entry of this.cache.values()) {
      const pk = entry.providerKey || 'unknown';
      byProvider[pk] = (byProvider[pk] || 0) + 1;
    }
    return {
      hits: this.hits,
      misses: this.misses,
      semHits: this.semHits,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.hits + this.misses > 0
        ? Math.round((this.hits / (this.hits + this.misses)) * 100)
        : 0,
      byProvider,
    };
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    try { fs.unlinkSync(CACHE_PATH); } catch {}
  }
}

// Auto-persist every 60 seconds
const _persistTimer = setInterval(() => {
  const c = module.exports._activeCache;
  if (c) c.persist();
}, 60000);
if (_persistTimer.unref) _persistTimer.unref();

module.exports = { LRUCache, _stopTimers: () => clearInterval(_persistTimer) };

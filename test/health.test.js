// test/health.test.js — units для почасового буфера (sparkline 24ч).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.STATE_PATH = process.env.STATE_PATH || path.join(os.tmpdir(), 'freegate-health-test-state.json');

function loadFresh() {
  try { delete require.cache[require.resolve('../lib/health')]; } catch {}
  const mod = require('../lib/health');
  // Каждый пересозданный модуль заводит свой _saveTimer; глушим прежний,
  // чтобы не копить таймеры между тестами.
  if (mod._stopTimers) mod._stopTimers();
  return require('../lib/health');
}

describe('health hourly buffer', () => {
  it('getHourly returns bins for elapsed UTC hours of today', () => {
    const h = loadFresh();
    const bins = h.getHourly();
    assert.ok(Array.isArray(bins), 'is array');
    assert.ok(bins.length >= 1, 'at least current hour');
    const last = bins[bins.length - 1];
    assert.ok(last.hour, 'has hour key');
    assert.equal(typeof last.total, 'number', 'total numeric');
  });

  it('recordRequest feeds hourly bin counters', () => {
    const h = loadFresh();
    h.recordRequest('prov-x', true);   // success
    h.recordRequest('prov-x', false);  // fail
    const bins = h.getHourly();
    const last = bins[bins.length - 1];
    assert.equal(last.total, 2, 'two requests in current hour');
    assert.equal(last.ok, 1, 'one success');
  });

  it('success rate degrades when failures dominate', () => {
    const h = loadFresh();
    for (let i = 0; i < 3; i++) h.recordRequest('prov-x', true);
    for (let i = 0; i < 7; i++) h.recordRequest('prov-x', false);
    const bins = h.getHourly();
    const last = bins[bins.length - 1];
    assert.equal(last.total, 10);
    assert.equal(last.ok, 3);
  });
});

describe('health state pruning + atomic save', () => {
  it('saveStateSync writes stats to disk atomically', () => {
    const h = loadFresh();
    const p = h._statePath();
    h.recordRequest('prov-prune-a', true);
    h.saveStateSync();
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(raw.stats.totalRequests, 1);
    assert.equal(raw.stats.dailyUsage['prov-prune-a'][new Date().toISOString().slice(0, 10)], 1);
    assert.ok(!fs.existsSync(p + '.tmp'), 'no leftover tmp file after sync save');
  });

  it('async saveState coalesces and leaves no .tmp behind', async () => {
    const h = loadFresh();
    const p = h._statePath();
    h.recordRequest('prov-prune-b', true);
    for (let i = 0; i < 5; i++) h.saveState(); // overlapping async saves
    await new Promise(r => setTimeout(r, 300));
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(raw.stats.totalRequests, 1);
    assert.ok(!fs.existsSync(p + '.tmp'), 'no leftover tmp file after async save');
  });

  it('pruneState drops dailyUsage/reliability older than 30 days', () => {
    const h = loadFresh();
    const statsRef = h._statsRef();
    const oldDay = '2020-01-01';
    const today = new Date().toISOString().slice(0, 10);
    statsRef.dailyUsage = statsRef.dailyUsage || {};
    statsRef.dailyUsage['prov-prune-c'] = { [oldDay]: 100, [today]: 3 };
    statsRef.reliability = statsRef.reliability || {};
    statsRef.reliability['prov-prune-d'] = { success: 1, fail: 0, day: oldDay };
    statsRef.reliability['prov-prune-e'] = { success: 2, fail: 0, day: today };
    h.pruneState();
    const du = statsRef.dailyUsage['prov-prune-c'];
    assert.strictEqual(du[oldDay], undefined, 'старая дата должна быть удалена');
    assert.strictEqual(du[today], 3, 'текущая дата сохраняется');
    assert.strictEqual(statsRef.reliability['prov-prune-d'], undefined, 'старая reliability удалена');
    assert.ok(statsRef.reliability['prov-prune-e'], 'актуальная reliability остаётся');
  });

  it('saveState prunes stale telemetry before persisting', () => {
    const h = loadFresh();
    const p = h._statePath();
    const statsRef = h._statsRef();
    const oldDay = '2015-06-01';
    statsRef.dailyUsage = statsRef.dailyUsage || {};
    statsRef.dailyUsage['prov-prune-f'] = { [oldDay]: 42 };
    h.saveStateSync();
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(raw.stats.dailyUsage['prov-prune-f'], undefined, 'старая телеметрия не должна попасть на диск');
  });
});

describe('circuit breaker 404 backoff', () => {
  it('first 404 trip is short, sustained failures back off to 5min cap', () => {
    const h = loadFresh();
    const k = 'backoff-404';
    for (let i = 0; i < 3; i++) h.recordFailure(k, 404);
    const cb1 = h.getCircuitBreakers()[k];
    const d1 = cb1.openUntil - Date.now();
    assert.ok(d1 <= 70000, 'short first break, got ' + d1 + 'ms');
    for (let i = 0; i < 3; i++) h.recordFailure(k, 404);
    const cb2 = h.getCircuitBreakers()[k];
    const d2 = cb2.openUntil - Date.now();
    assert.ok(d2 > 70000, 'backoff grew, got ' + d2 + 'ms');
    for (let i = 0; i < 3; i++) h.recordFailure(k, 404);
    const cb3 = h.getCircuitBreakers()[k];
    const d3 = cb3.openUntil - Date.now();
    assert.ok(d3 <= 5 * 60 * 1000 + 2000, 'capped at ~5min, got ' + d3 + 'ms');
  });

  it('success resets backoff — next 404 trip is short again', () => {
    const h = loadFresh();
    const k = 'backoff-reset';
    for (let i = 0; i < 3; i++) h.recordFailure(k, 404);
    h.recordSuccess(k);
    for (let i = 0; i < 3; i++) h.recordFailure(k, 404);
    const d = h.getCircuitBreakers()[k].openUntil - Date.now();
    assert.ok(d <= 70000, 'reset → short, got ' + d + 'ms');
  });
});

after(() => {
  try { require('fs').unlinkSync(process.env.STATE_PATH); } catch {}
  try { require('fs').unlinkSync(process.env.STATE_PATH + '.tmp'); } catch {}
  require('../lib/health')._stopTimers && require('../lib/health')._stopTimers();
});

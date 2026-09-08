// lib/health.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { ContextStats } = require('./contextstats');

const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, '..', 'state.json');

let health = {};
let circuitBreakers = {};
let stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, providerUsage: {}, errors: {}, errorsDay: '', startTime: Date.now(), tokenUsage: {}, bandit: { low: {}, med: {}, high: {} } };
const contextStats = new ContextStats();
let lastSelection = null;

// Coalescing flags for async atomic state saves.
let _saving = false;
let _pendingSave = false;

const MAX_RECENT = 50;
let recent = [];
let rpm = [];
let currentRpmMinute = 0;

// Почасовое кольцо успеха (24 бина по UTC-часу). Для sparkline в дашборде.
// Каждый бин: { hour: 'YYYY-MM-DDTHH', ok, total }. Пустые часы (ещё не наступили) — total:0.
const HOURLY_MAX = 24;
let hourly = [];
let hourlyDay = ''; // текущий день контекста (dayKey), чтобы не путать часы между днями

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hourKey() {
  return new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
}

function ensureHourly() {
  const dk = dayKey();
  if (hourlyDay !== dk || hourly.length === 0) {
    hourlyDay = dk;
    hourly = [];
    // Заполняем прошедшие часы этого UTC-дня нулями + текущий.
    const nowHour = new Date().getUTCHours();
    for (let h = 0; h <= nowHour; h++) {
      hourly.push({ hour: dk + 'T' + String(h).padStart(2, '0'), ok: 0, total: 0 });
    }
  }
}

function recordHourly(success) {
  ensureHourly();
  const hk = hourKey();
  const last = hourly[hourly.length - 1];
  if (last && last.hour !== hk) {
    // Новый час — добавляем бин, держим максимум HOURLY_MAX.
    hourly.push({ hour: hk, ok: 0, total: 0 });
    if (hourly.length > HOURLY_MAX) hourly.shift();
  }
  const bin = hourly[hourly.length - 1];
  if (bin) { bin.total++; if (success) bin.ok++; }
}

function getHourly() {
  ensureHourly();
  return hourly;
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    health = data.health || {};
    circuitBreakers = data.circuitBreakers || {};
    const saved = data.stats || {};
    stats = {
      totalRequests: saved.totalRequests || 0,
      successfulRequests: saved.successfulRequests || 0,
      failedRequests: saved.failedRequests || 0,
      providerUsage: saved.providerUsage || {},
      errors: saved.errors || {},
      errorsDay: saved.errorsDay || '',
      startTime: saved.startTime || Date.now(),
      tokenUsage: saved.tokenUsage || {},
      dailyUsage: saved.dailyUsage || {},
      reliability: saved.reliability || {},
      bandit: saved.bandit || { low: {}, med: {}, high: {} },
    };
    contextStats.load(saved.context);
    // Reset the error counter for a new day. state.json may have been written
    // on a previous day (or lack errorsDay), so clear all-time errors now.
    const today = new Date().toISOString().slice(0, 10);
    if (stats.errorsDay !== today) {
      stats.errorsDay = today;
      stats.errors = {};
    }
    pruneState();
    logger.info('State loaded', { healthKeys: Object.keys(health) });
  } catch {
    logger.info('No state file, starting fresh');
  }
}

function recordSelection(providerKey, modelName, requestedModel) {
  lastSelection = {
    provider: providerKey,
    model: modelName,
    requested: requestedModel,
    at: Date.now(),
  };
}

function getLastSelection() { return lastSelection; }

function saveState() {
  if (_saving) { _pendingSave = true; return false; }
  _saving = true;
  return (async () => {
    let snapshot;
    try {
      pruneState();
      snapshot = snapshotState();
    } catch (err) {
      logger.error('Failed to build state snapshot', { error: err.message });
      _saving = false;
      return false;
    }
    try {
      const tmp = STATE_PATH + '.tmp';
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, STATE_PATH);
    } catch (err) {
      logger.error('Failed to save state', { error: err.message });
      try { if (fs.existsSync(STATE_PATH + '.tmp')) fs.unlinkSync(STATE_PATH + '.tmp'); } catch {}
    } finally {
      _saving = false;
      if (_pendingSave) {
        _pendingSave = false;
        return saveState();
      }
    }
    return true;
  })();
}

function snapshotState() {
  const context = contextStats.serialize();
  return JSON.stringify({ health, circuitBreakers, stats: { ...stats, context } }, null, 2);
}

// Synchronous atomic save — only for shutdown, where a flush must happen
// before process.exit() runs.
function saveStateSync() {
  try {
    pruneState();
    const snapshot = snapshotState();
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, snapshot, 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    return true;
  } catch (err) {
    logger.error('Failed to save state (sync)', { error: err.message });
    return false;
  }
}

// Keep telemetry bounded: daily/weekly tallies older than 30 days are dropped.
const PRUNE_DAYS = 30;
function pruneState() {
  const cutoff = new Date(Date.now() - PRUNE_DAYS * 86400000).toISOString().slice(0, 10);
  const du = stats.dailyUsage;
  if (du) {
    for (const [provider, days] of Object.entries(du)) {
      for (const day of Object.keys(days)) {
        if (day < cutoff) delete days[day];
      }
      if (Object.keys(days).length === 0) delete du[provider];
    }
  }
  const rel = stats.reliability;
  if (rel) {
    for (const [provider, r] of Object.entries(rel)) {
      if (r && r.day && r.day < cutoff) delete rel[provider];
    }
  }
}

function initHealth(key) {
  if (!health[key]) {
    health[key] = { score: 50, latency: 0, lastCheck: 0, status: 'unknown', quota: '--' };
  }
}

function isCircuitOpen(key) {
  const cb = circuitBreakers[key];
  if (!cb || !cb.openUntil) return false;
  if (Date.now() > cb.openUntil) {
    cb.openUntil = null;
    cb.failures = 0;
    return false;
  }
  return true;
}

function recordSuccess(key) {
  circuitBreakers[key] = { failures: 0, lastFailure: 0, openUntil: null, opens: 0 };
  initHealth(key);
  health[key].status = 'up';
  health[key].score = Math.min(100, health[key].score + 10);
}

function recordFailure(key, statusCode, opts) {
  if (!circuitBreakers[key]) circuitBreakers[key] = { failures: 0, lastFailure: 0, openUntil: null, opens: 0 };
  const cb = circuitBreakers[key];
  cb.failures++;
  cb.lastFailure = Date.now();
  // Classify errors: hard errors open the breaker much longer than soft ones
  const baseMs = classifyErrorMs(statusCode, opts);
  // Soft trips (health-probe 404s etc.): первый trip короткий (60s), консекутивные
  // растут экспоненциально (2× за каждый последующий trip) до cap 5 минут.
  // Успех (recordSuccess) сбрасывает счётчик opens — следующий сбой опять короткий.
  let openMs = baseMs;
  if (baseMs <= 60000) {
    openMs = Math.min(300000, baseMs * Math.pow(2, cb.opens));
  }
  if (cb.failures >= 3 || openMs > 60000) {
    cb.openUntil = Date.now() + Math.max(openMs, 60000);
    cb.failures = 0;
    cb.opens++;
    cb.reason = statusCode;
    logger.warn('Circuit breaker opened', { key, statusCode, openMs });
  }
}

// How long to hold the breaker open for a given HTTP status.
// 401/403 = bad key (long), 429 = rate limit (medium), 5xx = overload (short, retry soon)
function classifyErrorMs(statusCode, opts) {
  const s = statusCode || 0;
  if (s === 401 || s === 403) return 300000;      // 5 min — key is dead
  if (s === 429) return 120000;                    // 2 min — rate limited, wait for reset
  if (s >= 500) return 30000;                      // 30s — transient overload
  if (s === 404) {
    // provider-side 404 (upstream temporarily failing) → short break so the
    // periodic health-check gets a chance to re-enable; only a TRUE "model
    // does not exist" 404 (handled in server.js as permanent disable) gets the
    // long trip. Soft trips use the exponential backoff above (first ~60s).
    if (opts && opts.providerSide) return 70000;   // 70s — Nvidia/etc. quota/overload
    return 60000;                                  // 60s — health probe, back off on repeats
  }
  return 60000;                                    // default
}

function recordRequest(providerKey, success, error = null) {
  recordRpm();
  recordHourly(success);
  stats.totalRequests++;
  const today = new Date().toISOString().slice(0, 10);
  // Error counter is all-time by default; reset it once per UTC day (like reliability).
  if (stats.errorsDay !== today) { stats.errorsDay = today; stats.errors = {}; }
  if (success) {
    stats.successfulRequests++;
    stats.providerUsage[providerKey] = (stats.providerUsage[providerKey] || 0) + 1;
    // Daily counter for limit tracking (resets each UTC day)
    stats.dailyUsage = stats.dailyUsage || {};
    stats.dailyUsage[providerKey] = stats.dailyUsage[providerKey] || {};
    stats.dailyUsage[providerKey][today] = (stats.dailyUsage[providerKey][today] || 0) + 1;
    // Reliability: count today's successes per provider
    stats.reliability = stats.reliability || {};
    stats.reliability[providerKey] = stats.reliability[providerKey] || { success: 0, fail: 0, day: '' };
    const r = stats.reliability[providerKey];
    if (r.day !== today) { r.day = today; r.success = 0; r.fail = 0; }
    r.success++;
  } else {
    stats.failedRequests++;
    if (error) stats.errors[providerKey] = (stats.errors[providerKey] || 0) + 1;
    // Reliability: count today's failures
    stats.reliability = stats.reliability || {};
    stats.reliability[providerKey] = stats.reliability[providerKey] || { success: 0, fail: 0, day: '' };
    const r = stats.reliability[providerKey];
    if (r.day !== today) { r.day = today; r.success = 0; r.fail = 0; }
    r.fail++;
  }
}

// Reliability ratio (0..1) for today. Providers with 100% success get a boost at startup.
function getReliability() {
  return stats.reliability || {};
}

function recordTokens(providerKey, usage) {
  if (!usage) return;
  const tu = stats.tokenUsage[providerKey] || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  tu.promptTokens += usage.prompt_tokens || 0;
  tu.completionTokens += usage.completion_tokens || 0;
  tu.totalTokens += usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  stats.tokenUsage[providerKey] = tu;
}

function getHealth() { return health; }
function getStats() { return stats; }
function getCircuitBreakers() { return circuitBreakers; }

function recordRecent(entry) {
  recent.unshift({ timestamp: Date.now(), ...entry });
  if (recent.length > MAX_RECENT) recent.pop();
}

function recordRpm() {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (minute !== currentRpmMinute) {
    currentRpmMinute = minute;
    rpm.unshift({ timestamp: now, count: 1 });
    if (rpm.length > 60) rpm.pop();
  } else if (rpm.length > 0) {
    rpm[0].count++;
  } else {
    rpm.unshift({ timestamp: now, count: 1 });
  }
}

function getRecent() { return recent; }
function getRpm() { return rpm; }
function getDailyUsage() { return stats.dailyUsage || {}; }

function getBandit() { return stats.bandit; }
function recordBandit(bucketName, key, success) {
  stats.bandit[bucketName] = stats.bandit[bucketName] || {};
  stats.bandit[bucketName][key] = stats.bandit[bucketName][key] || { a: 1, b: 1 };
  if (success) stats.bandit[bucketName][key].a += 1;
  else stats.bandit[bucketName][key].b += 1;
}

// Warm start for bandit priors: a brand-new (or auto-disabled-then-re-enabled)
// provider enters with Beta(1,1) = uniform, which makes Thompson sampling pick it
// with ~random weight at first and explore for a LONG time before trusting it —
// even if its weight/score is good. This biases those providers toward a mild
// optimistic prior (a=6,b=2 → mean 75%, ~8 trials of confidence) so they get
// selected soon after going live, without ever dominating hardened favorites
// (e.g. or-ox-alpha with dozens of real outcomes).
function warmBanditPriors(enabledKeys, bucketKeys) {
  if (!Array.isArray(enabledKeys) || bucketKeys.length === 0) return 0;
  let warmed = 0;
  for (const key of enabledKeys) {
    for (const bucketName of bucketKeys) {
      stats.bandit[bucketName] = stats.bandit[bucketName] || {};
      const p = stats.bandit[bucketName][key];
      // Only touch true cold-starts or tiny dead priors; NEVER reset proven ones.
      if (!p || (p.a === 1 && p.b === 1) || (p.a + p.b <= 4)) {
        stats.bandit[bucketName][key] = { a: 6, b: 2 };
        warmed++;
      }
    }
  }
  return warmed;
}

// Auto-save every 30 seconds
const _saveTimer = setInterval(saveState, 30000);
if (_saveTimer.unref) _saveTimer.unref();

function _stopTimers() { clearInterval(_saveTimer); }

module.exports = {
  loadState, saveState, initHealth, isCircuitOpen,
  recordSuccess, recordFailure, recordRequest, recordTokens,
  getHealth, getStats, getCircuitBreakers,
  recordRecent, recordRpm, getRecent, getRpm,
  getDailyUsage, getReliability,
  getHourly,
  recordSelection, getLastSelection,
  getBandit, recordBandit, warmBanditPriors,
  getContextStats: () => contextStats,
  saveStateSync, pruneState,
  _statePath: () => STATE_PATH,
  _statsRef: () => stats,
  _stopTimers,
};

// lib/rateLimit.js — per-client sliding rate limiter.
// Bounded in-memory Map with TTL cleanup and LRU-ish eviction so a flood of
// unique source IPs cannot grow memory forever.
const MAX_CLIENTS = 10000;
const STALE_MS = 2 * 60 * 1000; // prune clients idle longer than this

const rateLimits = new Map();

function prune() {
  const now = Date.now();
  for (const [key, rec] of rateLimits) {
    if (rec.lastSeen < now - STALE_MS && now > rec.resetAt) {
      rateLimits.delete(key);
    }
  }
}

function evictIfNeeded() {
  if (rateLimits.size <= MAX_CLIENTS) return;
  // Remove the oldest-seen entry to keep the map bounded.
  let oldestKey = null;
  let oldestSeen = Infinity;
  for (const [key, rec] of rateLimits) {
    if (rec.lastSeen < oldestSeen) {
      oldestSeen = rec.lastSeen;
      oldestKey = key;
    }
  }
  if (oldestKey) rateLimits.delete(oldestKey);
}

// Returns { allowed, limit, remaining, resetAt, retryAfter }.
// Caller decides how to render (headers, status codes). Pure counting per key.
function checkRateLimit(serviceKey, limit, windowMs) {
  const now = Date.now();
  let rec = rateLimits.get(serviceKey);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, windowStart: now, resetAt: now + windowMs, lastSeen: now };
    rateLimits.set(serviceKey, rec);
  } else {
    rec.count++;
    rec.lastSeen = now;
  }
  evictIfNeeded();
  const remaining = Math.max(0, limit - rec.count);
  return {
    allowed: rec.count <= limit,
    limit,
    remaining,
    resetAt: rec.resetAt,
    retryAfter: rec.count > limit ? Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) : 0,
  };
}

function getStats() {
  const out = {};
  for (const [k, v] of rateLimits) {
    out[k] = { count: v.count, resetAt: v.resetAt };
  }
  return out;
}

// Test helpers.
function _clear() { rateLimits.clear(); }
function _size() { return rateLimits.size; }
function _pruneNow() { prune(); }

const _cleanupTimer = setInterval(prune, STALE_MS);
if (_cleanupTimer.unref) _cleanupTimer.unref();
function _stopTimers() { clearInterval(_cleanupTimer); }

module.exports = { checkRateLimit, getStats, _clear, _size, _pruneNow, _stopTimers };
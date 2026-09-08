// test/metrics.test.js — живой smoke для /v1/metrics, X-Request-Id и auth.
// Запускает server.js как child-процесс на свободном порту с изолированными
// путями (state/cache/log) и фейковым AUTH.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SERVER = path.join(__dirname, '..', 'server.js');
const AUTH = 'metrics-test-key-1234';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startProxy(t, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--auth', AUTH], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUTH, HOST: '127.0.0.1', STATE_PATH: path.join(dir, 'state.json'), CACHE_PATH: path.join(dir, 'cache.json'), LOG_PATH: path.join(dir, 'log.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    try { child.kill('SIGTERM'); } catch {}
  });
  return child;
}

async function waitHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await new Promise((resolve, reject) => {
        const r = http.get(`http://127.0.0.1:${port}/health`, (x) => resolve(x));
        r.on('error', reject);
        r.setTimeout(2000, () => { r.destroy(); reject(new Error('timeout')); });
      });
      if (res.statusCode === 200) { res.resume(); return; }
      res.resume();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy on :' + port);
}

function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    http.get(pathAndQuery, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

test('live: /v1/metrics auth+payload, X-Request-Id present, /health open', async (t) => {
  const port = await freePort();
  startProxy(t, port);
  await waitHealth(port);

  // /v1/metrics без ключа → 401
  const noKey = await get(`http://127.0.0.1:${port}/v1/metrics`);
  assert.strictEqual(noKey.status, 401, 'metrics without key must be 401');

  // /v1/metrics с ключом → 200, JSON-форма, reqId заголовок
  const withKey = await get(`http://127.0.0.1:${port}/v1/metrics?key=${AUTH}`);
  assert.strictEqual(withKey.status, 200);
  assert.ok(withKey.headers['x-request-id'], 'X-Request-Id must be set');
  const m = JSON.parse(withKey.body);
  assert.ok(m.started_at > 0, 'started_at');
  assert.ok(m.uptime_seconds >= 0, 'uptime_seconds');
  assert.strictEqual(m.pid, m.pid > 0 && m.pid);
  assert.ok(m.process && m.process.heapUsed > 0, 'process.heapUsed');
  assert.ok(m.counters && typeof m.counters.requests === 'number', 'counters.requests');
  assert.ok(m.counters.by_status && typeof m.counters.by_status === 'object', 'by_status');
  assert.ok(m.state && m.state.circuit_breakers && typeof m.state.circuit_breakers.open === 'number', 'state.circuit_breakers');
  assert.ok(m.state.cache && typeof m.state.cache.size === 'number', 'state.cache.size');

  // Запросы в /v1/stats тоже несут reqId и считаются.
  const stats = await get(`http://127.0.0.1:${port}/v1/stats?key=${AUTH}`);
  assert.strictEqual(stats.status, 200);
  assert.ok(stats.headers['x-request-id']);
  const m2 = JSON.parse((await get(`http://127.0.0.1:${port}/v1/metrics?key=${AUTH}`)).body);
  assert.ok(m2.counters.requests >= 2, 'requests counter grows with each request');

  // /health остаётся публичным.
  const health = await get(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(health.status, 200);
});
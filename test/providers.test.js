// test/providers.test.js — callProvider signal/abort support.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { callProvider } = require('../lib/providers');

function stallServer(handler) {
  const s = http.createServer(handler);
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s)));
}

async function withServer(t, handler) {
  const server = await stallServer(handler);
  t.after(() => {
    try { server.closeAllConnections?.(); } catch {}
    server.close();
  });
  return server;
}

function makeProvider(server) {
  const addr = server.address();
  return {
    key: 'test-prov',
    model: 'test-model',
    endpoint: `http://127.0.0.1:${addr.port}/chat/completions`,
  };
}

function settle(promise, ms) {
  return Promise.race([
    promise.then(() => 'resolved').catch((err) => ({ name: err.name, message: String(err.message).slice(0, 80) })),
    new Promise((r) => setTimeout(() => r('timeout'), ms)),
  ]);
}

test('callProvider rejects with AbortError when signal aborts mid-flight', async (t) => {
  const server = await withServer(t, (req, res) => {
    // Never respond — keep the socket hanging until timeout/abort.
    req.on('data', () => {});
  });
  const controller = new AbortController();
  const promise = callProvider(makeProvider(server), { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }, 30000, 1, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const result = await settle(promise, 2000);
  assert.notStrictEqual(result, 'timeout', 'call should settle (not hang) after abort');
  assert.strictEqual(result.name, 'AbortError', 'expected AbortError, got: ' + result.message);
});

test('callProvider ignores abort after it has already resolved (winner path)', async (t) => {
  const server = await withServer(t, (req, res) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} }));
    });
  });
  const controller = new AbortController();
  const r = await callProvider(makeProvider(server), { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }, 30000, 1, controller.signal);
  assert.strictEqual(r.statusCode, 200);
  // Aborting after settle must not throw or reject anything unhandled.
  controller.abort();
});

test('callProvider with an already-aborted signal rejects immediately', async (t) => {
  const server = await withServer(t, (req, res) => {
    req.on('data', () => {});
  });
  const controller = new AbortController();
  controller.abort();
  const result = await settle(
    callProvider(makeProvider(server), { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, 30000, 1, controller.signal),
    2000
  );
  assert.notStrictEqual(result, 'timeout');
  assert.strictEqual(result.name, 'AbortError');
});

test('callProvider without a signal still works (no regression)', async (t) => {
  const server = await withServer(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }));
    });
  });
  const r = await callProvider(makeProvider(server), { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.statusCode, 200);
});
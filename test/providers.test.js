// test/providers.test.js — callProvider signal/abort + retry/fallback/load.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.LOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prov-log-')), 'log');
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

// --- Retry / fallback / load semantics --------------------------------------

function jsonProvider(server, key = 'test-prov') {
  const p = makeProvider(server);
  p.key = key;
  return p;
}

test('callProvider retries transient 5xx then succeeds on retry', async (t) => {
  let calls = 0;
  const server = await withServer(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls++;
      if (calls === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered' } }] }));
    });
  });
  const r = await callProvider(jsonProvider(server), { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 30000, 2);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls, 2, 'first call 500, second retried ok');
});

test('callProvider fails fast on 404/429/401/403 (no retry burn)', async (t) => {
  for (const status of [404, 429, 401, 403]) {
    let calls = 0;
    const server = await withServer(t, (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        calls++;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'nope' } }));
      });
    });
    const result = await settle(callProvider(jsonProvider(server, 'p-' + status), { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 30000, 5), 3000);
    assert.strictEqual(typeof result, 'object', 'must reject for ' + status);
    assert.ok(String(result.message).includes(String(status)), 'rejects with status ' + status + ' in message: ' + result.message);
    assert.strictEqual(calls, 1, 'no retry for ' + status);
  }
});

test('callProvider never retries in streaming mode (no double stream)', async (t) => {
  let calls = 0;
  const server = await withServer(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    });
  });
  const result = await settle(callProvider(jsonProvider(server), { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, 30000, 3), 3000);
  assert.strictEqual(typeof result, 'object');
  assert.ok(String(result.message).includes('500'), 'stream: rejects with 500, no silent hang (got: ' + result.message + ')');
  assert.strictEqual(calls, 1, 'no retry while streaming');
});

test('multi-provider fallback chain: primary 500 → backup 200', async (t) => {
  let primaryCalls = 0;
  const primary = await withServer(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      primaryCalls++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'degraded' } }));
    });
  });
  const backup = await withServer(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'backup ok' } }], usage: {} }));
    });
  });

  // Та же семантика, что в server.js fallbackProviders: идём по списку,
  // первый 200 выигрывает, ошибка primary не роняет запрос.
  const chain = [
    { key: 'primary', provider: jsonProvider(primary, 'primary') },
    { key: 'backup', provider: jsonProvider(backup, 'backup') },
  ];
  let result;
  for (const { provider } of chain) {
    const attempt = await callProvider(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .then((r) => r)
      .catch((err) => err);
    if (attempt && attempt.statusCode === 200) { result = attempt; break; }
  }
  assert.strictEqual(result.statusCode, 200, 'fallback should win after primary 500');
  assert.ok(primaryCalls >= 1, 'primary tried at least once');
  assert.strictEqual(result.data.choices[0].message.content, 'backup ok');
});

test('load: 20 concurrent callProvider calls all succeed', async (t) => {
  let calls = 0;
  const server = await withServer(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  const xs = Array.from({ length: 20 }, () =>
    callProvider(jsonProvider(server), { model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
  const results = await Promise.all(xs);
  await new Promise((r) => setTimeout(r, 50)); // дать счётчику устаканиться
  assert.ok(results.every((r) => r.statusCode === 200), 'all 200');
  assert.strictEqual(calls, 20, 'all 20 reached the provider');
});
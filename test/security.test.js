// test/security.test.js — unit tests for lib/security (auth, body reader,
// chat/shorts validators, key masking) and lib/rateLimit (TTL-bounded limiter).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const {
  timingSafeKey,
  isAuthorized,
  readJsonBody,
  validateChatRequest,
  validateShortsRequest,
  maskKey,
} = require('../lib/security');
const { checkRateLimit } = require('../lib/rateLimit');

function fakeReq(payload, opts) {
  const req = new EventEmitter();
  req.destroyed = false;
  req.paused = false;
  req.destroy = () => { req.destroyed = true; };
  req.pause = () => { req.paused = true; };
  process.nextTick(() => {
    if (payload && payload.length > 0) req.emit('data', payload);
    if (!opts || !opts.abort) req.emit('end');
  });
  return req;
}

function fakeServerReq(headers, url) {
  const req = new EventEmitter();
  req.headers = headers;
  req.url = url;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

test('timingSafeKey: equal strings match, length mismatch and non-strings fail', () => {
  assert.strictEqual(timingSafeKey('secret-abc', 'secret-abc'), true);
  assert.strictEqual(timingSafeKey('secret-abc', 'secret-abd'), false);
  assert.strictEqual(timingSafeKey('short', 'a-much-longer-key'), false);
  assert.strictEqual(timingSafeKey(null, 'x'), false);
  assert.strictEqual(timingSafeKey('x', undefined), false);
  assert.strictEqual(timingSafeKey(123, '123'), false);
});

test('isAuthorized: no AUTH_KEY configured → everything allowed', () => {
  const req = fakeServerReq({}, '/v1/models');
  assert.strictEqual(isAuthorized(req, ''), true);
  assert.strictEqual(isAuthorized(req, null), true);
});

test('isAuthorized: correct Authorization bearer passes, wrong fails', () => {
  const req = fakeServerReq({ authorization: 'Bearer sekret' }, '/v1/models');
  assert.strictEqual(isAuthorized(req, 'sekret'), true);
  const bad = fakeServerReq({ authorization: 'Bearer wrong' }, '/v1/models');
  assert.strictEqual(isAuthorized(bad, 'sekret'), false);
});

test('isAuthorized: ?key= query param accepted (browser/admin routes)', () => {
  const req = fakeServerReq({}, '/v1/config?key=sekret');
  assert.strictEqual(isAuthorized(req, 'sekret'), true);
  const bad = fakeServerReq({}, '/v1/config?key=wrong');
  assert.strictEqual(isAuthorized(bad, 'sekret'), false);
});

test('isAuthorized: missing header with auth configured → not authorized', () => {
  const req = fakeServerReq({}, '/v1/stats');
  assert.strictEqual(isAuthorized(req, 'sekret'), false);
});

test('readJsonBody: parses valid JSON', async () => {
  const r = await readJsonBody(fakeReq(Buffer.from('{"a":1,"b":"x"}')), 1024);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, { a: 1, b: 'x' });
});

test('readJsonBody: empty body → EMPTY_BODY', async () => {
  const r = await readJsonBody(fakeReq(Buffer.from('')), 1024);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'EMPTY_BODY');
});

test('readJsonBody: invalid JSON → INVALID_JSON', async () => {
  const r = await readJsonBody(fakeReq(Buffer.from('{invalid')), 1024);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INVALID_JSON');
});

test('readJsonBody: payload over limit → PAYLOAD_TOO_LARGE and stream paused', async () => {
  const big = Buffer.from(JSON.stringify({ x: 'y'.repeat(2000) }));
  const req = fakeReq(big, 100);
  const r = await readJsonBody(req, 100);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(req.paused, true, 'поток должен быть приостановлен после превышения лимита');
});

test('readJsonBody: client abort → ABORTED', async () => {
  const req = fakeReq(null, { abort: true });
  // Emulate abort before any payload arrives.
  process.nextTick(() => req.emit('aborted'));
  const r = await readJsonBody(req, 1024);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'ABORTED');
});

test('validateChatRequest: accepts a valid basic request', () => {
  const errors = validateChatRequest({ model: 'tier-s', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepStrictEqual(errors, []);
});

test('validateChatRequest: rejects null/empty/invalid structure', () => {
  assert.ok(validateChatRequest(null).length > 0);
  assert.ok(validateChatRequest({}).length > 0);
  assert.ok(validateChatRequest({ model: 'tier-s', messages: [] }).length > 0);
  assert.ok(validateChatRequest({ model: 'tier-s', messages: 'nope' }).length > 0);
  assert.ok(validateChatRequest({ model: 42, messages: [{ role: 'user', content: 'x' }] }).length > 0);
});

test('validateChatRequest: rejects out-of-range temperature / max_tokens / stream', () => {
  const base = { model: 'tier-s', messages: [{ role: 'user', content: 'x' }] };
  assert.ok(validateChatRequest({ ...base, temperature: -1 }).length > 0);
  assert.ok(validateChatRequest({ ...base, temperature: 2.1 }).length > 0);
  assert.ok(validateChatRequest({ ...base, temperature: '1' }).length > 0);
  assert.deepStrictEqual(validateChatRequest({ ...base, temperature: 0.5 }), []);
  assert.ok(validateChatRequest({ ...base, max_tokens: 0 }).length > 0);
  assert.ok(validateChatRequest({ ...base, max_tokens: -5 }).length > 0);
  assert.ok(validateChatRequest({ ...base, max_tokens: 1.5 }).length > 0);
  assert.ok(validateChatRequest({ ...base, max_tokens: 1000001 }).length > 0);
  assert.deepStrictEqual(validateChatRequest({ ...base, max_tokens: 512 }), []);
  assert.ok(validateChatRequest({ ...base, stream: 'true' }).length > 0);
  assert.deepStrictEqual(validateChatRequest({ ...base, stream: true }), []);
});

test('validateChatRequest: rejects invalid roles but keeps tool/multimodal valid', () => {
  const base = { model: 'tier-s' };
  assert.ok(validateChatRequest({ ...base, messages: [{ role: 'bogus', content: 'x' }] }).length > 0);
  // multimodal content array (image + text) is valid
  assert.deepStrictEqual(validateChatRequest({
    ...base,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'what is this?' }] }],
  }), []);
  // assistant with tool_calls and no content is valid
  assert.deepStrictEqual(validateChatRequest({
    ...base,
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
  }), []);
  // tool message requires tool_call_id
  assert.deepStrictEqual(validateChatRequest({
    ...base,
    messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }],
  }), []);
  assert.ok(validateChatRequest({
    ...base,
    messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result', x: 1 }],
  }).length === 0 || validateChatRequest({ ...base, messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result', x: 1 }] }).join('').indexOf('extra') >= 0);
});

test('validateChatRequest: rejects message with neither content nor tool_calls', () => {
  const errors = validateChatRequest({ model: 'tier-s', messages: [{ role: 'user' }] });
  assert.ok(errors.some(e => e.includes('content')), 'ожидали ошибку про content');
});

test('validateShortsRequest: requires a non-empty string prompt', () => {
  assert.ok(validateShortsRequest({}).length > 0);
  assert.ok(validateShortsRequest({ prompt: '' }).length > 0);
  assert.ok(validateShortsRequest({ prompt: 42 }).length > 0);
  assert.deepStrictEqual(validateShortsRequest({ prompt: 'hello world' }), []);
});

test('validateShortsRequest: bounds duration, steps and format', () => {
  const base = { prompt: 'a forest in autumn' };
  assert.ok(validateShortsRequest({ ...base, duration: 'abc' }).length > 0);
  assert.ok(validateShortsRequest({ ...base, duration: 1 }).length > 0);   // ниже 2
  assert.ok(validateShortsRequest({ ...base, duration: 30 }).length > 0);  // выше 14
  assert.deepStrictEqual(validateShortsRequest({ ...base, duration: 5 }), []);
  assert.ok(validateShortsRequest({ ...base, steps: 0 }).length > 0);
  assert.ok(validateShortsRequest({ ...base, steps: 100 }).length > 0);    // выше 40
  assert.ok(validateShortsRequest({ ...base, steps: 12.5 }).length > 0);   // не целое
  assert.deepStrictEqual(validateShortsRequest({ ...base, steps: 28 }), []);
  assert.ok(validateShortsRequest({ ...base, format: '4:3' }).length > 0);
  assert.deepStrictEqual(validateShortsRequest({ ...base, format: '9:16' }), []);
  assert.deepStrictEqual(validateShortsRequest({ ...base, format: '16:9' }), []);
  assert.deepStrictEqual(validateShortsRequest({ ...base, format: '1:1' }), []);
});

test('validateShortsRequest: rejects over-long prompts', () => {
  const longPrompt = { prompt: 'x'.repeat(5000) };
  assert.ok(validateShortsRequest(longPrompt).length > 0);
});

test('maskKey: never exposes the original for short keys', () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey('a'), '***');
  assert.strictEqual(maskKey('abcdefgh'), '***'); // length 8 → short branch
  const nine = maskKey('abcdefghi');
  assert.ok(nine.includes('***') && nine.length < 9 && !nine.includes('abcdefghi'));
  const seventeen = maskKey('abcdefghijklmnopq'); // 17 chars
  assert.strictEqual(seventeen, 'abcd***nopq');
  // никогда не содержит полный ключ
  for (const input of ['a', 'abcd', 'abcdefgh', 'abcdefghi', 'abcdefghijklmnop']) {
    assert.ok(!maskKey(input).includes(input), `mask(${input}) не должен содержать исходник`);
  }
});

test('rateLimit: allows under limit, blocks over with headers payload', () => {
  const key = `rl-${Date.now()}-${Math.random()}`;
  let r;
  for (let i = 0; i < 5; i++) {
    r = checkRateLimit(key, 5, 60000);
    assert.strictEqual(r.allowed, true, 'request ' + (i + 1) + ' should be allowed');
  }
  r = checkRateLimit(key, 5, 60000);
  assert.strictEqual(r.allowed, false);
  assert.ok(r.retryAfter > 0);
  assert.ok(r.remaining === 0);
  assert.ok(r.resetAt > Date.now());
});

test('rateLimit: window expiry resets the counter', () => {
  const key = `rlw-${Date.now()}-${Math.random()}`;
  // Use a tiny window; after it passes, request is allowed again and the record has reset.
  checkRateLimit(key, 2, 1);
  checkRateLimit(key, 2, 1);
  assert.strictEqual(checkRateLimit(key, 2, 1).allowed, false);
  setTimeout(() => {
    const r = checkRateLimit(key, 2, 1);
    assert.strictEqual(r.allowed, true, 'после окна запрос снова разрешён');
  }, 20);
});

test('rateLimit: distinct clients tracked independently', () => {
  const a = `rla-${Date.now()}-${Math.random()}`;
  const b = `rlb-${Date.now()}-${Math.random()}`;
  assert.strictEqual(checkRateLimit(a, 1, 60000).allowed, true);
  assert.strictEqual(checkRateLimit(a, 1, 60000).allowed, false);
  assert.strictEqual(checkRateLimit(b, 1, 60000).allowed, true);
});
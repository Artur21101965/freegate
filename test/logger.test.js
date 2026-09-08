// test/logger.test.js
// Контракт логгера: все уровни, используемые в server.js/lib, должны
// существовать (иначе вызов падает — TypeError: X is not a function
// и процесс умирает, как было с logger.debug). Формат — структурированный
// NDJSON: одна JSON-строка на запись, чтобы лог можно было grep/jq-ить.
const { test } = require('node:test');
const assert = require('node:assert');
const logger = require('../lib/logger');

for (const level of ['info', 'warn', 'error', 'debug', 'request']) {
  test(`logger exposes '${level}'`, () => {
    assert.strictEqual(typeof logger[level], 'function', `logger.${level} must be a function`);
  });
}

test('_formatLine emits one-line JSON (NDJSON)', () => {
  const line = logger._formatLine('INFO', 'Freegate started', { port: 4010 });
  assert.strictEqual(typeof line, 'string');
  assert.ok(line.endsWith('\n'), 'line must end with a newline');
  assert.strictEqual((line.match(/\n/g) || []).length, 1, 'no embedded newlines');
  const obj = JSON.parse(line);
  assert.ok(obj.ts, 'ts must be present');
  assert.strictEqual(obj.level, 'INFO');
  assert.strictEqual(obj.msg, 'Freegate started');
  assert.strictEqual(obj.port, 4010);
});

test('request() keeps a greppable REQ summary in msg, details in fields', () => {
  const line = logger._formatLine('REQ', 'REQ codestral openrouter 200', {
    model: 'codestral',
    provider: 'openrouter',
    status: 200,
    latency: 123,
    stream: true,
  });
  const obj = JSON.parse(line);
  assert.match(obj.msg, /^REQ .*codestral.*openrouter.*200/);
  assert.strictEqual(obj.model, 'codestral');
  assert.strictEqual(obj.provider, 'openrouter');
  assert.strictEqual(obj.status, 200);
  assert.strictEqual(obj.latency, 123);
  assert.strictEqual(obj.stream, true);
});
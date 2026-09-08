// test/logger.test.js
// Контракт логгера: все уровни, используемые в server.js/lib, должны
// существовать (иначе вызов падает — TypeError: X is not a function
// и процесс умирает, как было с logger.debug).
const { test } = require('node:test');
const assert = require('node:assert');
const logger = require('../lib/logger');

for (const level of ['info', 'warn', 'error', 'debug', 'request']) {
  test(`logger exposes '${level}'`, () => {
    assert.strictEqual(typeof logger[level], 'function', `logger.${level} must be a function`);
  });
}
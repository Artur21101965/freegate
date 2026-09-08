// lib/logger.js
const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, '..', 'proxy.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 3;

function rotateLog() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;

    // Rotate: delete .3, shift .2 -> .3, .1 -> .2, proxy.log -> .1
    try { if (fs.existsSync(`${LOG_PATH}.${MAX_ROTATIONS}`)) fs.unlinkSync(`${LOG_PATH}.${MAX_ROTATIONS}`); } catch {}
    if (fs.existsSync(`${LOG_PATH}.2`)) fs.renameSync(`${LOG_PATH}.2`, `${LOG_PATH}.3`);
    if (fs.existsSync(`${LOG_PATH}.1`)) fs.renameSync(`${LOG_PATH}.1`, `${LOG_PATH}.2`);
    if (fs.existsSync(LOG_PATH)) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch (err) {
    console.error(`[logger] rotation failed: ${err.message}`);
  }
}

function formatTime() {
  return new Date().toISOString();
}

// Structured NDJSON log: одна JSON-запись на строку → grep/jq-friendly,
// стабильный машинный формат для хвостового мониторинга.
function formatLine(level, message, data) {
  const entry = { ts: formatTime(), level, msg: message };
  return JSON.stringify({ ...entry, ...data }) + '\n';
}

function writeLog(level, message, data) {
  const line = formatLine(level, message, data);
  process.stdout.write(line);
  try {
    rotateLog();
    fs.appendFileSync(LOG_PATH, line);
  } catch (err) {
    console.error(`[logger] write failed: ${err.message}`);
  }
}

module.exports = {
  info: (msg, data) => writeLog('INFO', msg, data),
  error: (msg, data) => writeLog('ERROR', msg, data),
  warn: (msg, data) => writeLog('WARN', msg, data),
  debug: (msg, data) => writeLog('DEBUG', msg, data),
  _formatLine: formatLine,
  request: (data) => writeLog('REQ', `REQ ${data.model || '?'} ${data.provider || '?'} ${data.status || '?'}`, {
    model: data.model,
    provider: data.provider,
    status: data.status,
    latency: data.latency,
    stream: data.stream,
    cached: data.cached,
    reqId: data.reqId,
  }),
};

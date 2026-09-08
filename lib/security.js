// lib/security.js — shared request security helpers for the HTTP layer.
// Pure functions + one byte-counting JSON body reader. No deps beyond stdlib.
const crypto = require('crypto');

const VALID_CHAT_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const VALID_SHORTS_FORMATS = new Set(['9:16', '16:9', '1:1']);

// Tunables shared with server.js-friendly defaults.
const MAX_CHAT_MESSAGES = 1000;
const MAX_CHAT_TOKENS = 100000;
const MAX_SHORTS_PROMPT = 4096;   // chars
const MAX_SHORTS_DURATION = 14;   // MiniMax: 2-14s
const MIN_SHORTS_DURATION = 2;
const MAX_SHORTS_STEPS = 40;      // generator steps guidance: 10-40
const MIN_SHORTS_STEPS = 10;

// --- Constant-time key comparison -------------------------------------------
function timingSafeKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Decide whether a request is authorized to talk to this proxy.
//   req     — { url, headers } (the Node http.IncomingMessage shape is enough)
//   authKey — configured AUTH_KEY ('' / null → auth disabled, everything passes)
// Accepts `Authorization: Bearer <key>` and `?key=<key>` (browser/admin routes).
function isAuthorized(req, authKey) {
  if (!authKey) return true;
  let parsedUrl = null;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
  } catch {
    parsedUrl = { searchParams: new URLSearchParams('') };
  }
  const fromQuery = parsedUrl.searchParams.get('key');
  const fromHeader = (req.headers && req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return timingSafeKey(fromQuery, authKey) || timingSafeKey(fromHeader, authKey);
}

// --- Byte-counting JSON body reader -----------------------------------------
// Resolves a promise; never writes to the response. The caller decides how to
// map the result to a status code. On payload overflow the request stream is
// paused (caller should respond 413 and then destroy() the request).
function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        finish({
          ok: false,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body too large',
          limit: maxBytes,
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        finish({ ok: false, code: 'EMPTY_BODY', message: 'Empty request body' });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch (e) {
        finish({ ok: false, code: 'INVALID_JSON', message: 'Invalid JSON body: ' + e.message });
      }
    };
    const onError = (err) => finish({ ok: false, code: 'STREAM_ERROR', message: 'Request stream error: ' + ((err && err.message) || err) });
    const onAborted = () => finish({ ok: false, code: 'ABORTED', message: 'Request aborted' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

// --- /v1/chat/completions payload validation --------------------------------
// Returns an array of error strings (empty = valid). Keeps tool_calls and
// multimodal content working.
function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['request body must be a JSON object'];
  }
  const errors = [];
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    errors.push('model must be a non-empty string');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    errors.push('messages must be a non-empty array');
    return errors;
  }
  if (body.messages.length > MAX_CHAT_MESSAGES) {
    errors.push(`messages must have at most ${MAX_CHAT_MESSAGES} entries`);
  }
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      errors.push(`messages[${i}] must be an object`);
      continue;
    }
    if (!VALID_CHAT_ROLES.has(msg.role)) {
      errors.push(`messages[${i}].role must be one of ${[...VALID_CHAT_ROLES].join(', ')}`);
    }
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (msg.content === undefined || msg.content === null) {
      // assistant may omit content if it produced tool_calls; everything else needs content.
      if (!(msg.role === 'assistant' && hasToolCalls)) {
        errors.push(`messages[${i}].content is required`);
      }
    } else if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      errors.push(`messages[${i}].content must be a string or an array`);
    }
    if (msg.role === 'tool' && typeof msg.tool_call_id !== 'string') {
      errors.push(`messages[${i}].tool_call_id is required for tool messages`);
    }
  }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || Number.isNaN(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      errors.push('temperature must be a number between 0 and 2');
    }
  }
  for (const tokField of ['max_tokens', 'max_completion_tokens']) {
    if (body[tokField] !== undefined) {
      if (typeof body[tokField] !== 'number' || !Number.isInteger(body[tokField]) || body[tokField] < 1 || body[tokField] > MAX_CHAT_TOKENS) {
        errors.push(`${tokField} must be an integer between 1 and ${MAX_CHAT_TOKENS}`);
      }
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    errors.push('stream must be a boolean');
  }
  return errors;
}

// --- /v1/shorts payload validation ------------------------------------------
function validateShortsRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return ['request body must be a JSON object'];
  }
  const errors = [];
  const prompt = params.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    errors.push('prompt is required and must be a non-empty string');
  } else if (prompt.length > MAX_SHORTS_PROMPT) {
    errors.push(`prompt must be at most ${MAX_SHORTS_PROMPT} characters`);
  }
  if (params.format !== undefined) {
    if (typeof params.format !== 'string' || !VALID_SHORTS_FORMATS.has(params.format)) {
      errors.push(`format must be one of ${[...VALID_SHORTS_FORMATS].join(', ')}`);
    }
  }
  if (params.duration !== undefined) {
    if (typeof params.duration !== 'number' || !Number.isInteger(params.duration) || params.duration < MIN_SHORTS_DURATION || params.duration > MAX_SHORTS_DURATION) {
      errors.push(`duration must be an integer between ${MIN_SHORTS_DURATION} and ${MAX_SHORTS_DURATION}`);
    }
  }
  if (params.steps !== undefined) {
    if (typeof params.steps !== 'number' || !Number.isInteger(params.steps) || params.steps < MIN_SHORTS_STEPS || params.steps > MAX_SHORTS_STEPS) {
      errors.push(`steps must be an integer between ${MIN_SHORTS_STEPS} and ${MAX_SHORTS_STEPS}`);
    }
  }
  return errors;
}

// --- API key masking (dashboard display) ------------------------------------
// Never returns the original value. Short values are fully masked.
function maskKey(v) {
  if (!v) return '';
  if (v.length <= 8) return '***';
  if (v.length <= 16) return v.slice(0, 2) + '***' + v.slice(-2);
  return v.slice(0, 4) + '***' + v.slice(-4);
}

module.exports = {
  timingSafeKey,
  isAuthorized,
  readJsonBody,
  validateChatRequest,
  validateShortsRequest,
  maskKey,
};
// lib/providers.js
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const logger = require('./logger');

// Load .env if present — prefer cwd (user's project) then package dir
const ENV_CANDIDATES = [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '.env')];
for (const envPath of ENV_CANDIDATES) {
  try {
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    }
  } catch {}
}

// Config candidates: cwd first (user's project), then package dir
const CONFIG_CANDIDATES = [path.join(process.cwd(), 'config.json'), path.join(__dirname, '..', 'config.json')];
const CONFIG_PATH = CONFIG_CANDIDATES.find(p => fs.existsSync(p)) || CONFIG_CANDIDATES[1];

const PROVIDERS_CATALOG_PATH = path.join(__dirname, '..', 'providers.json');
const DEFAULT_CONFIG = { port: 4000, auth: '', rateLimit: { maxRequests: 100, windowMs: 60000 }, providers: {} };

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  // 1. Start from the catalog
  try {
    const catalog = JSON.parse(fs.readFileSync(PROVIDERS_CATALOG_PATH, 'utf8'));
    cfg.providers = { ...catalog };
  } catch { /* no catalog — empty providers */ }
  // 2. Overlay user config.json
  try {
    const userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (userCfg && typeof userCfg === 'object') {
      cfg.port = userCfg.port || cfg.port;
      cfg.auth = userCfg.auth || cfg.auth;
      if (userCfg.rateLimit) cfg.rateLimit = { ...cfg.rateLimit, ...userCfg.rateLimit };
      if (userCfg.providers) {
        for (const [k, v] of Object.entries(userCfg.providers)) {
          if (v.enabled === false) { delete cfg.providers[k]; continue; }
          cfg.providers[k] = { ...(cfg.providers[k] || {}), ...v, key: k };
        }
      }
    }
  } catch (err) {
    console.error(`config.json invalid, using catalog only: ${err.message}`);
  }
  // 3. Default catalog providers to enabled=true (they may lack the field)
  for (const [k, p] of Object.entries(cfg.providers)) {
    if (p.enabled === undefined) p.enabled = true;
  }
  return cfg;
}

// Keep-alive agents: reuse TCP+TLS connections across requests instead of
// paying a new handshake (30-200ms) per call. Sockets are reused within the
// free agent socket limit (256 default), old idle sockets are freed on response.
const keepAliveAgents = {
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 64 }),
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 64 }),
};

const config = loadConfig();
const PROVIDERS = config.providers;

// Add key to each provider from env
for (const [key, provider] of Object.entries(PROVIDERS)) {
  provider.key = key;
  // Honor explicit envVar from the catalog/config first
  const explicitVar = provider.envVar;
  const derivedVar = `PROVIDER_${key.toUpperCase().replace(/-/g, '_')}_APIKEY`;
  const prefix = key.split('-')[0].toUpperCase();
  // Map known prefixes to their real env vars
  const prefixMap = { OR: 'OPENROUTER', NIM: 'NIM', GROQ: 'GROQ', MISTRAL: 'MISTRAL', GEMINI: 'GEMINI', ZAI: 'ZAI', HF: 'HF' };
  const resolvedPrefix = prefixMap[prefix] || prefix;
  const envKey = process.env[explicitVar] || process.env[derivedVar] || process.env[`PROVIDER_${resolvedPrefix}_APIKEY`];
  if (envKey) provider.apiKey = envKey;
}

// Reload providers.json + config.json WITHOUT restarting the server.
// Mutates the existing PROVIDERS object in place (same reference that other
// modules hold), adding/updating live providers and removing disabled ones.
// The env-key resolution is re-run so providers enabled/disabled via config.json
// pick up their apiKey again. Returns a summary of what changed.
function reloadProviders() {
  const prevKeys = new Set(Object.keys(PROVIDERS));
  const cfg = loadConfig();
  const next = cfg.providers;

  // Remove providers that no longer exist or were disabled in config.
  for (const key of [...prevKeys]) {
    if (!next[key]) {
      delete PROVIDERS[key];
    }
  }
  // Add or update providers (preserving the same object reference).
  for (const [key, provider] of Object.entries(next)) {
    const isNew = !PROVIDERS[key];
    const merged = { ...(PROVIDERS[key] || {}), ...provider, key };
    // Re-resolve apiKey from env (a provider may have been re-enabled).
    const explicitVar = merged.envVar;
    const derivedVar = `PROVIDER_${key.toUpperCase().replace(/-/g, '_')}_APIKEY`;
    const prefix = key.split('-')[0].toUpperCase();
    const prefixMap = { OR: 'OPENROUTER', NIM: 'NIM', GROQ: 'GROQ', MISTRAL: 'MISTRAL', GEMINI: 'GEMINI', ZAI: 'ZAI', HF: 'HF' };
    const resolvedPrefix = prefixMap[prefix] || prefix;
    const envKey = process.env[explicitVar] || process.env[derivedVar] || process.env[`PROVIDER_${resolvedPrefix}_APIKEY`];
    if (envKey) merged.apiKey = envKey; else delete merged.apiKey;
    merged.key = key;
    PROVIDERS[key] = merged;
    if (isNew) logger.info('Hot-reload: added provider', { key });
  }

  const removedCount = prevKeys.size - Object.keys(PROVIDERS).size;
  logger.info('Hot-reload: providers updated', { total: Object.keys(PROVIDERS).length, removed: removedCount });
  return { total: Object.keys(PROVIDERS).length, removed: removedCount };
}

const MODEL_MAP = {
  'glm-4.7-flash': 'zai', 'glm-4.5': 'zai', 'glm-4.5-air': 'zai',
  'glm-4.7': 'zai', 'glm-5': 'zai', 'glm-5-turbo': 'zai',
  'deepseek-ai/deepseek-v4-flash-0731': 'nim-deepseek',
  'meta/llama-3.1-8b-instruct': 'nim-llama',
  'openai/gpt-oss-120b': 'groq-gpt', 'qwen/qwen3.6-27b': 'groq-qwen',
  'allam-2-7b': 'groq-allam', 'groq/compound': 'groq-compound',
  'gemini-3.6-flash': 'gemini-flash',
  'codestral-latest': 'mistral-codestral', 'mistral-small-latest': 'mistral-small',
  'mistral-medium-latest': 'mistral-small', 'mistral-large-latest': 'mistral-small',
  'tier-splus': 'or-dots-3', 'tier-s': 'mistral-codestral',
  'tier-a': 'mistral-small', 'tier-b': 'groq-qwen',
  'tier-xl': 'or-dots-3', 'tier-l': 'or-minimax-m3-free',
  'openrouter-hermes': 'openrouter-hermes',
  'openrouter-mistral': 'openrouter-mistral',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': 'nim-nemotron',
  'cohere/north-mini-code:free': 'openrouter-hermes',
  'z-ai/glm-5.2:free': 'openrouter-mistral',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'or-nemotron-550b',
  'nvidia/nemotron-3-super-120b-a12b:free': 'or-nemotron-120b',
  'openai/gpt-oss-20b:free': 'or-gpt-oss-20b',
  'stealth/ox-alpha': 'or-ox-alpha',
  'nvidia/nemotron-3.5-lightning:free': 'or-nemotron-35',
  'poolside/laguna-s-2.1:free': 'or-laguna-s',
  'gemini-3.6-flash:vision': 'gemini-vision',
  'meta/llama-3.2-11b-vision-instruct': 'nim-vision',
  'ollama/llama3.2': 'ollama',
  'llama3.2': 'ollama',
  'ollama/qwen2.5:0.5b': 'ollama',
  'qwen2.5:0.5b': 'ollama',
  'lmstudio/local-model': 'lmstudio',
  'dots-studio/dots-3-note-preview:free': 'or-dots-3',
  'liquid/lfm-2.5-2.6b:free': 'or-lfm',
  'poolside/laguna-xs-2.1:free': 'or-laguna-xs',
  'cerebras/gpt-oss-120b': 'cerebras-gpt',
  'cerebras-gpt': 'cerebras-gpt',
  'cerebras/gemma-4-31b': 'cerebras-gemma',
  'cerebras-gemma': 'cerebras-gemma',
  'deepseek-v4-flash': 'deepseek',
  'deepseek-chat': 'deepseek',
  'deepseek-v4-flash-vision-exp': 'deepseek-vision',
};

// Убирает поля, которые конкретный провайдер не принимает (иначе 400/422).
// Например cohere-совместимые API лишают `reasoning_effort` → 400. Поля,
// добавленные целенаправленно (tools/response_format), не трогаем — они не
// сюда. `provider.unsupportedFields` задаётся в каталоге providers.json.
function sanitizeBody(provider, body) {
  const unsupported = provider.unsupportedFields || [];
  if (unsupported.length === 0) return body;
  const out = { ...body };
  for (const f of unsupported) {
    if (Object.prototype.hasOwnProperty.call(out, f)) delete out[f];
  }
  return out;
}

function callProvider(provider, body, timeout = 30000, retries = 1, signal) {
  const isStreaming = body.stream === true;
  const cleanBody = sanitizeBody(provider, body);

  return new Promise((resolve, reject) => {
    let curReq = null;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try {
        // Destroying the in-flight request surfaces an 'error' event with the
        // AbortError; handleRetry sees aborted=true and rejects without retry.
        curReq && curReq.destroy(new DOMException('The operation was aborted', 'AbortError'));
      } catch {}
    };

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const attempt = (remaining) => {
      if (aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      const startTime = Date.now();
      const postData = JSON.stringify(cleanBody);
      const url = new URL(provider.endpoint);

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        timeout,
        agent: keepAliveAgents[url.protocol] || undefined,
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}),
          'Content-Length': Buffer.byteLength(postData),
          ...(isStreaming ? { 'Accept': 'text/event-stream' } : {}),
        },
      };

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(options, (res) => {
        curReq = req;
        const latency = Date.now() - startTime;

        if (res.statusCode !== 200) {
          let data = '';
          const dec = new StringDecoder('utf8');
          res.on('data', chunk => data += dec.write(chunk));
          res.on('end', () => {
            data += dec.end();
            let errorMsg;
            let providerSide = false;
            try {
              const errData = JSON.parse(data);
              errorMsg = errData.error?.message || errData.message || data.slice(0, 200);
              // OpenRouter 404s split into two very different cases:
              //   «does not exist» / «not found» → model truly gone → disable forever.
              //   «Provider returned error» (with metadata.provider_name) → the upstream
              //   (Nvidia, etc.) is temporarily failing/quota'd → must NOT permanently
              //   disable, it may recover after a health-check.
              if (/provider.?side|provider returned error/i.test(errorMsg) ||
                  errData.error?.metadata?.provider_name) {
                providerSide = true;
              }
            } catch {
              errorMsg = data.slice(0, 200);
            }
            const err = new Error(`${provider.key}: ${res.statusCode} — ${errorMsg}`);
            err.statusCode = res.statusCode;
            err.providerKey = provider.key;
            err.providerSide = providerSide;
            handleRetry(err, remaining);
          });
          return;
        }

        if (isStreaming) {
          cleanup();
          resolve({ stream: res, statusCode: 200, latency });
          return;
        }

        let data = '';
        const dec = new StringDecoder('utf8');
        res.on('data', chunk => data += dec.write(chunk));
        res.on('end', () => {
          data += dec.end();
          try {
            const parsed = JSON.parse(data);
            cleanup();
            resolve({ data: parsed, statusCode: 200, latency, usage: parsed.usage });
          } catch (err) {
            handleRetry(new Error(`${provider.key}: Invalid JSON from provider`), remaining);
          }
        });
      });

      curReq = req;

      req.on('timeout', () => {
        req.destroy();
        handleRetry(new Error(`${provider.key}: timeout`), remaining);
      });

      req.on('error', (err) => {
        // Abort error should surface as-is (name: 'AbortError') — no retry.
        if (aborted && err && err.name === 'AbortError') {
          cleanup();
          reject(err);
          return;
        }
        handleRetry(new Error(`${provider.key}: ${err.message}`), remaining);
      });

      req.write(postData);
      req.end();

      function handleRetry(err, remaining) {
        // Never retry rate limits (429) — it just burns quota faster.
        // Also skip 401/404 (auth/model errors won't fix themselves) and aborts.
        const status = err.statusCode || 0;
        const noRetry = aborted || status === 429 || status === 401 || status === 403 || status === 404;
        if (remaining > 0 && !isStreaming && !noRetry) {
          const delay = remaining === 2 ? 1000 : 2000;
          logger.warn('Retrying provider call', { key: provider.key, attempt: retries - remaining + 2, error: err.message });
          setTimeout(() => attempt(remaining - 1), delay);
        } else {
          cleanup();
          reject(aborted ? new DOMException('The operation was aborted', 'AbortError') : err);
        }
      }
    };

    const cleanup = () => signal && signal.removeEventListener('abort', onAbort);

    attempt(retries);
  });
}

module.exports = { PROVIDERS, MODEL_MAP, callProvider, reloadProviders, sanitizeBody };

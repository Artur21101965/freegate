// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LRUCache } = require('./lib/cache');
const { PROVIDERS, MODEL_MAP, callProvider, reloadProviders } = require('./lib/providers');
const { loadState, initHealth, isCircuitOpen, recordSuccess, recordFailure, recordRequest, recordTokens, getHealth, getStats, getReliability, recordRecent, recordRpm, getRecent, getRpm, recordSelection, getLastSelection, getBandit, recordBandit, warmBanditPriors, getContextStats, getHourly } = require('./lib/health');
const { checkRateLimit } = require('./lib/rateLimit');
const {
  isAuthorized,
  readJsonBody,
  validateChatRequest,
  validateShortsRequest,
  maskKey,
} = require('./lib/security');
const { handleDashboard } = require('./lib/dashboard');
const { acquire, stats: poolStats } = require('./lib/pool');
const { aggregateSavings } = require('./lib/economics');
const websearch = require('./lib/websearch');
const { stripThink, cleanDelta, cleanMessage, fixReasoningMessage, isTooShort, MIN_ANSWER_LEN } = require('./lib/clean');
const { classifyComplexity, maybeUpgradeTier, classifyVisionComplexity, needsWindowUpgrade } = require('./lib/routing');
const { bucket, pick: banditPick, isTransientLimit } = require('./lib/bandit');
const { StringDecoder } = require('string_decoder');
const logger = require('./lib/logger');
const { KEY_GROUPS, readKeys, saveKeys, validateKey, getStoredKey } = require('./lib/setup');
const { prepareMessages, estimateTokens, setMemory: compactorSetMemory } = require('./lib/compactor');
const { classify: classifyTask } = require('./lib/taskclassify');
const { injectMethodology, enabledByDefault: methodEnabledByDefault } = require('./lib/methodology');
const { create: createMemoryStore } = require('./lib/memory-store');
const { trimToolOutputs, DEFAULT_OPTS: TOOLTRIM_DEFAULTS } = require('./lib/tooltrim');

// Load persisted state
loadState();
const contextStats = getContextStats();

// Drop stale health entries for providers that no longer exist (e.g. auto-disabled)
const activeKeys = new Set(Object.keys(PROVIDERS));
const stale = Object.keys(getHealth()).filter(k => !activeKeys.has(k));
if (stale.length > 0) {
  for (const k of stale) {
    delete getHealth()[k];
  }
  logger.info('Cleaned stale health entries', { removed: stale });
}

// Warm bandit priors for enabled providers with no/low history so brand-new
// models (e.g. or-minimax-m3-free) are explored promptly instead of ignored.
const warmed = warmBanditPriors(
  Object.keys(PROVIDERS).filter(k => PROVIDERS[k].enabled !== false),
  ['low', 'med', 'high']
);
if (warmed > 0) logger.info('Warmed bandit priors', { warmed });

// Диск-кэш: повторы промптов не жгут free-лимиты. TTL 24ч (чаты/агенты часто
// переотправляют одинаковые запросы — ретраи, повторные вопросы; дневной кэш
// снимает лишнюю нагрузку). Семантический normalize ON (4-й арг).
const cache = new LRUCache(500, 24 * 3600 * 1000, false, true);
require('./lib/cache')._activeCache = cache;

// Load config (with fallback so a corrupt config never crashes the server)
// Prefer cwd config.json (user's project) over the package dir.
const CONFIG_CANDIDATES = [path.join(process.cwd(), 'config.json'), path.join(__dirname, 'config.json')];
const CONFIG_PATH = CONFIG_CANDIDATES.find(p => fs.existsSync(p)) || CONFIG_CANDIDATES[1];
let config = { port: 4000, auth: '', rateLimit: { maxRequests: 100, windowMs: 60000 }, methodology: true };
try {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (parsed && typeof parsed === 'object') config = { ...config, ...parsed };
} catch (err) {
  console.error(`Config corrupt, using defaults: ${err.message}`);
}

// CLI args (override config)
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const PORT = parseInt(process.env.PORT || getArg('port', config.port || '4000'));
const AUTH_KEY = process.env.AUTH || getArg('auth', config.auth || '');
const RATE_LIMIT = config.rateLimit || { maxRequests: 100, windowMs: 60000 };
// Генерация шортс — дорогая операция (внешний GPU): пекулярно строгий лимит.
const SHORTS_RATE_LIMIT = { maxRequests: 3, windowMs: 10 * 60 * 1000 };
// Админ-мутации (релоад, тоггл, сброс кэша, смена ключей) — пекулярно строгий лимит.
const ADMIN_RATE_LIMIT = { maxRequests: 20, windowMs: 60000 };
// Тело запроса chat: 2MB — больше нечего слать разумному чат-прокси.
const MAX_CHAT_BODY = 2 * 1024 * 1024;
// Малые JSON-эндпоинты (шортс, настройка ключей, конфиг): 100KB.
const MAX_SMALL_BODY = 100 * 1024;
const VERSION = (() => { try { return require('./package.json').version; } catch { return 'dev'; } })();

// --- Долговременная память (vector memory) ---
// По умолчанию включена: факты берутся побочно от компакции (без лишних вызовов
// LLM) и подмешиваются в контекст по релевантности. config.memory.enabled=false —
// слой отключается целиком.
const MEMORY_CONFIG = Object.assign(
  { enabled: true, topK: 3, minSimilarity: 0.05, coverageForSkip: 0.6 },
  (config.memory && typeof config.memory === 'object') ? config.memory : {}
);
const memStore = MEMORY_CONFIG.enabled ? createMemoryStore({ filePath: path.join(__dirname, 'memory.json') }) : null;
if (memStore) compactorSetMemory(memStore);

// --- Семантический кэш ---
// На промахе точного ключа ищет закэшированный диалог с похожим нормализованным
// текстом (Dice по символьным триграммам). config.semcache.enabled=false отключает.
const SEMCACHE_CONFIG = Object.assign(
  { enabled: true, minSimilarity: 0.85 },
  (config.semcache && typeof config.semcache === 'object') ? config.semcache : {}
);

// --- Методолог (инженерная дисциплина в промпте) ---
// config.methodology.enabled=false отключает. По умолчанию включён.
// config.methodology.prompts.{category} переопределяет текст промпта для
// конкретной категории (незаданные категории остаются в дефолтах).
const METHODOLOGY_CONFIG = Object.assign(
  { enabled: methodEnabledByDefault(), prompts: {} },
  (config.methodology && typeof config.methodology === 'object') ? config.methodology : {}
);

// --- Самопроверка ответа второй моделью (vetting) ---
// Опционально: после не-stream ответа отправляем краткий чек другой модели.
// Выключено по умолчанию (жжёт 2-й free-лимит). Включается config.vetting.enabled.
const { shouldVet, vetAnswer, VETTING_DEFAULTS } = require('./lib/vetting');
const VETTING_CONFIG = Object.assign(
  { ...VETTING_DEFAULTS },
  (config.vetting && typeof config.vetting === 'object') ? config.vetting : {}
);

// Обрезка гигантских tool-выводов (всегда on по умолчанию). config.tooltrim.enabled=false отключает.
const TOOLTRIM_CONFIG = Object.assign(
  { ...TOOLTRIM_DEFAULTS },
  (config.tooltrim && typeof config.tooltrim === 'object') ? config.tooltrim : {}
);

// --- Стратегия роутинга ---
// Опциональные модификаторы равномерности (round-robin / least-used).
// По умолчанию 'weighted' — поведение без изменений.
const { makeWeightModifier } = require('./lib/strategy');
const ROUTING_STRATEGY = (config.routing && config.routing.strategy) || 'weighted';
// Предпочтение free↔paid. Пользователь задаёт свои платные ключи (.env) и
// выбирает, как их использовать рядом с бесплатной базой:
//   free-first   — free в приоритете, paid только как запас (default).
//   paid-first   — свои paid в приоритете, free как запас.
//   paid-fallback— free по умолчанию, paid трогаем только если free упали.
const ROUTING_PREFERENCE = (config.routing && config.routing.preference) || 'free-first';

// --- Сжатие промпта (Caveman-стиль) ---
// Опционально убирает вежливость/заполнители из последнего user-сообщения,
// экономя токены. config.compress.enabled=true включает.
const { compressMessages } = require('./lib/compress');
const COMPRESS_CONFIG = Object.assign(
  { enabled: false, minLen: 60 },
  (config.compress && typeof config.compress === 'object') ? config.compress : {}
);

// --- Веб-поиск для search-задач ---
// Бесплатный поиск фактов (DuckDuckGo, без ключа) для запросов-поиска, чтобы
// модель не галлюцинировала («что такое минимакс дизайн» → реальная инфа про
// MiniMax, а не «минимализм»). Только для search-задач. Сбои не ломают запрос.
const WEBSEARCH_CONFIG = Object.assign(
  { enabled: true, limit: 5, timeout: 8000, queryMinChars: 6 },
  (config.websearch && typeof config.websearch === 'object') ? config.websearch : {}
);

// --- Самообновляющаяся база моделей (Model Discovery Engine) ---
// Планировщик живёт внутри сервера: работает «всегда» у всех пользователей
// пакета без cron/launchd. config.modelManager.enabled=false отключает.
function _loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {}
}
_loadEnvFile();
const { ModelManager } = require('./lib/modelmanager');
const MODEL_MANAGER_CONFIG = Object.assign(
  {},
  (config.modelManager && typeof config.modelManager === 'object') ? config.modelManager : {}
);
const autoUpdate = require('./lib/autoupdate');
const AUTO_UPDATE = (config.autoUpdate && typeof config.autoUpdate === 'object') ? config.autoUpdate : {};
const diagMonitor = require('./lib/diagmonitor');
const DIAG_MONITOR = (config.diagMonitor && typeof config.diagMonitor === 'object') ? config.diagMonitor : { enabled: true, intervalMs: 30 * 60 * 1000 };
// Прокси-компакция по умолчанию ВЫКЛЮЧЕНА: её делает клиент (opencode/BigPickle),
// который знает структуру диалога. Прокси не переписывает контент — иначе агент
// теряет рабочий контекст и «не продолжает». Включить: {"compacter":{"enabled":true}}.
const COMPACTER_ENABLED = !!(config.compacter && config.compacter.enabled);
const modelManager = new ModelManager({
  dbPath: path.join(__dirname, 'models-db.json'),
  catalogPath: path.join(__dirname, 'providers.json'),
  configPath: path.join(__dirname, 'config.json'),
  keys: {
    openrouter: process.env.PROVIDER_OPENROUTER_APIKEY || '',
    huggingface: process.env.HF_TOKEN || process.env.PROVIDER_HF_APIKEY || '',
    groq: process.env.PROVIDER_GROQ_APIKEY || '',
    mistral: process.env.PROVIDER_MISTRAL_APIKEY || '',
    gemini: process.env.PROVIDER_GEMINI_APIKEY || '',
    cerebras: process.env.PROVIDER_CEREBRAS_APIKEY || '',
    deepseek: process.env.PROVIDER_DEEPSEEK_APIKEY || '',
    nim: process.env.PROVIDER_NIM_APIKEY || '',
  },
  fetchImpl: (url, opts) => fetch(url, opts),
  config: MODEL_MANAGER_CONFIG,
  reload: () => { try { reloadProviders(); } catch {} },
  log: (msg) => logger.info('[modelManager] ' + msg),
});

// Health check
const healthIntervals = {}; // key -> { nextCheck, backoff }

async function checkProvider(key, provider) {
  initHealth(key);
  const start = Date.now();
  // CRITICAL: always use cheap /models GET for health checks. Sending real LLM
  // requests just to "check health" burns provider daily request limits (Groq
  // limits by requests/day, not tokens). 18 providers × every 5 min = 288
  // wasted requests/day. Real latency comes from actual user requests instead.
  try {
    const url = provider.endpoint.replace('/chat/completions', '/models');
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...(provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - start;
    if (res.ok) {
      recordSuccess(key);
      getHealth()[key].status = 'up';
      // Do NOT record /models latency as generation speed (it's 30-100ms, not
      // representative). Keep existing real latency from actual requests.
      getHealth()[key].lastCheck = Date.now();
      healthIntervals[key] = { nextCheck: Date.now() + 300000, backoff: 60000 };
      return true;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const latency = Date.now() - start;
    const is429 = String(err.message).includes('429');
    // 429 = temporary rate limit (provider is alive, just limited). Don't mark it
    // as dead — it will recover when the limit resets. Keep it visible to clients.
    getHealth()[key].status = is429 ? 'ratelimited' : 'error';
    getHealth()[key].latency = latency;
    getHealth()[key].reason = is429 ? 'лимит провайдера (429)' : 'не отвечает';
    getHealth()[key].score = Math.max(0, (getHealth()[key].score ?? 50) - (is429 ? 2 : 5));
    recordFailure(key);
    // 404 means the model/function isn't available for this account — auto-disable
    // so we stop probing it forever. Re-enable by setting enabled:true in config.
    if (String(err.message).includes('404')) {
      provider.enabled = false;
      getHealth()[key].status = 'disabled';
      getHealth()[key].reason = 'отключён автоматически (404)';
      logger.warn('Provider auto-disabled (404)', { key, model: provider.model });
    } else {
      // Re-check soon after a transient failure so the provider recovers quickly.
      // Growing backoff (up to 10 min) would leave it 'dead' too long for users.
      healthIntervals[key] = { nextCheck: Date.now() + 60000, backoff: 60000 };
    }
    return false;
  }
}

const PROBE_CAP = 8;

async function healthCheck() {
  const now = Date.now();
  // Параллельный пробинг с лимитом: пакетами по PROBE_CAP, чтобы не создавать
  // десятки одновременных fetch-запросов при 30+ провайдерах.
  const due = Object.entries(PROVIDERS)
    .filter(([key, provider]) => provider.enabled && !(healthIntervals[key] && healthIntervals[key].nextCheck > now));
  for (let i = 0; i < due.length; i += PROBE_CAP) {
    const batch = due.slice(i, i + PROBE_CAP);
    await Promise.allSettled(batch.map(([key, provider]) => checkProvider(key, provider)));
  }
}
setInterval(healthCheck, 30000);
setTimeout(healthCheck, 1000);

// Периодический сейв долговременной памяти (вдобавок к shutdown).
if (memStore) setInterval(() => memStore.save(), 60000);

// Извлекает usage из SSE-чанка (если провайдер шлёт его в последнем чанке).
function collectReasonUsage(str, usageObj) {
  if (!str || !/data: /.test(str)) return;
  for (const line of str.split('\n')) {
    const m = line.match(/^data: (.+)$/);
    if (!m || m[1].trim() === '[DONE]') continue;
    try {
      const obj = JSON.parse(m[1]);
      if (obj.usage && (obj.usage.prompt_tokens || obj.usage.completion_tokens)) {
        usageObj.prompt_tokens = obj.usage.prompt_tokens;
        usageObj.completion_tokens = obj.usage.completion_tokens;
        usageObj.total_tokens = obj.usage.total_tokens;
      }
    } catch {}
  }
}

// Извлекает все значения content из SSE-чанка. Возвращает true, если есть
// хотя бы одно непустое (реальный токен, а не пустая дельта).
function chunkHasToken(str) {
  const re = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[1].trim().length > 0) return true;
  }
  return false;
}

// Последний user-текст — для оценки, насколько короткий ответ легитимен.
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const t = m.content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ');
        if (t) return t;
      }
    }
  }
  return '';
}

// Chat completion handler
async function handleChatCompletion(req, res, body) {
  const requestedModel = body.model || 'tier-splus';
  // Умный роутинг: сложные задачи с лёгкого тира поднимаем на более мощный.
  // Классифицируем ПОСЛЕ того, как определён requestedModel, ДО выбора провайдера.
  const complexity = classifyComplexity(body.messages);
  let complexityBucket = bucket(complexity);
  let effectiveModel = maybeUpgradeTier(requestedModel, complexity);
  let targetProviderKey = MODEL_MAP[effectiveModel] || MODEL_MAP[requestedModel] || 'zai';
  const isStreaming = body.stream === true;
  // --- Контекстная телеметрия: один measure на запрос, record только в терминальной точке. ---
  const measure = { ts: Date.now(), provider: targetProviderKey, cacheType: 'miss', status: 0, win: PROVIDERS[targetProviderKey]?.context_window || 0, upgraded: 0 };
  const commit = (status) => {
    measure.status = status;
    contextStats.record(measure);
  };

  // Vision detection: if the request contains images, route to a vision provider.
  // TWO-STAGE pipeline:
  //   Stage 1: vision model reads the screenshot, extracts text/description.
  //   Stage 2: the requested (coding/general) model answers using the extracted
  //            text as context — so a coding model handles the fix, not vision.
  const hasImage = Array.isArray(body.messages) && body.messages.some((m) => {
    if (Array.isArray(m.content)) {
      return m.content.some((c) => c && (c.type === 'image_url' || c.type === 'image' || c.type === 'file' || c.type === 'input_image'));
    }
    return false;
  });
  // Log any message that LOOKS like it carries an image (any field), so we can
  // adapt detection to opencode's actual format.
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      const suspicious = m && (
        m.attachments || m.image || m.file ||
        (Array.isArray(m.content) && m.content.some(c => c && (c.image || c.image_url || c.file || c.data || c.type === 'file')))
      );
      if (suspicious) {
        logger.info('Vision format detected', {
          keys: Object.keys(m || {}),
          contentTypes: Array.isArray(m.content) ? m.content.map(c => c && (c.type || 'plain')) : null,
          contentKeys: Array.isArray(m.content) ? m.content.map(c => c && Object.keys(c).slice(0,5)) : null,
        });
        break;
      }
    }
  }
  if (hasImage) {
    // Two-stage pipeline: try vision providers in order until one extracts text.
    const visionChain = ['gemini-vision', 'nim-vision', 'deepseek-vision']
      .map((k) => PROVIDERS[k])
      .filter((p) => p && p.enabled);
    if (visionChain.length > 0) {
      logger.info('Vision pipeline: распознаю скриншот', { chain: visionChain.map(p => p.key).join(',') });
      let extracted = '';
      // PARALLEL vision attempt: fire all vision providers at once and take the
      // first one that extracts text. Previously each was tried IN SEQUENCE,
      // so a slow/failed first provider meant the pipeline waited provider
      // after provider — the "two chats think forever" pattern for screenshots.
      // Winner keeps its request; losers are aborted below (cheap cancellation,
      // no wasted GPU calls), and their AbortErrors are never treated as failures.
      const visionController = new AbortController();
      const visionAttempts = visionChain.map((visionProvider) => (async () => {
        const visionBody = {
          model: visionProvider.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Распознай и извлеки ВЕСЬ текст с изображения (ошибка, код, сообщение). Верни только содержимое, без комментариев. Если это код — верни код как есть.' },
              ...(Array.isArray(body.messages) ? body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c && (c.type === 'image_url' || c.type === 'image' || c.type === 'input_image')).map((c) => {
                // Normalize any image part to the universal image_url format
                const url = c.image_url?.url || c.image?.url || c.image?.data || (c.image && typeof c.image === 'string' ? c.image : null) || c.url;
                return url ? { type: 'image_url', image_url: { url } } : null;
              }).filter(Boolean) : [])) : []),
            ],
          }],
          max_tokens: 2000,
        };
        const visionRes = await callProvider(visionProvider, visionBody, 30000, 1, visionController.signal);
        const text = visionRes.data?.choices?.[0]?.message?.content || visionRes.data?.choices?.[0]?.message?.reasoning || '';
        if (text) {
          logger.info('Vision pipeline: распознал ' + visionProvider.key);
          return text;
        }
        throw new Error(visionProvider.key + ': пустой OCR');
      })());
      // First provider to yield text wins; hard failures (429/5xx) are skipped
      // without blocking the others. If ALL fail, extracted stays '' and the
      // request proceeds without vision context (as before).
      try {
        extracted = await Promise.any(visionAttempts);
      } catch {
        logger.warn('Vision pipeline: все вижн-провайдеры не сработали', { tried: visionChain.map(p => p.key) });
      } finally {
        // Отменить проигравшие vision-запросы: их результат больше не нужен.
        logger.debug('Vision pipeline: отменяю проигравших', { tried: visionChain.length });
        visionController.abort();
      }
      const cleaned = stripThink(extracted, true);
      logger.info('Vision pipeline: скриншот распознан', { chars: cleaned.length });
      if (cleaned) {
        // Умный vision-роутинг: скриншот с кодом/ошибкой поднимает тир.
        const vc = classifyVisionComplexity(cleaned);
        if (vc > 0) effectiveModel = maybeUpgradeTier(effectiveModel, vc);
        // Vision-текст может изменить сложность — пересчитываем бакет.
        complexityBucket = bucket(classifyVisionComplexity(cleaned));
        // Пересчитываем target-провайдера — vision-апгрейд мог сменить тир.
        targetProviderKey = MODEL_MAP[effectiveModel] || MODEL_MAP[requestedModel] || 'zai';
        // Replace image content with the extracted text as context,
        // so the coding/general model (not vision) answers the question.
        const userMsgs = Array.isArray(body.messages) ? body.messages : [];
        body = {
          ...body,
          messages: userMsgs.map((m) => {
            if (Array.isArray(m.content) && m.content.some((c) => c && (c.type === 'image_url' || c.type === 'image' || c.type === 'input_image'))) {
              const textPart = m.content.find((c) => c && c.type === 'text')?.text || '';
              return { role: 'user', content: `${textPart}\n\n[Содержимое скриншота]\n${cleaned}` };
            }
            return m;
          }),
        };
      }
    }
  }

  // Telemetry: measure original tokens BEFORE trimming/compaction.
  if (Array.isArray(body.messages)) measure.origTokens = estimateTokens(body.messages);

  // --- Tool output trimming ---
  // Огромные tool-выводы (логи/стеки) раздувают контекст → free-модели деградируют
  // и перестают вызывать tools. Обрезаем старые tool-выводы до stubов (head+tail),
  // последние keepRecent оставляем почти целыми (модель работает с ними сейчас).
  // Не компакция (не суммаризация, не удаление сообщений) — целевая обрезка гигантских
  // выводов, которые opencode не обрезает. Кэш считается от обрезанных (стабильно).
  if (TOOLTRIM_CONFIG.enabled && Array.isArray(body.messages)) {
    const { messages: trimmed, trimmedCount, charsSaved } = trimToolOutputs(body.messages, TOOLTRIM_CONFIG);
    if (trimmedCount > 0) {
      body.messages = trimmed;
      measure.toolTrim = { msgs: trimmedCount, chars: charsSaved };
      logger.info('ToolTrim', { msgs: trimmedCount, chars: charsSaved, est: estimateTokens(trimmed) });
    }
  }

  // Window-aware upgrade: если запрос не влезает в окно целевой модели (после
  // vision-апгрейда + trim), компакция НЕ запускается — суммаризатор не должен
  // сжимать контекст, который провайдер с большим окном возьмёт целиком.
  // Считается от обрезанных сообщений (реальный размер, который уйдёт провайдеру).
  const windowUpgraded = Array.isArray(body.messages) && body.messages.length > 0 &&
    needsWindowUpgrade(PROVIDERS[targetProviderKey]?.context_window || 0, estimateTokens(body.messages));

  // Compact overly large conversations so free models don't reject on context.
  // Runs AFTER the vision pipeline + trim (images already converted, giant tool outputs stubbed).
  // Skipped in window-upgrade mode — the big provider takes the raw context.
  // Прокси-компакция ОПЦИОНАЛЬНА (config.compacter.enabled, по умолчанию false).
  // Компактит сам клиент (opencode auto-compaction / BigPickle) — он знает
  // смысловую структуру диалога и сохраняет «что осталось сделать». Прокси лишь
  // роутит и не должен переписывать контент — иначе агент теряет нить.
  // Окно-роутинг (ниже) остаётся всегда: выбирает провайдера под размер запроса.
  if (COMPACTER_ENABLED && !windowUpgraded) {
    body.messages = await prepareMessages(body.messages, { contextWindow: PROVIDERS[targetProviderKey]?.context_window || 0 });
  }
  // Контекстная телеметрия: токены после компакции + доля системного промпта.
  if (Array.isArray(body.messages)) {
    measure.sentTokens = estimateTokens(body.messages);
    measure.est = measure.sentTokens;
    measure.compacted = measure.sentTokens < measure.origTokens;
    const sysChars = body.messages.filter(m => m && m.role === 'system').reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const allChars = body.messages.reduce((a, m) => a + (typeof (m && m.content) === 'string' ? m.content.length : 0), 0);
    if (allChars > 0) measure.sysShare = sysChars / allChars;
  }

  // --- Long-term memory recall ---
  // Подмешиваем релевантные факты из прошлых сессий (векторная память) как
  // user-сообщение В НАЧАЛЕ диалога — после системных правил, до кэша. Так
  // ключ кэша (normalize игнорирует system, но учитывает user) различает разные
  // наборы фактов, и ответы не отравляются чужим кэшем.
  if (memStore) {
    try {
      const userTexts = [];
      const userMsgs = body.messages.filter(m => m && m.role === 'user');
      for (const m of userMsgs.slice(-3)) {
        if (typeof m.content === 'string') userTexts.push(m.content);
        else if (Array.isArray(m.content)) userTexts.push(m.content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' '));
      }
      const query = userTexts.join('\n').trim();
      if (query.length > 20) {
        const hits = memStore.recall(query, { topK: MEMORY_CONFIG.topK, minSimilarity: MEMORY_CONFIG.minSimilarity });
        if (hits.length > 0) {
          // Не подмешиваем факт, который уже покрыт резюме компактора или
          // недавними сообщениями этой же сессии (защита от дублей).
          const existing = body.messages
            .filter(m => m && typeof m.content === 'string')
            .map(m => m.content)
            .concat(userTexts);
          const fresh = hits.filter(f => !memStore.isCovered(f.text, existing));
          if (fresh.length > 0) {
            let memoryMsg = fresh.map(f => f.text).join('\n');
            if (memoryMsg) {
              const insertAt = body.messages.findIndex(m => m && m.role !== 'system');
              const block = { role: 'user', content: '[Память: релевантные факты из прошлого]\n' + memoryMsg };
              if (insertAt === -1) body.messages.unshift(block);
              else body.messages.splice(insertAt, 0, block);
              measure.memory = true;
              logger.info('Memory recall', { facts: fresh.length, covered: hits.length - fresh.length });
            }
          }
        }
      }
    } catch (err) {
      logger.error('Memory recall error', { message: err.message });
    }
  }

  // --- Методолог (инженерная дисциплина) ---
  // Классифицируем задачу (coding/reasoning/search/chat) и вставляем короткий
  // системный промпт-методолог после памяти, до кэша. System-сообщение
  // игнорируется normalize, поэтому кэш-ключ не меняется. Методолог влияет
  // только на реальные запросы к провайдеру (кэш-хиты его не видят).
  let taskCategory = 'chat';
  if (METHODOLOGY_CONFIG.enabled && Array.isArray(body.messages)) {
    try {
      taskCategory = classifyTask(body.messages);
      // Сжатие промпта: убираем вежливость/заполнители ДО методолога (методолог
      // не должен суммировать сжатый текст). Опционально (config.compress).
      if (COMPRESS_CONFIG.enabled) {
        const compressed = compressMessages(body.messages, COMPRESS_CONFIG);
        if (compressed !== body.messages && Array.isArray(compressed)) {
          body.messages = compressed;
          measure.compressed = 1;
        }
      }
      const injected = injectMethodology(body.messages, taskCategory, METHODOLOGY_CONFIG);
      if (injected !== body.messages) {
        body.messages = injected;
        measure.taskCategory = taskCategory;
      }
    } catch (err) {
      logger.error('Methodology error', { message: err.message });
    }
  }

  // --- Веб-поиск для search-задач ---
  // Нашли факты из интернета (DuckDuckGo, без ключа) и подмешали как контекст,
  // чтобы модель отвечала по существу, а не галлюцинировала. Только search.
  // Любой сбой (нет сети/таймаут/пусто) = просто пропускаем, запрос идёт как есть.
  let searchContext = '';
  if (WEBSEARCH_CONFIG.enabled && (taskCategory === 'search' || taskCategory === 'chat')) {
    try {
      const userTexts = (body.messages || [])
        .filter(m => m && m.role === 'user' && typeof m.content === 'string')
        .map(m => m.content.trim());
      const query = userTexts[userTexts.length - 1] || '';
      if (query.length >= WEBSEARCH_CONFIG.queryMinChars) {
        const results = await websearch.search(query, {
          fetchImpl: (url, opts) => fetch(url, opts),
          limit: WEBSEARCH_CONFIG.limit,
          timeout: WEBSEARCH_CONFIG.timeout,
        });
        if (results.length > 0) {
          searchContext = websearch.toContext(results, query);
          measure.websearch = true;
          body.messages.push({ role: 'system', content: searchContext });
          logger.info('Websearch', { query: query.slice(0, 80), results: results.length });
        }
      }
    } catch (err) {
      logger.error('Websearch error', { message: err.message });
    }
  }

  // Replays a previously cached completion (exact or semantic hit), preserving
  // the stream/non-stream shape the client asked for.
  function serveCached(res, cached, isStreaming) {
    if (isStreaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const content = cached.choices?.[0]?.message?.content || '';
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-cached', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: cached.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-cached', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: cached.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-cached', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: cached.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
    }
  }

  // Tool-запросы (агент вызывает инструмент) НЕ кэшируем: ответ зависит от tool_calls,
  // а кэш по messages может отдать текстовый ответ вместо инструмента — агент
  // «останавливается», не получив tool. Идём всегда к провайдеру.
  const hasTools = !!(body.tools || body.tool_choice);
  const cached = hasTools ? null : cache.get(effectiveModel, body.messages, body.temperature, body.tools || body.tool_choice);
  if (cached) {
    logger.request({ model: requestedModel, provider: 'cache', status: 200, cached: true });
    recordRecent({ model: requestedModel, provider: 'cache', status: 200, latency: 0, cached: true });
    measure.cacheType = 'exact';
    commit(200);
    serveCached(res, cached, isStreaming);
    return;
  }

  // Semantic cache: same intent, rephrased wording → replay without a new LLM call.
  if (SEMCACHE_CONFIG.enabled && !hasTools) {
    const semantic = cache.getSemantic(effectiveModel, body.messages, body.temperature, SEMCACHE_CONFIG.minSimilarity);
    if (semantic) {
      logger.request({ model: requestedModel, provider: 'semcache', status: 200, cached: true });
      recordRecent({ model: requestedModel, provider: 'semcache', status: 200, latency: 0, cached: true });
      measure.cacheType = 'semcache';
      commit(200);
      serveCached(res, semantic.value, isStreaming);
      return;
    }
  }

  // Запрос реально идёт к провайдеру (кэш промахнулся) — только теперь помечаем
  // апгрейд: кэш-хит апгрейдом не считается (апстрим-вызова не было).
  if (windowUpgraded) measure.upgraded = 1;

  // Weighted selection among healthy providers
  const today = new Date().toISOString().slice(0, 10);
  // 'ratelimited' providers are alive but temporarily limited — include them
  // (weighted down) so the pool never looks empty when many limits are hot.
  // Vision providers are ONLY used for image requests (two-stage pipeline),
  // never for plain text — otherwise they dominate the weighted selection.
  const healthyProviders = Object.entries(PROVIDERS)
    .filter(([_, p]) => p.enabled && !isCircuitOpen(p.key) && p.vision !== true &&
      (getHealth()[p.key]?.status === 'up' || getHealth()[p.key]?.status === 'ratelimited'));

  // Анти-«замирание»: провайдер, накопивший много ошибок сегодня (status остаётся
  // 'up' — это не 429/401, а флап/долгие таймауты), по-прежнему попадает в цепочку
  // и тормозит ответ. Исключаем его из активного пула до конца дня. Если так пул
  // пустеет (все «ошибочные») — вернём их как крайний резерв, чтобы не отдать 503.
  const todayErrors = getStats().errors || {};
  const ERROR_POOL_THRESHOLD = 15;
  const lowErrorProviders = healthyProviders.filter(
    ([k]) => (todayErrors[k] || 0) < ERROR_POOL_THRESHOLD
  );
  const healthy2 = lowErrorProviders.length > 0 ? lowErrorProviders : healthyProviders;

  // Window-aware routing: estimate the request size and only consider providers
  // whose context window can actually hold it. This stops large requests from
  // burning time falling through lfm (65k) / groq (131k) providers that reject
  // them — they go straight to nemotron-35/dots-3/minimax (1M/512k windows).
  // Only applies when the request is big enough to matter, so small/typical
  // requests keep the full fast pool.
  const requestTokens = estimateTokens(body.messages);
  const MIN_WINDOW = 50000; // below this we don't filter (typical requests)
  // Запас 2.0×: estimateTokens на диалогах с инструментами/кодом ЗАНИЖАЕТ реальный
  // размер (~в 2-3 раза). Запас отсекает малые окна (groq 131k, or-lfm 65k) от больших
  // запросов, но не убивает пул (большие окна: dots-3 512k, minimax 1M остаются).
  const WINDOW_SAFETY = 2.0;
  let windowPool = healthy2;
  let upgradeNoCapable = false; // апгрейд, но ни один здоровый провайдер не держит запрос
  if (requestTokens > MIN_WINDOW || windowUpgraded) {
    const capable = healthy2.filter(([_, p]) => {
      const win = p.context_window || 0;
      // Unknown/0 window providers are kept (heuristic) — better to try than drop.
      return win === 0 || win >= requestTokens * WINDOW_SAFETY;
    });
    if (capable.length > 0) {
      windowPool = capable;
    } else if (windowUpgraded) {
      // Best-effort: запрос больше окна любого провайдера (minimax 1M не держит).
      // Всё равно переполним — выберем самое большое окно ниже, минимизируя
      // потери контекста; target исключён; OVERFLOW поймает телеметрия.
      upgradeNoCapable = true;
    }
  }

  // Prefer providers below 90% of their daily limit; only fall back to
  // near-exhausted ones if that leaves nothing (avoids avoidable 429s).
  // Крутящийся пул по дневным лимитам: провайдер, исчерпавший дневной лимит,
  // исключается из выбора и не возвращается до сброса. Это лечит 429-спираль
  // (модель с лимитом 50/день сгорает к обеду, дальше каждая попытка на ней —
  // бесполезный 429). Остаёмся на живых; выгоревшие — только как крайний резерв.
  const usedTodayFor = (key) => (getStats().dailyUsage?.[key]?.[today]) || 0;
  const pool = (() => {
    // Провайдеры, у которых дневной лимит ещё не исчерпан (strict < limit).
    const exemptables = windowPool.filter(([_, p]) => {
      const limit = p.dailyLimit || 0;
      if (limit <= 0) return true; // нет лимита — считаем «бесконечным»
      return usedTodayFor(p.key) < limit;
    });
    // Есть живые → только они. Все выгорели → вернуть весь пул (best-effort,
    // bandit-штраф ниже сделает их маловероятными, но не невозможными).
    return exemptables.length > 0 ? exemptables : windowPool;
  })();

  let selected = [];
  if (pool.length > 0) {
    if (upgradeNoCapable) {
      // Bandit здесь бессилен: все провайдеры в пуле переполнят окно (запрос
      // больше самого большого). Берём самое большое окно — наименьшие потери.
      selected = pool
        .map(([k, p]) => ({ key: k, provider: p }))
        .sort((a, b) => (b.provider.context_window || 0) - (a.provider.context_window || 0))
        .slice(0, 1);
    } else {
      const usedTodayList = {};
      for (const [k] of pool) usedTodayList[k] = usedTodayFor(k);
      const strategyModifier = makeWeightModifier(ROUTING_STRATEGY, { keys: pool.map(([k]) => k), usedTodayList });
      const scored = pool.map(([key, provider]) => {
        const h = getHealth()[key];
        let score = h.score || 50;
        const rawLat = h.latency || 0;
        const lat = rawLat > 0 ? Math.max(rawLat, 100) : 500;
        let weight = score / lat;
        if (h.status === 'ratelimited') weight *= 0.05;
        if (key === targetProviderKey) weight *= 1.15;
        // Методолог: категория задачи задаёт буст моделям подходящей категории,
        // не исключая fallback. coding→coding, reasoning→reasoning, chat/search→general.
        const cat = provider.category || 'general';
        if (taskCategory === 'coding' && cat === 'coding') weight *= 1.5;
        else if (taskCategory === 'design' && cat === 'coding') weight *= 1.6;
        else if (taskCategory === 'reasoning' && cat === 'reasoning') weight *= 1.5;
        else if ((taskCategory === 'chat' || taskCategory === 'search') && cat === 'general') weight *= 1.2;
        // Дизайн — это UI-код: визуальные рекомендации идут от coding-моделей.
        else if (taskCategory === 'design' && cat === 'reasoning') weight *= 0.4;
        // Простой факт/поиск не должен «думать вслух» на reasoning-модели:
        // это дорого по лимитам и даёт размышления вместо краткого ответа.
        if ((taskCategory === 'chat' || taskCategory === 'search') && cat === 'reasoning') weight *= 0.15;
        else if ((taskCategory === 'chat' || taskCategory === 'search') && cat === 'vision') weight *= 0.3;
        // Поиск фактов — не кодинг-задача: codestral (coding) на вопросе
        // «что такое минимакс дизайн» выдаёт рассуждение про «минимализм».
        // Отдаём search на general-модели (minimax/small), а не на кодеров.
        if (taskCategory === 'search' && cat === 'coding') weight *= 0.3;
        const dailyLimit = provider.dailyLimit || 0;
        // Провайдер, исчерпавший дневной лимит (попал в пул лишь как крайний
        // резерв, когда живы все выгорели), — сильно штрафуем, чтобы выбрать
        // его только в безвыходной ситуации, а не в первой же попытке.
        const usedToday = usedTodayFor(key);
        if (dailyLimit > 0 && usedToday >= dailyLimit) weight *= 0.03;
        else if (dailyLimit > 0 && usedToday >= dailyLimit * 0.9) weight *= 0.4;
        // Предпочтение free↔paid (config.routing.preference). Провайдер «платный»,
        // если только у него есть ключ и он не помечен как free — free-first
        // оставляет как есть (weight 1), paid-first бустит paid, paid-fallback
        // дебустит paid, пока живы свободные (иначе он как раз нужен).
        const isPaid = provider.paid === true || provider.free === false;
        if (isPaid && ROUTING_PREFERENCE === 'paid-first') weight *= 2.5;
        else if (isPaid && ROUTING_PREFERENCE === 'paid-fallback') {
          const freeUp = pool && pool.length > 0;
          weight *= freeUp ? 0.1 : 1.0;
        }
        // Стратегия роутинга: равномерность (round-robin / least-used) как
        // лёгкий модификатор к базовому weight — не ломает основной скоринг.
        weight *= strategyModifier(key);
        return { key, provider, weight };
      });

      // Bandit weight contract: bandit's pick() multiplies the Beta sample by
      // `weight`, so safety-штрафы (ratelimited ×0.05, target ×1.15) действуют и
      // при холодном старте. score/latency держит вес ~0.01-1.0; приоры bandit'а
      // (a,b ~1+) со временем начинают доминировать. Не добавляй нормализацию
      // здесь, пока измеренные веса не превысят ~5.
      // Thompson sampling: рисуем сэмпл Beta(a+1, b+1) для каждого, умножаем на
      // weight, выбираем максимум. Приоры из бакета сложности (bandit обучается).
      const priors = getBandit()[complexityBucket] || {};
      const bestKey = banditPick(scored, priors);
      const bestProvider = scored.find((p) => p.key === bestKey);
      if (bestProvider) selected = [bestProvider];
      else if (scored.length > 0) selected = [scored[0]];
    }
  }

  // Weighted-random picked ONE provider as the primary; append the rest of the
  // healthy pool (by weight) as fallbacks so a failing pick still recovers.
  const restOfPool = selected.length > 0 && pool.length > 0
    ? pool.map(([k, p]) => ({ key: k, provider: p })).filter(s => s.key !== selected[0].key)
      .sort((a, b) => (getHealth()[b.key]?.score || 0) - (getHealth()[a.key]?.score || 0))
    : [];
  let enabledProviders = selected.length > 0
    ? [selected[0]].concat(restOfPool).map(s => [s.key, s.provider])
    : Object.entries(PROVIDERS).filter(([_, p]) => p.enabled)
      .sort((a, b) => (getHealth()[b[0]]?.score || 50) - (getHealth()[a[0]]?.score || 50));

  // Put the requested model's mapped provider FIRST. It's the only provider
  // guaranteed to accept this tier/model — the rest are fallbacks (many reject
  // tier-* requests with 400/422). Trying them before the target produced huge
  // serial fallback chains (10+ sequential HTTP calls per request), which looked
  // like the "model thinking forever". Correct mapping beats weighted guessing.
  // Skipped in window-upgrade mode: the target doesn't fit the request anyway.
  // If the target is rate-limited or near/over its daily limit, DON'T put it
  // first — otherwise every request burns a doomed 429 attempt on it and the
  // pool collapses into a rate-limit spiral. Skip straight to the healthy pool.
  if (!windowUpgraded && MODEL_MAP[requestedModel] && PROVIDERS[targetProviderKey]) {
    const tHealth = getHealth()[targetProviderKey];
    const tLimit = (getStats().dailyUsage?.[targetProviderKey]?.[today]) || 0;
    const tCap = PROVIDERS[targetProviderKey].dailyLimit || 0;
    const targetBurned = tHealth?.status === 'ratelimited' || (tCap > 0 && tLimit >= tCap * 0.9);
    // Кодинг-target (codestral) не подходит для поиска фактов: на вопросе
    // «что такое минимакс дизайн» он отвечает «минимализм», а не про нейросеть.
    // Для search/chat-задач НЕ ставим кодинг-модель первой — пусть выберётся
    // general-модель (minimax/small), которая отвечает по существу.
    const targetIsCoding = (PROVIDERS[targetProviderKey].category || '') === 'coding';
    const targetMismatch = (taskCategory === 'search' || taskCategory === 'chat') && targetIsCoding;
    if (!targetBurned && !targetMismatch) {
      enabledProviders = [
        [targetProviderKey, PROVIDERS[targetProviderKey]],
        ...enabledProviders.filter(([k]) => k !== targetProviderKey),
      ];
    } else {
      logger.info('Target-first skip', { key: targetProviderKey, status: tHealth?.status, used: tLimit, cap: tCap, mismatch: targetMismatch });
    }
  }

  if (enabledProviders.length === 0) {
    commit(503);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No providers available' }));
    return;
  }

  const errors = [];

  // Cap serial fallback attempts. Trying provider after provider sequentially
  // made a single tier-* request walk 10+ providers (each a real HTTP call),
  // looking like the model "thinks forever". target-first above fixes the common
  // case (right provider immediately); this cap bounds the worst case.
  const fallbackProviders = enabledProviders.slice(0, 5);

  for (const [key, provider] of fallbackProviders) {
    if (isCircuitOpen(key)) {
      errors.push(key + ': circuit breaker open');
      continue;
    }

    const providerBody = { ...body, model: provider.model };

    try {
      const release = await acquire(key);
      let result;
      try {
        result = await callProvider(provider, providerBody);
      } finally {
        release();
      }
      initHealth(key);
      // Cap recorded latency — values >60s mean the request hung, not real
      // provider speed. Huge latency would poison the weighted selection.
      getHealth()[key].latency = Math.min(result.latency || 0, 60000);
      getHealth()[key].lastCheck = Date.now();

      if (!isStreaming && result.data) {
         delete result.data.nvext;
         if (result.data.choices?.[0]) {
           fixReasoningMessage(result.data.choices[0].message);
           cleanMessage(result.data.choices[0].message);
         }
         if (isTooShort(result.data, lastUserText(body.messages))) {
          // Пустой/мусорный ответ (провайдер-глитч) НЕ считается успехом — пробуем следующего.
          const msg = key + ': empty or too short response';
          errors.push(msg);
          recordFailure(key, 0);
          recordRequest(key, false, msg);
          recordBandit(complexityBucket, key, false);
          recordRecent({ model: requestedModel, provider: key, status: 204, latency: result.latency, cached: false });
          logger.warn('Empty or too-short response, trying next provider', { key });
          continue;
        }
      }

      if (isStreaming && result.stream) {
        measure.provider = key;
        const chunks = [];

        // Очистка SSE-строки: убрать nvext, logprobs, think-блоки из дельт.
        const cleanStr = (str) => str.replace(/^data: (.+)$/gm, (match, jsonStr) => {
          if (jsonStr.trim() === '[DONE]') return match;
          try {
            const obj = JSON.parse(jsonStr);
            delete obj.nvext;
            if (obj.choices?.[0]) {
              delete obj.choices[0].logprobs;
              cleanDelta(obj.choices[0].delta);
            }
            return 'data: ' + JSON.stringify(obj);
          } catch { return match; }
        });

        // Сбор контент-токенов для кэша (strip think).
        const streamUsage = {};
        const collect = (str) => {
          const lines = str.split('\n');
          for (const line of lines) {
            const m = line.match(/^data: (.+)$/);
            if (!m || m[1].trim() === '[DONE]') continue;
            try {
              const obj = JSON.parse(m[1]);
              const delta = obj.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') chunks.push(stripThink(delta, false));
              // OpenRouter / Nebius etc. put usage in a final chunk. Keep it.
              if (obj.usage && (obj.usage.prompt_tokens || obj.usage.completion_tokens)) {
                streamUsage.prompt_tokens = obj.usage.prompt_tokens;
                streamUsage.completion_tokens = obj.usage.completion_tokens;
                streamUsage.total_tokens = obj.usage.total_tokens;
              }
            } catch {}
          }
        };

        // Reasoning-модели (ox-alpha) думают 10с+ до первого токена — стримим сразу.
        // Успех записываем ДО любого токена намеренно: fallback по таймауту 5с
        // нанёс бы лишний дабл-счёт, если бы success фиксировался после первого токена.
        if (provider.reasoning) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          recordSuccess(key);
          recordRequest(key, true);
          logger.request({ model: requestedModel, provider: key, status: 200, latency: result.latency, stream: isStreaming });
          recordRecent({ model: requestedModel, provider: key, status: 200, latency: result.latency, cached: false });
          recordSelection(key, provider.model, requestedModel);
          const { Transform } = require('stream');
          const reasonDec = new StringDecoder('utf8');
          const reasonUsage = {};
          const cleaner = new Transform({
            transform(chunk, encoding, callback) {
              const str = reasonDec.write(chunk);
              collectReasonUsage(str, reasonUsage);
              collect(str);
              callback(null, cleanStr(str));
            },
            flush(callback) {
              const tail = reasonDec.end();
              if (tail) { collectReasonUsage(tail, reasonUsage); collect(tail); const tailStr = cleanStr(tail); if (tailStr) this.push(tailStr); }
              callback();
            }
          });
          result.stream.on('end', () => {
            const full = chunks.join('');
            // Bandit учится по качеству: пустой/мусорный стрим = фейл.
            recordBandit(complexityBucket, key, full.trim().length >= MIN_ANSWER_LEN);
            if (Object.keys(reasonUsage).length > 0) {
              recordTokens(key, reasonUsage);
              if (reasonUsage.prompt_tokens) measure.real = reasonUsage.prompt_tokens;
            }
            if (full.trim().length >= MIN_ANSWER_LEN) {
              cache.set(effectiveModel, body.messages, body.temperature, {
                id: 'chatcmpl-cached',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: provider.model,
                choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }, key, body.tools || body.tool_choice);
            }
            commit(200);
            res.end();
          });
          result.stream.on('error', (err) => {
            logger.error('Stream error', { key, error: err.message });
            if (!isTransientLimit(err.statusCode)) recordBandit(complexityBucket, key, false);
            commit(err.statusCode || 502);
            res.end();
          });
          result.stream.pipe(cleaner).pipe(res);
          return;
        }

        // Обычные модели: буферизуем до первого токена (макс 5 сек).
        // Заголовки не пишем сразу — если токена нет за 5 сек, fallback.
        // StringDecoder держит частично пришедший multi-byte UTF-8 между чанками —
        // иначе русский текст дробится на '' символ.
        const rawBuf = [];
        const streamDec = new StringDecoder('utf8');
        // Адаптивный таймаут первого токена: используем измеренную скорость
        // провайдера (latency от реальных запросов). Быстрые провайдеры не ждут
        // полные 5с перед fallback'ом, а медленные (но рабочие) не отбрасываются
        // слишком рано. Диапазон 2.5-8с для защиты от обоих крайностей.
        const knownLat = getHealth()[key]?.latency || 0;
        const firstTokenWait = knownLat > 0
          ? Math.max(2500, Math.min(8000, Math.round(knownLat * 2)))
          : 5000;
        const firstToken = new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, firstTokenWait);
          const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
          result.stream.on('data', (chunk) => {
            const str = streamDec.write(chunk);
            rawBuf.push(str);
            collect(str);
            // Первый контент-токен: хотя бы одно непустое `"content":"..."` в чанке.
            if (chunkHasToken(str)) {
              finish(true);
            }
          });
          result.stream.once('end', () => finish(false));
          result.stream.once('error', () => finish(false));
        });

        // Клиент отключился во время ожидания первого токена — прерываем.
        const onClientClose = () => {
          try { result.stream.destroy(); } catch {}
        };
        req.once('close', onClientClose);

        const gotFirst = await firstToken;
        if (!gotFirst) {
          const msg = key + ': no first token within 5s';
          errors.push(msg);
          recordFailure(key, 0);
          recordRequest(key, false, msg);
          recordBandit(complexityBucket, key, false);
          recordRecent({ model: requestedModel, provider: key, status: 204, latency: result.latency, cached: false });
          logger.warn('Streaming fallback: no first token', { key });
          try { result.stream.destroy(); } catch {}
          continue; // РАБОТАЕТ — мы внутри for-цикла провайдеров.
        }

        // Первый токен пришёл: пишем заголовки, промываем буфер, дальше стримим.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        recordSuccess(key);
        recordRequest(key, true);
        logger.request({ model: requestedModel, provider: key, status: 200, latency: result.latency, stream: isStreaming });
        recordRecent({ model: requestedModel, provider: key, status: 200, latency: result.latency, cached: false });
        recordSelection(key, provider.model, requestedModel);
        res.on('error', (err) => {
          logger.error('Client stream error', { key, error: err.message });
          try { result.stream.destroy(); } catch {}
        });
        for (const b of rawBuf) res.write(cleanStr(b));
        rawBuf.length = 0;

        // Убираем наш 'data'-слушатель (он больше не нужен — данные уже
        // буферизованы в rawBuf и промыты). Дальше обрабатываем вручную.
        // Продолжаем использовать ТОТ ЖЕ streamDec — иначе multi-byte UTF-8,
        // разделённый границей буфера, превратится в '' .
        result.stream.removeAllListeners('data');
        result.stream.on('data', (chunk) => {
          const str = streamDec.write(chunk);
          collect(str);
          res.write(cleanStr(str));
        });
        result.stream.on('end', () => {
          const tail = streamDec.end();
          if (tail) {
            collect(tail);
            res.write(cleanStr(tail));
          }
          const full = chunks.join('');
          // Bandit учится по качеству: обрыв/мусорный стрим = фейл.
          recordBandit(complexityBucket, key, full.trim().length >= MIN_ANSWER_LEN);
          if (Object.keys(streamUsage).length > 0) {
            recordTokens(key, streamUsage);
            if (streamUsage.prompt_tokens) measure.real = streamUsage.prompt_tokens;
          }
          if (full.trim().length >= MIN_ANSWER_LEN) {
            cache.set(effectiveModel, body.messages, body.temperature, {
              id: 'chatcmpl-cached',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: provider.model,
              choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }, key, body.tools || body.tool_choice);
          }
          commit(200);
          res.end();
        });
        result.stream.on('error', (err) => {
          logger.error('Stream error', { key, error: err.message });
          if (!isTransientLimit(err.statusCode)) recordBandit(complexityBucket, key, false);
          commit(err.statusCode || 502);
          res.end();
        });
        return;
      }

      if (!isStreaming && result.data) {
        // content already verified non-empty above
        recordSuccess(key);
        recordRequest(key, true);
        recordBandit(complexityBucket, key, true);
        logger.request({ model: requestedModel, provider: key, status: 200, latency: result.latency, stream: isStreaming });
        recordRecent({ model: requestedModel, provider: key, status: 200, latency: result.latency, cached: false });
        recordSelection(key, provider.model, requestedModel);
        measure.provider = key;
        measure.real = (result.data.usage && result.data.usage.prompt_tokens) ? result.data.usage.prompt_tokens : measure.sentTokens || 0;
        measure.win = PROVIDERS[key]?.context_window || 0;
        // Самопроверка второй моделью (опционально): только не-stream, только по конфигу.
        if (VETTING_CONFIG.enabled && !isStreaming) {
          const answer = result.data?.choices?.[0]?.message?.content || '';
          if (shouldVet({ config: VETTING_CONFIG, complexity, category: taskCategory, answerLen: answer.length })) {
            const picks = Object.entries(PROVIDERS)
              .filter(([pk, p]) => p.enabled && pk !== key && !isCircuitOpen(pk) &&
                getHealth()[pk]?.status === 'up' && p.vision !== true)
              .map(([_, p]) => p);
            try {
              const verdict = await vetAnswer({ answer, callProvider, picks, config: VETTING_CONFIG });
              if (verdict.checked && !verdict.ok && verdict.note) {
                const msg = result.data.choices[0].message;
                msg.content = (msg.content || '') + '\n\n> ⚠️ Проверка второй моделью: ' + verdict.note;
                measure.vetted = 1;
                measure.vetNote = verdict.note;
              } else {
                measure.vetted = 0;
              }
            } catch (vetErr) {
              measure.vetted = 0;
            }
          }
        }
        commit(200);
        cache.set(effectiveModel, body.messages, body.temperature, result.data, key, body.tools || body.tool_choice);
        recordTokens(key, result.usage);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.data));
        return;
      }
    } catch (err) {
      const statusCode = err.statusCode || 502;
      errors.push(err.message);
      recordRequest(key, false, err.message);
      // Временные лимиты (429/403/402) — не наказываем провайдера в bandit.
      if (!isTransientLimit(statusCode)) recordBandit(complexityBucket, key, false);
      recordRecent({ model: requestedModel, provider: key, status: statusCode, latency: 0, cached: false });
      initHealth(key);
      // Do NOT flip provider to 'error' on a single failed request — transient
      // failures (timeout, 5xx, one-off 429) shouldn't kill a healthy provider.
      // The circuit breaker (3 failures) and periodic health-check handle that.
      // Only a 429 marks it ratelimited (informational); 404 disables entirely.
      if (statusCode === 429) {
        getHealth()[key].status = 'ratelimited';
        getHealth()[key].reason = 'лимит провайдера (429)';
      } else if (statusCode === 401 || statusCode === 402 || statusCode === 403) {
        // Auth/баланс — НЕ транзиентная ошибка: ключ неверен или нет кредитов.
        // Оставлять провайдера в пуле здесь бессмысленно — он будет получать
        // запросы и каждый раз фейлиться. Сразу убираем из активной выборки.
        // Периодический health-check/modelManager может вернуть его, когда
        // ключ/баланс поправят (recheckDisabledDays).
        getHealth()[key].status = 'error';
        getHealth()[key].reason = statusCode === 401 ? 'неверный ключ' : statusCode === 402 ? 'нет средств/баланса' : 'доступ запрещён';
        getHealth()[key].score = Math.max(0, (getHealth()[key].score || 50) - 25);
        logger.warn('Provider auth/balance error, excluding from routing', { key, statusCode });
      } else if (statusCode !== 404 && getHealth()[key].status === 'up') {
        // keep 'up' — it may just be a transient blip; health-check re-verifies
      } else {
        getHealth()[key].status = 'error';
        getHealth()[key].reason = 'не отвечает';
      }
      getHealth()[key].score = Math.max(0, (getHealth()[key].score || 50) - (statusCode === 429 ? 5 : 10));
      recordFailure(key, statusCode, statusCode === 404 && err.providerSide ? { providerSide: true } : undefined);
      // 404 = model not available. Two distinct flavors:
      //  - plain 404 («does not exist») → disable permanently (model gone from OpenRouter).
      //  - provider-side 404 (Nvidia quota/upstream failing) → NOT permanent — the model
      //    may recover. Mark it down hard so routing prefers others, and let the periodic
      //    health-check re-enable it when it comes back.
      if (statusCode === 404) {
        if (err.providerSide) {
          getHealth()[key].status = 'error';
          getHealth()[key].reason = 'провайдер временно недоступен (404)';
          getHealth()[key].score = Math.max(0, (getHealth()[key].score || 50) - 25);
          logger.warn('Provider temporarily down (provider-side 404)', { key, model: provider.model });
        } else {
          provider.enabled = false;
          getHealth()[key].status = 'disabled';
          getHealth()[key].reason = 'отключён автоматически (404)';
          logger.warn('Provider auto-disabled (404)', { key, model: provider.model });
        }
      }
    }
  }

  // If every provider failed with transient errors (5xx/timeout), give them one
  // more pass after a short pause — many overloads clear in 1-2 seconds.
  const allSoft = errors.length > 0 && errors.every(e => !/429|401|403|404/.test(e));
  if (allSoft && enabledProviders.length > 1) {
    await new Promise(r => setTimeout(r, 1500));
    for (const [key, provider] of fallbackProviders) {
      if (isCircuitOpen(key)) continue;
      try {
        const release = await acquire(key);
        let result;
        try {
          result = await callProvider(provider, { ...body, model: provider.model });
        } finally {
          release();
        }
        if (!body.stream && result.data) {
          delete result.data.nvext;
          if (result.data.choices?.[0]) {
            fixReasoningMessage(result.data.choices[0].message);
            cleanMessage(result.data.choices[0].message);
          }
if (isTooShort(result.data, lastUserText(body.messages))) {
            recordFailure(key, 0);
            recordRequest(key, false, key + ': empty or too short response (retry)');
            recordBandit(complexityBucket, key, false);
            logger.warn('Empty or too-short response in retry, trying next', { key });
            continue;
          }
          recordSuccess(key);
          recordRequest(key, true);
          recordBandit(complexityBucket, key, true);
          recordRecent({ model: requestedModel, provider: key, status: 200, latency: result.latency, cached: false });
          recordSelection(key, provider.model, requestedModel);
          measure.provider = key;
          measure.real = (result.data.usage && result.data.usage.prompt_tokens) ? result.data.usage.prompt_tokens : measure.sentTokens || 0;
          measure.win = PROVIDERS[key]?.context_window || 0;
          commit(200);
          cache.set(effectiveModel, body.messages, body.temperature, result.data, key, body.tools || body.tool_choice);
          recordTokens(key, result.usage);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.data));
          return;
        }
        if (body.stream && result.stream) {
          measure.provider = key;
          recordSuccess(key);
          recordRequest(key, true);
          recordRecent({ model: requestedModel, provider: key, status: 200, latency: result.latency, cached: false });
          recordSelection(key, provider.model, requestedModel);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          const chunks = [];
          const collectRetry = (str) => {
            const lines = str.split('\n');
            for (const line of lines) {
              const m = line.match(/^data: (.+)$/);
              if (!m || m[1].trim() === '[DONE]') continue;
              try {
                const obj = JSON.parse(m[1]);
                const delta = obj.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') chunks.push(stripThink(delta, false));
              } catch {}
            }
          };
          const cleanRetry = (str) => str.replace(/^data: (.+)$/gm, (match, jsonStr) => {
            if (jsonStr.trim() === '[DONE]') return match;
            try {
              const obj = JSON.parse(jsonStr);
              delete obj.nvext;
              if (obj.choices?.[0]) {
                delete obj.choices[0].logprobs;
                cleanDelta(obj.choices[0].delta);
              }
              return 'data: ' + JSON.stringify(obj);
            } catch { return match; }
          });
          const retryDec = new StringDecoder('utf8');
          result.stream.on('data', (chunk) => {
            const str = retryDec.write(chunk);
            collectRetry(str);
            res.write(cleanRetry(str));
          });
          result.stream.on('end', () => {
            const tail = retryDec.end();
            if (tail) { collectRetry(tail); res.write(cleanRetry(tail)); }
            const full = chunks.join('');
            // Bandit учится по качеству в ретрае тоже.
            recordBandit(complexityBucket, key, full.trim().length >= MIN_ANSWER_LEN);
            if (full.trim().length >= MIN_ANSWER_LEN) {
              cache.set(effectiveModel, body.messages, body.temperature, {
                id: 'chatcmpl-cached',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: provider.model,
                choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }, key, body.tools || body.tool_choice);
            }
            commit(200);
            res.end();
          });
          result.stream.on('error', (err) => {
            logger.error('Stream error (retry)', { key, error: err.message });
            if (!isTransientLimit(err.statusCode)) recordBandit(complexityBucket, key, false);
            commit(err.statusCode || 502);
            res.end();
          });
          return;
        }
      } catch (err2) {
        recordRequest(key, false, err2.message);
        if (!isTransientLimit(err2.statusCode)) recordBandit(complexityBucket, key, false);
        recordFailure(key, err2.statusCode);
      }
    }
  }

  commit(502);
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'All providers failed', type: 'api_error', code: 'all_providers_failed', details: errors } }));
}

// Server

function sendJsonError(res, statusCode, message, extra) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, ...(extra || {}) } }));
}

// Apply a per-IP rate limit, set standard headers, and stop the request on 429.
function hitRateLimit(req, res, limit) {
  const serviceKey = req.socket.remoteAddress || 'unknown';
  const r = checkRateLimit(serviceKey, limit.maxRequests, limit.windowMs);
  res.setHeader('RateLimit-Limit', String(r.limit));
  res.setHeader('RateLimit-Remaining', String(r.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(r.resetAt / 1000)));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfter));
    logger.warn('Rate limit exceeded', { ip: serviceKey, limit: r.limit });
    sendJsonError(res, 429, 'Rate limit exceeded', { type: 'rate_limit_error', code: 'rate_limit_exceeded' });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = new URL(req.url, 'http://localhost:' + PORT);

  // Central auth: everything except /health requires AUTH_KEY when configured.
  // Accepts Authorization: Bearer (API clients) and ?key= (browser/admin routes).
  if (parsedUrl.pathname !== '/health' && AUTH_KEY && !isAuthorized(req, AUTH_KEY)) {
    logger.debug('Auth rejected', { path: parsedUrl.pathname, ip: req.socket.remoteAddress });
    sendJsonError(res, 401, 'Invalid API key', { code: 'invalid_api_key' });
    return;
  }

  if (parsedUrl.pathname === '/') {
    // Dashboard HTML/CSS/JS полностью инлайн (нет внешних ресурсов) — можно
    // поставить strict CSP: только same-origin fetch + inline-скрипты/styles.
    res.setHeader('Content-Security-Policy', "default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    handleDashboard(req, res);
    return;
  }

  if (parsedUrl.pathname === '/v1/reload' && req.method === 'POST') {
    // Hot-reload providers.json + config.json without restarting the server.
    if (!hitRateLimit(req, res, ADMIN_RATE_LIMIT)) return;
    try {
      const result = reloadProviders();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Reload failed: ' + err.message } }));
    }
    return;
  }

  if (parsedUrl.pathname === '/v1/config') {
    // Чтение/запись опций оптимизации (compress/vetting/routing) в config.json.
    try {
      const userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          compress: { enabled: !!(userCfg.compress && userCfg.compress.enabled), minLen: userCfg.compress?.minLen || 60 },
          vetting: { enabled: !!(userCfg.vetting && userCfg.vetting.enabled), minAnswerLen: userCfg.vetting?.minAnswerLen || 120, complexityOnly: userCfg.vetting?.complexityOnly !== false },
          routing: { strategy: userCfg.routing?.strategy || 'weighted', preference: userCfg.routing?.preference || 'free-first' },
        }));
        return;
      }
      if (req.method === 'POST') {
        if (!hitRateLimit(req, res, ADMIN_RATE_LIMIT)) return;
        const body = await readJsonBody(req, MAX_SMALL_BODY);
        if (!body.ok) {
          sendJsonError(res, body.code === 'EMPTY_BODY' || body.code === 'INVALID_JSON' ? 400 : 413, 'Invalid config body: ' + body.message);
          return;
        }
        const patch = body.value;
        if (typeof patch.compress === 'object') userCfg.compress = Object.assign({ enabled: false, minLen: 60 }, userCfg.compress, patch.compress);
        if (typeof patch.vetting === 'object') userCfg.vetting = Object.assign({ enabled: false, minAnswerLen: 120, complexityOnly: true }, userCfg.vetting, patch.vetting);
        if (typeof patch.routing === 'object') userCfg.routing = Object.assign({ strategy: 'weighted', preference: 'free-first' }, userCfg.routing, patch.routing);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Config read failed: ' + err.message } }));
      return;
    }
  }

  if (parsedUrl.pathname === '/v1/models-db' && req.method === 'GET') {
    // Структурированная база моделей: паспорта + статистика + топ по скору.
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    try {
      const models = modelManager.db.all()
        .map(m => ({
          key: m.key, model: m.model, source: m.source, category: m.category,
          contextWindow: m.contextWindow, dailyLimit: m.dailyLimit,
          score: m.score || 0, status: m.status,
          lastCheckedAt: m.lastCheckedAt || null, lastOkAt: m.lastOkAt || null,
        }))
        .sort((a, b) => b.score - a.score);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        stats: modelManager.db.stats(),
        top: models.slice(0, 10),
        models,
        manager: { enabled: MODEL_MANAGER_CONFIG.enabled !== false, intervalHours: modelManager.config.intervalHours, running: modelManager._running },
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return;
  }

  // Парсим /v1/models/{key}/toggle и /v1/models/{key}/test
  const modelActionMatch = parsedUrl.pathname.match(/^\/v1\/models\/([^/]+)\/(toggle|test)$/);
  if (modelActionMatch && req.method === 'POST') {
    if (!hitRateLimit(req, res, action === 'toggle' ? ADMIN_RATE_LIMIT : RATE_LIMIT)) return;
    const modelKey = decodeURIComponent(modelActionMatch[1]);
    const action = modelActionMatch[2];

    if (action === 'test') {
      // Живой "hi"-тест: работает ли модель с нашим ключом. Без изменения каталога.
      const dbEntry = modelManager.db.get(modelKey);
      const prov = PROVIDERS[modelKey];
      const endpoint = (dbEntry && dbEntry.endpoint) || (prov && prov.endpoint);
      const model = (dbEntry && dbEntry.model) || (prov && prov.model);
      if (!endpoint || !model) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Модель ' + modelKey + ' не найдена' }));
        return;
      }
      const source = (dbEntry && dbEntry.source) || 'unknown';
      const apiKey = modelManager.apiKeyFor(source);
      try {
        const t0 = Date.now();
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
          signal: AbortSignal.timeout(20000),
        });
        const latencyMs = Date.now() - t0;
        // Обновляем базу результатом проверки (но не «активируем» принудительно).
        modelManager.db.markChecked(modelKey, { ok: r.ok, status: r.status, latencyMs }, { now: Date.now() });
        modelManager.db.save();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: r.ok, status: r.status, latencyMs, model: { key: modelKey, status: modelManager.db.get(modelKey).status } }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 0, error: err.message }));
      }
      return;
    }

    // action === 'toggle': вкл/выкл провайдера в config.json (только этот ключ) + hot-reload.
    try {
      const userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (!userCfg.providers) userCfg.providers = {};
      if (!userCfg.providers[modelKey]) userCfg.providers[modelKey] = {};
      // Flip: было включено → выключить, было выключено → включить.
      const currentlyEnabled = !(userCfg.providers[modelKey].enabled === false);
      const newEnabled = !currentlyEnabled;
      userCfg.providers[modelKey].enabled = newEnabled;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
      reloadProviders();
      // Статус в базе: включили → untested (проверится в след. цикле), выключили → user-disabled.
      const entry = modelManager.db.get(modelKey);
      if (entry) {
        modelManager.db.setStatus(modelKey, newEnabled ? 'untested' : 'user-disabled');
        modelManager.db.save();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, key: modelKey, enabled: newEnabled, model: entry ? { key: modelKey, status: modelManager.db.get(modelKey).status } : null }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Toggle failed: ' + err.message } }));
    }
    return;
  }

  if (parsedUrl.pathname === '/health') {
    const h = getHealth();
    const upCount = Object.values(h).filter(v => v.status === 'up').length;
    const totalCount = Object.entries(PROVIDERS).filter(([_, p]) => p.enabled).length;
    const contextSummary = (() => { try { return contextStats.summary(); } catch { return null; } })();
    res.writeHead(upCount > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: upCount > 0 ? 'ok' : 'degraded', providers: { up: upCount, total: totalCount }, context: contextSummary }));
    return;
  }

  if (parsedUrl.pathname === '/v1/stats') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    const s = getStats();
    const today = new Date().toISOString().slice(0, 10);
    const limits = {};
    for (const [key, p] of Object.entries(PROVIDERS)) {
      const limit = p.dailyLimit;
      if (!limit) continue;
      const used = (s.dailyUsage?.[key]?.[today]) || 0;
      limits[key] = { limit, used, remaining: Math.max(0, limit - used), percent: Math.min(100, Math.round((used / limit) * 100)) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: VERSION,
      total_requests: s.totalRequests, successful_requests: s.successfulRequests, failed_requests: s.failedRequests,
      provider_usage: s.providerUsage, token_usage: s.tokenUsage, errors: s.errors, uptime_seconds: Math.floor((Date.now() - s.startTime) / 1000),
      today: (() => {
        const r = getReliability();
        let success = 0, fail = 0;
        for (const [_, v] of Object.entries(r)) { if (v && v.day === today) { success += v.success || 0; fail += v.fail || 0; } }
        const total = success + fail;
        return { requests: total, success, failed: fail, successRate: total > 0 ? Math.round((success / total) * 100) : 0 };
      })(),
      savings: (() => { try { return aggregateSavings(s.tokenUsage || {}); } catch { return null; } })(),
      health: Object.fromEntries(Object.entries(getHealth()).map(([k, v]) => {
        const limit = limits[k];
        const err = s.errors[k] || 0;
        let reason = '';
        if (v.status !== 'up') reason = v.status === 'ratelimited' ? 'лимит провайдера (429)' : 'не отвечает';
        else if (limit && limit.percent >= 100) reason = 'дневной лимит исчерпан';
        else if (err > 10) reason = 'много ошибок (' + err + ')';
        else reason = 'работает';
        const rel = s.reliability?.[k];
        let reliability = null;
        if (rel && rel.success + rel.fail >= 3) reliability = Math.round((rel.success / (rel.success + rel.fail)) * 100);
        return [k, { status: v.status, score: v.score, latency_ms: v.latency, reason, reliability }];
      })),
      cache: cache.stats(),
      hourly: (() => { try { return getHourly(); } catch { return []; } })(),
      limits,
      pool: poolStats(),
      last_selection: getLastSelection(),
      bandit: getBandit(),
      context_summary: (() => { try { return contextStats.summary(); } catch { return null; } })(),
    }));
    return;
  }

  if (parsedUrl.pathname === '/v1/models') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    const models = Object.entries(PROVIDERS)
      .filter(([_, p]) => p.enabled)
      .map(([key, p]) => ({
        id: p.model,
        object: 'model',
        owned_by: key,
        category: p.category || 'general',
        vision: p.vision === true,
        latency_ms: getHealth()[key]?.latency || null,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
    return;
  }

  if (parsedUrl.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;

    const bodyResult = await readJsonBody(req, MAX_CHAT_BODY);
    if (!bodyResult.ok) {
      if (bodyResult.code === 'PAYLOAD_TOO_LARGE') {
        sendJsonError(res, 413, 'Request body too large', { type: 'invalid_request_error', code: 'payload_too_large' });
        req.destroy();
      } else {
        sendJsonError(res, 400, bodyResult.message, { type: 'invalid_request_error', code: 'invalid_json_body' });
      }
      return;
    }
    const requestBody = bodyResult.value;

    // Validate structure + safety bounds before it burns provider limits.
    const validationErrors = validateChatRequest(requestBody);
    if (validationErrors.length > 0) {
      sendJsonError(res, 400, 'Validation failed', {
        type: 'invalid_request_error',
        code: 'invalid_messages',
        details: validationErrors,
      });
      return;
    }
    await handleChatCompletion(req, res, requestBody);
    return;
  }

  if (parsedUrl.pathname === '/v1/recent') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: getRecent() }));
    return;
  }

  if (parsedUrl.pathname === '/v1/rpm') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: getRpm() }));
    return;
  }

  // POST /v1/cache/clear — drop the in-memory semantic cache without a restart.
  // Handy when you tweaked providers/models and don't want stale answers served.
  if (parsedUrl.pathname === '/v1/cache/clear' && req.method === 'POST') {
    if (!hitRateLimit(req, res, ADMIN_RATE_LIMIT)) return;
    const before = cache.stats().size || 0;
    cache.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: before }));
    return;
  }

  // POST /v1/shorts — generate a vertical short video via the tools generator.
  // Body: { prompt, duration?, format? ("9:16"/"16:9"/"1:1"), steps? }
  if (parsedUrl.pathname === '/v1/shorts' && req.method === 'POST') {
    if (!hitRateLimit(req, res, SHORTS_RATE_LIMIT)) return;
    const bodyResult = await readJsonBody(req, MAX_SMALL_BODY);
    if (!bodyResult.ok) {
      if (bodyResult.code === 'PAYLOAD_TOO_LARGE') {
        sendJsonError(res, 413, 'Request body too large', { code: 'payload_too_large' });
        req.destroy();
      } else {
        sendJsonError(res, 400, bodyResult.message, { code: 'invalid_json_body' });
      }
      return;
    }
    const params = bodyResult.value;
    const validationErrors = validateShortsRequest(params);
    if (validationErrors.length > 0) {
      sendJsonError(res, 400, 'Validation failed', { code: 'invalid_short_request', details: validationErrors });
      return;
    }
    const { execFile } = require('child_process');
    const toolsDir = path.join(__dirname, 'tools');
    const py = path.join(toolsDir, '.venv', 'bin', 'python');
    const script = path.join(toolsDir, 'generate_shorts.py');
    // Build argv exclusively from validated values (never put raw params in cmd).
    const args = [script, params.prompt];
    if (params.duration) args.push('--duration', String(params.duration));
    if (params.format) args.push('--format', params.format);
    if (params.steps) args.push('--steps', String(params.steps));
    logger.info('Shorts generation requested', { prompt: params.prompt.slice(0, 60) });
    execFile(py, args, { cwd: toolsDir, timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logger.error('Shorts generation failed', { error: err.message, stderr: String(stderr).slice(0, 300) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Generation failed: ' + err.message, detail: String(stderr).slice(0, 300) } }));
        return;
      }
      // Parse absolute .mp4 paths from stdout
      const files = String(stdout).split('\n')
        .map(l => l.trim())
        .filter(l => l.includes('.mp4') && l.startsWith('/'))
        .map(l => l.split(' ').pop().trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, files, stdout: String(stdout).slice(0, 2000) }));
    });
    return;
  }

  // --- Setup Dashboard API ---
  if (parsedUrl.pathname === '/v1/setup/keys' && req.method === 'GET') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    const { keys } = readKeys();
    // Mask keys for display; inputs stay EMPTY so we never send masked values back.
    const masked = {};
    const empty = {};
    for (const [k, v] of Object.entries(keys)) {
      empty[k] = '';
      masked[k] = maskKey(v);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ groups: KEY_GROUPS, keys: empty, masked }));
    return;
  }

  if (parsedUrl.pathname === '/v1/setup/keys' && req.method === 'POST') {
    if (!hitRateLimit(req, res, ADMIN_RATE_LIMIT)) return;
    const bodyResult = await readJsonBody(req, MAX_SMALL_BODY);
    if (!bodyResult.ok) {
      if (bodyResult.code === 'PAYLOAD_TOO_LARGE') {
        sendJsonError(res, 413, 'Request body too large', { code: 'payload_too_large' });
        req.destroy();
      } else {
        sendJsonError(res, 400, bodyResult.message, { code: 'invalid_json_body' });
      }
      return;
    }
    const newKeys = bodyResult.value;
    // Only accept known env vars
    const filtered = {};
    for (const k of Object.keys(KEY_GROUPS)) {
      if (typeof newKeys[k] === 'string') filtered[k] = newKeys[k];
    }
    const result = saveKeys(filtered);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  if (parsedUrl.pathname === '/v1/setup/validate') {
    if (!hitRateLimit(req, res, RATE_LIMIT)) return;
    const envVar = parsedUrl.searchParams.get('envVar');
    let testKey = parsedUrl.searchParams.get('apiKey');
    if (!envVar) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'envVar required' } }));
      return;
    }
    // If apiKey param is empty/absent, validate the real stored key from .env.
    if (!testKey) {
      testKey = getStoredKey(envVar);
    }
    if (!testKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Нет сохранённого ключа' }));
      return;
    }
    validateKey(envVar, testKey).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  logger.info('Freegate started', { port: PORT });
  console.log('Dashboard: http://localhost:' + PORT + '/');
  // Самообновляющаяся база моделей: первый цикл через 2 мин, далее по интервалу.
  if (MODEL_MANAGER_CONFIG.enabled !== false) {
    modelManager.start();
    logger.info('ModelManager started', { intervalHours: modelManager.config.intervalHours });
  }
  // Автообновление на лету: git fetch + ff-pull + перезапуск, без действий юзера.
  if (AUTO_UPDATE.enabled) {
    autoUpdate.startAutoUpdate({ root: __dirname, log: (m) => logger.info(m) });
    logger.info('AutoUpdate enabled', { intervalMs: AUTO_UPDATE.intervalMs });
  }
  // Мониторинг метрик: снапшот каждые 30 мин → можно сравнить «до/после» фиксов.
  if (DIAG_MONITOR.enabled) {
    diagMonitor.startMonitor(DIAG_MONITOR.intervalMs);
    logger.info('DiagMonitor started', { intervalMs: DIAG_MONITOR.intervalMs });
  }
});

const _shutdown = () => {
  if (memStore) { memStore.stopTimer(); memStore.save(); }
  diagMonitor.stopMonitor();
  require('./lib/health').saveStateSync();
  cache.persistSync();
  try { modelManager.stop(); } catch {}
  server.close(() => process.exit(0));
};
process.on('SIGINT', _shutdown);
process.on('SIGTERM', _shutdown);

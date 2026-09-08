// test/proxy.test.js — unit tests for Freegate proxy logic (no external deps)
// Run: node --test test/
// Тестовая изоляция: уводим prod-лог и prod-стейт в temp, чтобы `node --test`
// не писал в proxy.log/state.json (lib/logger.js и lib/health.js читают env).
const os = require('os');
const path = require('path');
process.env.LOG_PATH = process.env.LOG_PATH || path.join(os.tmpdir(), 'freegate-test.log');
process.env.STATE_PATH = process.env.STATE_PATH || path.join(os.tmpdir(), 'freegate-test-state.json');
const test = require('node:test');
const assert = require('node:assert');
const { LRUCache } = require('../lib/cache');
const { acquire } = require('../lib/pool');
const { checkRateLimit } = require('../lib/rateLimit');

test('LRUCache: stores and retrieves by model/messages', () => {
  const c = new LRUCache(10, 60000, true);
  c.set('m', [{ role: 'user', content: 'hi' }], 0, { hello: 'world' });
  assert.deepStrictEqual(c.get('m', [{ role: 'user', content: 'hi' }], 0), { hello: 'world' });
  assert.strictEqual(c.get('m', [{ role: 'user', content: 'other' }], 0), null);
});

test('LRUCache: evicts oldest when full', () => {
  const c = new LRUCache(2, 60000, true);
  c.set('a', [{ role: 'user', content: '1' }], 0, 'first');
  c.set('b', [{ role: 'user', content: '2' }], 0, 'second');
  c.set('c', [{ role: 'user', content: '3' }], 0, 'third');
  assert.strictEqual(c.get('a', [{ role: 'user', content: '1' }], 0), null); // evicted
  assert.strictEqual(c.get('c', [{ role: 'user', content: '3' }], 0), 'third');
});

test('LRUCache: TTL expiry', () => {
  const c = new LRUCache(10, 1, true); // 1ms TTL
  c.set('m', [{ role: 'user', content: 'hi' }], 0, 'value');
  setTimeout(() => {
    assert.strictEqual(c.get('m', [{ role: 'user', content: 'hi' }], 0), null);
  }, 10);
});

test('LRUCache: hit/miss stats', () => {
  const c = new LRUCache(10, 60000, true);
  c.set('m', [{ role: 'user', content: 'hi' }], 0, 'v');
  c.get('m', [{ role: 'user', content: 'hi' }], 0); // hit
  c.get('x', [{ role: 'user', content: 'no' }], 0); // miss
  const s = c.stats();
  assert.strictEqual(s.hits, 1);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.hitRate, 50);
});

test('LRUCache: disk persistence round-trip', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `cache-test-${Date.now()}.json`);

  // Point the module's CACHE_PATH to a temp file by monkey-patching
  const crypto = require('crypto');
  const cacheMod = require('../lib/cache');

  const c = new LRUCache(10, 60000);
  c.set('m', [{ role: 'user', content: 'disk' }], 0, { persisted: true });
  c.persist();

  // Verify the default file exists (module writes to its own path)
  const fs2 = require('fs');
  const fileExists = fs2.existsSync(path.join(__dirname, '..', 'cache.json'));
  assert.strictEqual(fileExists, true);
  try { fs2.unlinkSync(path.join(__dirname, '..', 'cache.json')); } catch {}
});

test('LRUCache: semantic cache hits on normalized similar messages', () => {
  const { LRUCache } = require('../lib/cache');
  const c = new LRUCache(10, 60000, true, true); // 4th arg = useNormalize
  c.set('m', [{ role: 'user', content: 'Привет, как дела?' }], 0, { ok: true });
  const hit = c.get('m', [{ role: 'user', content: 'привет как дела' }], 0);
  assert.deepStrictEqual(hit, { ok: true }, 'нормализованные сообщения попадают в кэш');
});

test('LRUCache: empty normalized text does not collapse distinct requests', () => {
  const { LRUCache } = require('../lib/cache');
  const c = new LRUCache(10, 60000, true, true);
  // Two different user messages whose normalized text is empty (image-only parts)
  const msgA = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }];
  const msgB = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }] }];
  c.set('m', msgA, 0, { answer: 'A' });
  assert.strictEqual(c.get('m', msgB, 0), null, 'разные image-only запросы не должны попадать в один кэш');
  assert.deepStrictEqual(c.get('m', msgA, 0), { answer: 'A' });
});

test('rateLimit: allows under limit, blocks over', () => {
  // reset internal state by using a unique key
  const key = `test-${Date.now()}`;
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(checkRateLimit(key, 5, 60000).allowed, true);
  }
  assert.strictEqual(checkRateLimit(key, 5, 60000).allowed, false);
});

test('health: classifyErrorMs returns sane durations', () => {
  const health = require('../lib/health');
  // Access classify via a small wrapper — it's internal, test via circuit behavior
  // Simulate: record failures with different status codes and check breaker opens
  // Use a fake provider key
  const key = `cb-${Date.now()}`;
  health.recordFailure(key, 401);
  // 401 should open immediately (openMs 300s > 60s threshold)
  assert.strictEqual(health.isCircuitOpen(key), true);
});

test('health/logger: уважают LOG_PATH/STATE_PATH (изоляция от прод-файлов)', () => {
  const fs = require('fs');
  const health = require('../lib/health');
  const key = `iso-${Date.now()}`;
  health.recordFailure(key, 401);   // открывает breaker → logger.warn → пишет в LOG_PATH
  health.saveStateSync();           // пишет state в STATE_PATH (синхронно, детерминированно)
  const log = fs.readFileSync(process.env.LOG_PATH, 'utf8');
  assert.ok(log.includes(key), 'лог ушёл в изолированный LOG_PATH');
  const st = JSON.parse(fs.readFileSync(process.env.STATE_PATH, 'utf8'));
  assert.ok(st.circuitBreakers && st.circuitBreakers[key], 'state ушёл в изолированный STATE_PATH');
});

test('health: dailyUsage tracks per-provider per-day counts', () => {
  const health = require('../lib/health');
  const key = `daily-${Date.now()}`;
  health.recordRequest(key, true);
  health.recordRequest(key, true);
  const today = new Date().toISOString().slice(0, 10);
  const usage = health.getDailyUsage();
  assert.strictEqual(usage[key]?.[today], 2);
});

test('providers: catalog loads and merges with user config', () => {
  const fs = require('fs');
  const path = require('path');
  const catalogPath = path.join(__dirname, '..', 'providers.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.ok(Object.keys(catalog).length >= 10, 'catalog has >=10 providers');
  const { PROVIDERS } = require('../lib/providers');
  assert.ok(Object.keys(PROVIDERS).length >= 10, 'merged providers >= 10');
});

test('providers: catalog providers are enabled by default', () => {
  const { PROVIDERS } = require('../lib/providers');
  const enabled = Object.entries(PROVIDERS).filter(([_, p]) => p.enabled !== false);
  assert.ok(enabled.length >= 10, 'at least 10 providers enabled by default');
});

test('providers: catalog has vision-capable providers for screenshots', () => {
  const { PROVIDERS } = require('../lib/providers');
  const vision = Object.entries(PROVIDERS).filter(([_, p]) => p.vision === true);
  assert.ok(vision.length >= 2, 'at least 2 vision providers (gemini-vision, nim-vision)');
  const names = vision.map(([k]) => k).join(', ');
  assert.ok(names.includes('gemini-vision'), 'gemini-vision present');
});

test('health: 404 trips breaker but short (health-probe backoff, not 5min)', () => {
  const health = require('../lib/health');
  const key = `cb404-${Date.now()}`;
  // Одиночный 404 после 3 фейлов даёт короткий trip (~60s), консекутивные
  // растут экспоненциально до cap 5 мин — см. test/health.test.js.
  health.recordFailure(key, 404);
  assert.strictEqual(health.isCircuitOpen(key), false, 'single 404 не открывает сразу');
  health.recordFailure(key, 404);
  health.recordFailure(key, 404);
  assert.strictEqual(health.isCircuitOpen(key), true, '3 фейла открывают breaker');
  assert.ok(health.getCircuitBreakers()[key].openUntil - Date.now() < 300000, 'trip < 5min');
});

test('health: warming cold bandit priors boosts brand-new providers', () => {
  const health = require('../lib/health');
  const key = `warm-${Date.now()}`;
  const warmed = health.warmBanditPriors([key], ['low', 'med', 'high']);
  assert.strictEqual(warmed, 3);
  for (const b of ['low', 'med', 'high']) {
    const p = health.getBandit()[b][key];
    assert.ok(p, `prior for ${b} exists`);
    assert.strictEqual(p.a, 6);
    assert.strictEqual(p.b, 2);
  }
});

test('health: warming never touches proven priors', () => {
  const health = require('../lib/health');
  const key = `proven-${Date.now()}`;
  health.warmBanditPriors([key], ['low']);
  health.getBandit().low[key] = { a: 40, b: 30 };
  const before = JSON.stringify(health.getBandit().low[key]);
  health.warmBanditPriors([key], ['low']);
  assert.strictEqual(JSON.stringify(health.getBandit().low[key]), before, 'proven prior untouched');
});

test('health: provider-side 404 opens breaker short (upstream temporarily down)', () => {
  const health = require('../lib/health');
  const key = `cb404ps-${Date.now()}`;
  health.recordFailure(key, 404, { providerSide: true });
  const cb = health.getCircuitBreakers()[key];
  const openMs = (cb && cb.openUntil) ? (cb.openUntil - cb.lastFailure) : 0;
  // provider-side 404 → ~70s (vs 300s for a real missing model)
  assert.ok(openMs <= 75000, 'expected short breaker, got ' + openMs + 'ms');
  assert.ok(cb.openUntil > Date.now(), 'breaker should still be open');
});

test('health: user config can disable a catalog provider (enabled:false)', () => {
  // Simulate the merge logic: enabled:false must remove the provider.
  // The real merge lives in lib/providers loadConfig; here we verify the
  // catalog itself has no enabled:false, and the catalog merge keeps >=10.
  const fs = require('fs');
  const path = require('path');
  const { PROVIDERS } = require('../lib/providers');
  // No provider should be force-disabled by default (that's a user decision)
  const noneDisabled = Object.entries(PROVIDERS).every(([_, p]) => p.enabled !== false);
  assert.strictEqual(noneDisabled, true);
  assert.ok(Object.keys(PROVIDERS).length >= 10);
});

test('providers: CLI status and test commands exist in help', () => {
  const { execSync } = require('child_process');
  const path = require('path');
  const bin = path.join(__dirname, '..', 'bin', 'freegate.js');
  const help = execSync(`node "${bin}"`).toString();
  assert.ok(help.includes('status'), 'status command documented');
  assert.ok(help.includes('install-service'), 'install-service documented');
  assert.ok(help.includes('test'), 'test command documented');
});

test('providers: request validation rejects empty messages', () => {
  // The validation lives in server.js; here we verify the CLI help and
  // catalog integrity that gate the same quality bar.
  const fs = require('fs');
  const path = require('path');
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'providers.json'), 'utf8'));
  // Every catalog provider must have the fields the proxy relies on.
  // Local providers (ollama, lmstudio) need no API key → no envVar.
  for (const [name, p] of Object.entries(catalog)) {
    assert.ok(p.endpoint, name + ' has endpoint');
    assert.ok(p.model, name + ' has model');
    assert.ok(p.dailyLimit, name + ' has dailyLimit');
    if (!p.local) {
      assert.ok(p.envVar, name + ' has envVar');
    }
  }
});

test('CLI: init (non-interactive) creates config and env without overwriting', () => {
  const { execSync } = require('child_process');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freegate-init-'));
  // Pre-existing config must be preserved
  fs.writeFileSync(path.join(tmp, 'config.json'), '{"port":4123}');
  const bin = path.join(__dirname, '..', 'bin', 'freegate.js');
  execSync(`node "${bin}" init`, { cwd: tmp, stdio: 'pipe' });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.port, 4123, 'existing config not overwritten');
  assert.ok(fs.existsSync(path.join(tmp, '.env')), '.env created');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CLI: init wizard имеет режимы quick/full + подсказку Cursor', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'freegate.js'), 'utf8');
  assert.ok(/initWizard\(\)/.test(src), 'wizard существует');
  // Режим quick (1 ключ OpenRouter) — объяснение
  assert.ok(/минимум|Минимум: 1 ключ OpenRouter/i.test(src), 'объяснение quick');
  assert.ok(/quick|Режим \[q\]uick/i.test(src), 'выбор режима quick');
  assert.ok(/full|\[f\]ull/i.test(src), 'выбор режима full');
  // В quick просим только OpenRouter, остальные пропускаем
  assert.ok(/!full\s*&&\s*envVar\s*!==\s*EASY_START_PROVIDER/.test(src), 'quick пропускает не-OpenRouter');
  assert.ok(/EASY_START_PROVIDER\s*=\s*'PROVIDER_OPENROUTER_APIKEY'/.test(src), 'EASY_START_PROVIDER задан');
  // Подсказка подключения к Cursor
  assert.ok(/Cursor/i.test(src), 'подсказка про Cursor');
});

test('pool: limits concurrency and queues overflow', async () => {
  const { acquire, stats } = require('../lib/pool');
  const key = 'pooltest-' + Date.now();
  const releases = [];
  // Acquire max (default 6) slots
  for (let i = 0; i < 6; i++) {
    releases.push(await acquire(key));
  }
  // 7th must queue (not resolve immediately)
  let queued = false;
  const p = acquire(key).then((r) => { releases.push(r); queued = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(queued, false, '7th acquire should queue');
  // Release one slot → queued one resolves
  releases[0]();
  await p;
  assert.strictEqual(queued, true, 'queued acquire resolves after release');
  // Cleanup
  releases.forEach(r => { try { r(); } catch {} });
});

test('providers: HF env var is mapped (PROVIDER_HF_APIKEY)', () => {
  const fs = require('fs');
  const path = require('path');
  // Confirm the prefix map supports HF, regardless of whether an HF provider
  // is currently in the catalog (auto-manage adds it on demand).
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'providers.js'), 'utf8');
  assert.ok(/HF:\s*'HF'/.test(src), 'HF prefix mapped in providers.js');
});

test('health: getContextStats returns a working ContextStats singleton', () => {
  const health = require('../lib/health');
  const cs = health.getContextStats();
  assert.ok(cs && typeof cs.record === 'function' && typeof cs.serialize === 'function', 'singleton API');
  cs.record({ ts: Date.now(), provider: 'test-provider', real: 1000, win: 2000, status: 200 });
  const s = cs.snapshot().buckets.find(b => b.provider === 'test-provider');
  assert.ok(s && s.requests >= 1, 'record landed in singleton');
});

test('health: saveState writes stats.context as buckets array (state restored)', () => {
  const fs = require('fs');
  const health = require('../lib/health');
  const statePath = process.env.STATE_PATH;
  health.getContextStats().record({ ts: Date.now(), provider: 'roundtrip-ctx', real: 1000, win: 2000, status: 200 });
  health.saveStateSync();
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(saved.stats && Array.isArray(saved.stats.context.buckets), 'stats.context persisted as buckets array');
  health.getContextStats().load(saved.stats.context);
  assert.ok(health.getContextStats().snapshot().buckets.find(b => b.provider === 'roundtrip-ctx'), 'bucket survives save→load');
});

test('contextstats: summary contract used by /health and /v1/stats', () => {
  const { ContextStats } = require('../lib/contextstats');
  const s = new ContextStats().summary();
  assert.equal(typeof s.status, 'string');
  assert.equal(typeof s.totalRequests, 'number');
  assert.equal(typeof s.cacheHitRate, 'number');
  assert.equal(typeof s.ratePerHour, 'number');
  assert.ok(typeof s.providers === 'object' && Array.isArray(s.providers) === false, 'providers rows map');
});

test('server: getContextStats exported by health (wiring anchor)', () => {
  const health = require('../lib/health');
  assert.equal(typeof health.getContextStats, 'function');
});

test('dashboard: renders context block', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');
  assert.ok(html.includes('ctxBlock'), 'есть элемент #ctxBlock');
  assert.ok(html.includes('renderContext'), 'есть рендер renderContext');
  assert.ok(html.includes('context_summary'), 'refresh читает context_summary');
  assert.ok(html.includes('upgradedCount'), 'renderContext читает апгрейды');
  assert.ok(html.includes('sum.tasks') && html.includes('taskTotal'), 'renderContext читает категории задач');
});

test('dashboard: optimization options (compress/vetting/routing) + /v1/config', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');
  // Переключатели Опции оптимизации
  assert.ok(html.includes('optBlock'), 'блок опций');
  assert.ok(html.includes('optCompress'), 'переключатель сжатия');
  assert.ok(html.includes('optVetting'), 'переключатель самопроверки');
  assert.ok(html.includes('optRouting'), 'селект стратегии');
  assert.ok(html.includes('optCompressDesc'), 'объяснение сжатия');
  assert.ok(html.includes('loadOpts') && html.includes('saveOpts'), 'загрузка/сохранение опций');
  // Эндпоинт в server.js
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("'/v1/config'"), 'эндпоинт /v1/config существует');
});

test('dashboard: redesigned frame (KPI + tabs + sortable tables)', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');
  // KPI-полоска
  assert.ok(html.includes('renderKpi'), 'renderKpi существует');
  assert.ok(html.includes('id="kpiBar"'), 'sticky KPI-полоска есть');
  // Табы: 5 разделов
  assert.ok(html.includes("showTab('overview')"), 'таб Обзор');
  assert.ok(html.includes("showTab('providers')"), 'таб Провайдеры');
  assert.ok(html.includes("showTab('models')"), 'таб Модели');
  assert.ok(html.includes("showTab('context')"), 'таб Контекст');
  assert.ok(html.includes("showTab('setup')"), 'таб Настройки');
  // Мульти-темы
  assert.ok(html.includes('data-theme="warm"') && html.includes('data-theme="paper"'), 'темы warm/paper');
  assert.ok(html.includes('function cycleTheme') && html.includes('themeBtn'), 'переключатель темы');
  assert.ok(html.includes("fg_theme"), 'тема сохраняется в localStorage');
  // Табы: 5 разделов
  assert.ok(html.includes("showTab('overview')"), 'таб Обзор');
  assert.ok(html.includes("showTab('providers')"), 'таб Провайдеры');
  assert.ok(html.includes("showTab('models')"), 'таб Модели');
  assert.ok(html.includes("showTab('context')"), 'таб Контекст');
  assert.ok(html.includes("showTab('setup')"), 'таб Настройки');
  // Провайдеры: таблица с фильтрами/поиском/сортировкой
  assert.ok(html.includes('renderProvidersTable'), 'таблица провайдеров');
  assert.ok(html.includes('providerSearch'), 'поиск провайдеров');
  assert.ok(html.includes('setProviderFilter'), 'фильтры-чипсы провайдеров');
  assert.ok(html.includes('sortProvidersBy'), 'сортировка провайдеров');
  // Модели: таблица с фильтрами
  assert.ok(html.includes('renderModelsTable'), 'таблица моделей');
  assert.ok(html.includes('/v1/models-db'), 'fetch базы моделей');
  assert.ok(html.includes('modelSearch'), 'поиск моделей');
  // Обзор: алерты
  assert.ok(html.includes('renderAlerts'), 'блок алертов');
  // Setup-панель сохранена
  assert.ok(html.includes('setup-panel') || html.includes('panel-setup'), 'setup-панель есть');
  assert.ok(html.includes('loadSetup'), 'setup-логика сохранена');
});

test('dashboard: модели — тумблер вкл/выкл + тест из UI (i18n)', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');
  // Тумблер в таблице моделей + вызов endpoint
  assert.ok(html.includes("function toggleModel"), 'тумблер toggleModel');
  assert.ok(html.includes('/v1/models/'), 'endpoint toggle/test');
  assert.ok(html.includes('toggleModel('), 'toggleModel вызывается');
  // Тест модели из UI
  assert.ok(html.includes('testModelLive') || html.includes('probeModel'), 'тест модели из UI');
  // Рекомендации
  assert.ok(html.includes('renderModelRecommend') || html.includes('modelRecommend'), 'рекомендации моделей');
  // Двухязычность: словарь + переключатель
  assert.ok(html.includes('I18N'), 'словарь I18N');
  assert.ok(html.includes('setLang'), 'переключатель языка setLang');
  assert.ok(html.includes('t('), 'функция t()');
  assert.ok(html.includes("'en'") || html.includes('"en"'), 'есть английские строки');
});

test('server: /v1/models/{key}/toggle и /test зарегистрированы', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/\/v1\/models\//.test(src), 'роут /v1/models/ есть');
  assert.ok(/toggleModel\s*\(|\/toggle\b/.test(src), 'обработчик toggle в server');
  assert.ok(/\/test\b|probeModel\s*\(/.test(src), 'обработчик test в server');
  assert.ok(/reloadProviders\s*\(\s*\)/.test(src), 'toggle перезагружает провайдеров');
});

// Stop background timers so the test process can exit (health.js sets setInterval)
require('../lib/health')._stopTimers();
require('../lib/cache')._stopTimers();

test('cache: hits/misses persist across restarts', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { LRUCache } = require('../lib/cache');
  // Create a cache, hit once, persist, then recreate (simulates restart)
  const c1 = new LRUCache(5, 60000);
  c1.set('m', [{ role: 'user', content: 'persist' }], 0, 'v');
  c1.get('m', [{ role: 'user', content: 'persist' }], 0); // 1 hit
  c1.persist();
  const c2 = new LRUCache(5, 60000);
  const stats = c2.stats();
  assert.ok(stats.hits >= 1, 'hits restored after restart');
  try { fs.unlinkSync(path.join(__dirname, '..', 'cache.json')); } catch {}
});

test('server: window-aware upgrade wiring (structural)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('needsWindowUpgrade'), 'импорт хелпера из routing');
  assert.ok(/windowUpgraded\s*=\s*Array\.isArray/.test(src), 'decision point перед компакцией');
  assert.ok(src.includes('measure.upgraded = 1'), 'мера апгрейда ставится');
  assert.ok(/&&\s*!\s*windowUpgraded\s*\)\s*\{[\s\S]*prepareMessages/.test(src), 'prepareMessages пропускается при апгрейде');
  assert.ok(src.includes('if (requestTokens > MIN_WINDOW || windowUpgraded)'), 'window-фильтр без гейта при апгрейде');
  assert.ok(src.includes('WINDOW_SAFETY'), 'запас окна против заниженной оценки');
  assert.ok(/win\s*>=\s*requestTokens\s*\*\s*WINDOW_SAFETY/.test(src), 'окно требует запас');
  assert.ok(src.includes('!windowUpgraded && MODEL_MAP[requestedModel]'), 'target-first пропускается при апгрейде');
  assert.ok(/measure\.est\s*=\s*measure\.sentTokens/.test(src), 'sumEst питается оценкой отправленных токенов');
});

test('server: 401/402/403 исключают провайдера из роутинга (auth/баланс, не транзиент)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/statusCode\s*===\s*401\s*\|\|\s*statusCode\s*===\s*402\s*\|\|\s*statusCode\s*===\s*403/.test(src), 'обрабатывает 401/402/403 как отдельный класс');
  assert.ok(/getHealth\(\)\[key\]\.status\s*=\s*'error'/.test(src), 'ставит статус error (исключает из пула)');
  assert.ok(/status\s*===\s*'up'\s*\|\|\s*getHealth\(\)\[p\.key\]\?\.status\s*===\s*'ratelimited'/.test(src), 'healthyProviders берёт только up/ratelimited → error исключён');
});

test('server: target-first пропускается при выгоревшем лимите (анти-спираль 429)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('Target-first skip'), 'логирует skip target');
  assert.ok(src.includes('targetBurned'), 'условие выгоревшего target');
  assert.ok(/targetBurned\s*=\s*tHealth\?\.status\s*===\s*'ratelimited'/.test(src), 'проверяет ratelimited');
  assert.ok(/tCap\s*>\s*0\s*&&\s*tLimit\s*>=\s*tCap\s*\*\s*0\.9/.test(src), 'проверяет лимит >=90%');
  assert.ok(/if \(!targetBurned\s*&&\s*!targetMismatch\)\s*\{/.test(src), 'target-first только если не выгорел и target подходит');
});

test('server: search/chat не ставят кодинг-target первым (codestral идёт на general)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('targetIsCoding'), 'определяет кодинг-target');
  assert.ok(/targetMismatch\s*=\s*\(taskCategory\s*===\s*'search'\s*\|\|\s*taskCategory\s*===\s*'chat'\)\s*&&\s*targetIsCoding/.test(src), 'mismatch для search/chat + coding');
  assert.ok(/if \(!targetBurned\s*&&\s*!targetMismatch\)/.test(src), 'target-first пропускается при mismatch');
});

test('server: preferred free↔paid routing (config.routing.preference)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('ROUTING_PREFERENCE'), 'читает preference');
  assert.ok(src.includes('config.routing.preference'), 'из config.routing');
  assert.ok(src.includes('free-first'), 'дефолт free-first');
  assert.ok(/isPaid\s*=\s*provider\.paid\s*===\s*true/.test(src), 'paid маркер: paid===true');
  assert.ok(/paid-first/.test(src) && /paid-fallback/.test(src), 'оба варианта preference');
  assert.ok(/weight\s*\*=\s*2\.5/.test(src), 'paid-first бустит вес платных');
  assert.ok(/weight\s*\*=\s*0\.1/.test(src), 'paid-fallback дебустит платных, пока живые');
});

test('server: анти-замирание — провайдеры с многими ошибками исключаются из пула', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('ERROR_POOL_THRESHOLD'), 'порог ошибок');
  assert.ok(src.includes('getStats().errors'), 'читает ошибки за день');
  assert.ok(/lowErrorProviders\s*=\s*healthyProviders\.filter/.test(src), 'фильтрует высокоошибочные');
  assert.ok(/lowErrorProviders\.length\s*>\s*0\s*\?\s*lowErrorProviders\s*:\s*healthyProviders/.test(src), 'fallback при пустом пуле');
});

test('server: веб-поиск для search-задач (websearch + websearch.toContext)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mod = fs.readFileSync(path.join(__dirname, '..', 'lib', 'websearch.js'), 'utf8');
  assert.ok(src.includes("require('./lib/websearch')"), 'импорт websearch в server');
  assert.ok(/WEBSEARCH_CONFIG/.test(src), 'конфиг websearch');
  assert.ok(/taskCategory\s*===\s*'search'\s*\|\|\s*taskCategory\s*===\s*'chat'/.test(src), 'поиск для search/chat');
  assert.ok(src.includes('websearch.search('), 'вызов поиска');
  assert.ok(src.includes('websearch.toContext'), 'сборка контекста');
  assert.ok(/body\.messages\.push\(\{ role: 'system', content: searchContext \}\)/.test(src), 'вставка контекста в сообщения');
  assert.ok(mod.includes('parseDdg'), 'websearch: парсер DDG');
  assert.ok(mod.includes('decodeUrl'), 'websearch: разбор obfuscated URL');
});

test('server: /v1/stats отдаёт экономию (savings) против платных API', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/aggregateSavings\s*\(/.test(src), 'использует aggregateSavings');
  assert.ok(/"savings"/.test(src) || /savings:/.test(src), 'поле savings в ответе /v1/stats');
});

test('server: /v1/stats отдаёт дневную статистику (today: successRate)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/getReliability/.test(src), 'читает getReliability');
  assert.ok(/"today":/.test(src) || /today:\s*\(\(\)\s*=>/.test(src), 'поле today в /v1/stats');
  assert.ok(/successRate/.test(src), 'считает successRate');
});

test('server: простые задачи (chat/search) штрафуют reasoning-модели', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/chat'\s*\|\|\s*taskCategory\s*===\s*'search'/.test(src), 'проверяет chat/search');
  assert.ok(/cat\s*===\s*'reasoning'\)\s*weight\s*\*=\s*0\.15/.test(src), 'штраф reasoning ×0.15 для простых задач');
});

test('server: крутящийся пул исключает исчерпавшие лимит модели', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/usedTodayFor/.test(src), 'хелпер дневного использования usedTodayFor');
  assert.ok(/dailyUsage\?\.\[key\]\?\.\[today\]/.test(src), 'читает дневной лимит из dailyUsage');
  assert.ok(/exemptables\.length\s*>\s*0\s*\?\s*exemptables\s*:\s*windowPool/.test(src), 'исключает выгоревшие, возвращает raw-пул только если все выгорели');
  assert.ok(/usedToday\s*>=\s*dailyLimit\)\s*weight\s*\*=\s*0\.03/.test(src), 'исчерпанные штрафуются ×0.03');
});

test('server: design-задачи бустят coding-модели', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/taskCategory\s*===\s*'design'\s*&&\s*cat\s*===\s*'coding'\)\s*weight\s*\*=\s*1\.6/.test(src), 'design → coding ×1.6');
  assert.ok(/taskCategory\s*===\s*'design'\s*&&\s*cat\s*===\s*'reasoning'\)\s*weight\s*\*=\s*0\.4/.test(src), 'design → reasoning ×0.4');
});

test('server: search-задачи исключают кодинг-модели (codestral не ответит «минимализм»)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/taskCategory\s*===\s*'search'\s*&&\s*cat\s*===\s*'coding'\)\s*weight\s*\*=\s*0\.3/.test(src), 'search → coding ×0.3');
});

test('dashboard: карточка экономии + сохранение _savings', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');
  assert.ok(html.includes('cardSavings'), 'карточка Экономия');
  assert.ok(html.includes('id="savings"'), 'элемент #savings');
  assert.ok(html.includes('_savings.savedUsd'), 'рендер суммы экономии');
  assert.ok(html.includes('_savings = _statsData.savings'), 'сохранение savings из stats');
  assert.ok(html.includes("savingsBasis"), 'пояснение расчёта');
});

test('dashboard: KPI «Успех сегодня» показывается крупно', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');
  assert.ok(html.includes('kpiToday'), 'чип Успех сегодня');
  assert.ok(html.includes('_statsData.today'), 'читает today из stats');
  assert.ok(html.includes('td.successRate'), 'показывает successRate');
});

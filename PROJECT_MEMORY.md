# Freegate — Project Memory (обновлено 0.6.29)

Актуальное состояние. Читай ПЕРЕД изменениями. Историю прошлых итераций сознательно сжал — важно текущее.

## Архитектура
- **Прокси** Node.js zero-dep. Ядро: `server.js` (роутинг/стрим/выбор провайдера) + `lib/*`.
- **Провайдеры**: каталог `providers.json` (65 моделей), пользовательские — `config.json` (overlay). Ключи ТОЛЬКО в `.env` (gitignored). `state.json`/`models-db.json`/`cache.json`/`diag_history.json` — runtime (gitignored).
- **Алиасы**: `tier-s` (быстрая), `tier-splus`/`tier-l` (мощная), `tier-xl` (окно). Маппинг в `lib/providers.js` MODEL_MAP. Актуально (0.6.29): `tier-splus→or-dots-3`, `tier-xl→or-dots-3`, `tier-l→or-minimax-m3-free`, `tier-s→mistral-codestral`.
- **Отдельно**: генератор шортс (`tools/`, Python) — не связан с роутингом.

## Ключевые решения (текущие)
- **Health через `/models`** (не реальный запрос) — не жечь дневные лимиты.
- **Ретраи НЕ при 429/401/404**; кап latency 60с.
- **target-first цепочка**: алиас идёт на мапп-провайдера первым; при `targetBurned` (429/лимит ≥90%) или `targetMismatch` (search/chat на coding-модель) — скип.
- **Крутящийся пул по дневным лимитам**: выгоревшие исключаются (`exemptables`), штраф ×0.03/×0.4.
- **Окно-роутинг** (`WINDOW_SAFETY=2.0`, `MIN_WINDOW=50k`): большие запросы только на провайдеров с достаточным окном; `needsWindowUpgrade()` — апгрейд при `est > win×1.5`.
- **Анти-замирание**: провайдер с ошибками/день ≥15 исключается из пула (fallback если пул пуст).
- **Кэш**: TTL 24ч + семантический (char-trigram dice 0.85) в `lib/cache.js`+`lib/semcache.js`. **tool-запросы обходят кэш** (не кэшируются как текст — иначе агент не получал инструменты).
- **Очистка ответа** (`lib/clean.js`): stripThink, fixReasoningMessage (reasoning→content), isTooShort учитывает tool_calls.
- **Компакция прокси ОТКЛЮЧЕНА** (`config.compacter.enabled=false`): её делает КЛИЕНТ (opencode auto-compaction). Константы `lib/compactor.js`: `CHARS_PER_TOKEN=3.5`, `COMPACT_THRESHOLD=60000`, `KEEP_RECENT_TOKENS=12000`, `MAX_COMPACT_THRESHOLD=200000`, `compactionThresholdFor = min(win*0.5, 200k)`. Логика окна/апгрейда остаётся в server.js.
- **Умные слои**: `taskclassify` (coding/reasoning/search/chat/design), `methodology` (системный промпт-методолог), `websearch` (DuckDuckGo для search), `vetting` (самопроверка), `compress` (Caveman), `strategy` (weighted/roundrobin/least), `bandit` (обучение выбора).
- **Телеметрия**: `lib/contextstats.js` (бакеты час|провайдер, категории задач, окна), `lib/health.js` (stats, errors, dailyUsage), `lib/diagmonitor.js` (снапшоты каждые 30м в diag_history.json), CLI `npx freegate diag`.
- **Автообновление**: `config.autoUpdate.enabled` → git fetch + ff-pull + рестарт launchd (для git-установки, НЕ для Docker). `lib/autoupdate.js`.
- **Автопоиск моделей**: `config.modelManager` (6ч) — `lib/modelmanager.js`+`modelscan.js`+`modeldb.js`. `isAutoAddable` — только гарантированно бесплатные.
- **Дашборд** (`lib/dashboard.js`): RU/EN, KPI-полоска, табы Обзор/Провайдеры/Модели/Контекст/Диагностика/Настройки. Версия в сайдбаре. `scripts/set-model-version.js` прокидывает версию в имя модели opencode (`Freegate (Best · vX)`).

## ГЛАВНАЯ ПРОБЛЕМА (текущая)
**Агент «останавливается» на больших контекстах (138k).** Диагностировано: это НЕ прокси (отвечает 200, 3-5с, без ошибок). Причины:
1. tool-выводы в opencode НЕ обрезаются (`tailscale tail -60`, огромные стеки, повторяющиеся `poll error 409`) → контекст раздувается мусором до 136-138k.
2. free-модели на таком контексте деградируют: не вызывают tool_calls, уходят в думание (`content=0, tools=False, fin=length`). Проверено на dots-3/gemini/minimax — все одинаково.
**Решение (клиентская сторона, не прокси):** обрезать длинные tool-выводы в opencode; короче сессии; или `paid-fallback` (платный ключ держит tool на больших контекстах).

## Известные проблемы
- **10 падающих тестов contextstats** (`TypeError: reading 'compactCount'`) — `measure.compacted`/`measure.sentTokens` не передаются в тестах. Предсуществующее. Починить.
- Одиночное гигантское сообщение не компактится (`old.length===0`).
- Gemini часто 429; многие free-модели OpenRouter 404 (реально работает только dots-3 из больших окон).
- `providers.json` runtime-пересортировка приоритетов автопоиском → не коммитить, `git checkout providers.json`.
- `estimateTokens = chars/CHARS_PER_TOKEN` занижает для кода (повторяющиеся символы) — окно-эвристика хрупкая.

## Тесты
- `node --test test/*.test.js` → **316 pass / 326** (10 fail contextstats).
- Перед релизом: `node --check server.js lib/*.js` + тесты.

## Публикация
- npm: `npm publish` (ключ в ~/.npmrc). Docker: `docker build -t nik951751/freegate:VERSION . && docker push`. GitHub: `git push` + `gh release create vX`. Версия в имя модели: `node scripts/set-model-version.js`.
- Локальная установка: launchd `com.free-llm-proxy`, live-проверка `launchctl kickstart -k gui/$(id -u)/com.free-llm-proxy` + `curl /v1/stats`.
- Рабочая папка: `/Users/sid/.config/opencode/llm-proxy`, ветка `main`, origin Artur21101965/freegate.

## Карта проекта
```
server.js               — ядро: HTTP, роутинг, стрим, выбор провайдера, window-upgrade
lib/
  providers.js          — PROVIDERS (каталог в память), MODEL_MAP (тир→провайдер), callProvider, sanitizeBody
  routing.js            — classifyComplexity, maybeUpgradeTier, needsWindowUpgrade
  strategy.js           — weighted/roundrobin/least модификаторы веса
  cache.js              — LRUCache (TTL 24ч, семантический через semcache/normalize)
  semcache.js           — семантический кэш (char-trigram dice)
  clean.js              — stripThink, fixReasoningMessage, isTooShort (учитывает tool_calls)
  compactor.js          — компакция (ОТКЛЮЧЕНА по умолчанию), estimateTokens, compactionThresholdFor
  health.js             — stats, health, errors, dailyUsage, bandit, context, recent
  contextstats.js       — телеметрия бакетов час|провайдер, категории задач
  modelmanager.js       — автопоиск моделей (6ч), isAutoAddable
  modelscan.js          — адаптеры источников (SOURCES/SOURCE_META)
  modeldb.js            — ModelDB (models-db.json), computeScore
  taskclassify.js       — категория задачи (coding/reasoning/search/chat/design)
  methodology.js        — системный промпт-методолог
  websearch.js          — DuckDuckGo поиск для search-задач
  vetting.js            — самопроверка ответа второй моделью
  compress.js           — Caveman-сжатие промпта
  bandit.js             — Thompson sampling выбор провайдера
  setup.js              — KEY_GROUPS, validateKey, saveKeys
  doctor.js / diag.js   — CLI-аналитика (snapshot, buildReport)
  diagmonitor.js        — снапшоты метрик каждые 30м (diag_history.json)
  autoupdate.js         — git update + рестарт (config.autoUpdate)
  dashboard.js          — HTML-дашборд (RU/EN, табы, /v1/setup/*)
bin/freegate.js         — CLI: start/diag/doctor/connect/init/dashboard/status
tools/                  — Python-генераторы шортс (отдельно от роутинга)
test/*.test.js          — 326 тестов; 316 pass, 10 fail (contextstats)
```

### Эндпоинты
`/v1/chat/completions` (основной), `/v1/models` `/v1/models-db` `/v1/recent` `/v1/rpm` `/v1/stats` `/v1/config` `/v1/reload` `/v1/cache/clear` `/v1/setup/keys` `/v1/setup/validate` `/v1/shorts`.

### CLI
`start` `status` `diag` `doctor` `connect` `init` `dashboard` `test` `themes` `install-service` `version`.

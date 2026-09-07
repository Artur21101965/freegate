# Freegate — Agent Rules

Этот прокси (Node.js, zero-dep) роутит запросы от opencode на десятки бесплатных LLM-провайдеров с авто-failover.

## Работай по superpowers
- **TDD**: сначала тест (убедись что падает), потом реализация. Не пиши код без проверки.
- **verification-before-completion**: НЕ говори «готово» без запущенной проверки. Покажи команды + вывод.
- **systematic-debugging**: гипотеза → проверка → фикс. Не гадай, докажи фактом.
- **requesting-code-review**: проверяй по факту, категоризируй Critical/Important/Minor.

## Железные правила проекта
0. **`.env`, `config.json`, `state.json`, `models-db.json`, `cache.json`, `diag_history.json`** — gitignored. НИКОГДА не коммить и не выводи их содержимое (секреты).
1. **`providers.json`** пересортировывается автопоиском в рантайме (приоритеты). Если изменился только priority — НЕ коммить, откати: `git checkout providers.json`. Коммить только осмысленные изменения каталога.
2. **Всегда** `node --check server.js lib/*.js` + `node --test test/*.test.js` перед коммитом. Сейчас 316/326 (10 предсуществующих fail в contextstats — не регрессия).
3. **Компакция в прокси ОТКЛЮЧЕНА** (`config.compacter.enabled=false`). Её делает клиент (opencode). НЕ вставляй обратно — агент теряет рабочий контекст.
4. **tool-запросы обходят кэш** — не кэшируй tool_calls-ответы как текст (иначе агент «замирает»).
5. **Параметры моделей/провайдеров** — не «улучшай» эвристику оценки токенов вслепую. `estimateTokens` хрупкий, окно-роутинг от него зависит.
6. **Тройной слой**: прокси / opencode (клиент) / модель. Если «агент остановился» — сначала проверь, отвечает ли прокси (`/v1/stats`, `last_selection`, лог `[REQ]`). Ответ = прокси здоров, причина в клиенте/модели.
7. **Живой сервер**: `launchctl kickstart -k gui/$(id -u)/com.free-llm-proxy`. Проверка: `curl "http://localhost:4000/v1/stats?key=free-llm-proxy-2024"`.

## Контекст
- Рабочая папка: `/Users/sid/.config/opencode/llm-proxy`, ветка `main`.
- Каталог: `providers.json` (65 моделей). Ключи: `.env`. Настройки: `config.json`.
- Память проекта + карта: **PROJECT_MEMORY.md** — читай перед изменениями.
- Версия модели в opencode: `Freegate (Best · vX)` (обновляется `node scripts/set-model-version.js`).

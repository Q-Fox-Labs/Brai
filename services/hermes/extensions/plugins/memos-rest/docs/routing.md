# MemOS REST — Hermes provider

Плагин подключает штатный `MemoryProvider` к существующему локальному MemOS. Не создаёт кубы автоматически, не меняет сервис/БД/эмбеддинги и не запускает deployment. Старый single-cube JSON без `routing_enabled` остаётся legacy-режимом.

## Multi-cube режим

Нейтральные файлы:

- `taxonomy.json`: полные смысловые инструкции 12 сфер, остаточного `user` и технического `infra`;
- `catalog.defaults.json`: пустые проекты/привязки, совместное чтение infra выключено;
- `routing.defaults.json`: пример **frozen/disabled setup**, не активная конфигурация.

Рабочие настройки: `$HERMES_HOME/memos-rest.json`. Каталог: `$HERMES_HOME/memos-catalog.json`. Multi-cube требует `routing_enabled: true`, явных `deployment_phase: setup` и `memory_epoch`, `generation`. Production допускается только при завершённом scoped `handoff` с совпадающим epoch. `enabled: false`, `suspended: true`, `frozen: true` блокируют запись. Disabled/suspended также блокируют инструменты recall/read; frozen оставляет чтение доступным.

Managed cubes: `main`, `life_work`, `life_society`, `life_systems`, `life_body`, `life_vividness`, `life_relationships`, `life_intellect`, `life_comfort`, `life_mission`, `life_capital`, `life_time`, `life_meaning`, `user`, `infra`, плюс только проекты из проверенного локального каталога.

Каталог проекта, например **только после явного создания соответствующего куба оператором**:

```json
{
  "version": 1,
  "projects": {"project_demo": {"description": "Тестовый проект"}},
  "session_projects": {"точный-gateway_session_key": "project_demo"},
  "shared_infra": false
}
```

Явный `project` в инструменте приоритетнее session binding. Непроверенные проекты отвергаются; текст не создаёт новые кубы. Автор/subject — отдельная ось, технический MemOS owner `root` не равен автору всех записей.

## Durable worker

`sync_turn` сохраняет scrubbed исходник в приватную outbox без сетевых/LLM-вызовов. Worker:

1. Проверяет live config, epoch/generation и session fence.
2. Архивирует полный оригинал в `main` через sync-fast API и проверяет read-back всех IDs/метаданных.
3. Вызывает настоящий semantic LLM router; фиксирует валидированный план в durable job **до** тематической доставки.
4. Создаёт атомарные факты в первичной сфере и управляемые копии во вторичных сферах/проекте. Копии имеют общий `hermes_logical_id`, memberships, author/subject, epoch/phase, source event/IDs/role/span.
5. Проверяет каждый commit и создаёт квитанцию только после завершения всей операции. При коррекции сначала проверяет новые копии, затем удаляет старые по точной локальной области и проверяет удаление.

LLM маршрутизирует по предмету, назначению и контексту; keyword/regex fallback отсутствует. Регулярные выражения используются лишь для допустимого slug/JSON fencing, не для сфер. Router исполняет только API-generation, не agent tools. Источники — user/assistant, поэтому `verified_done` всегда отвергается. Допустимы `idea`, `plan`, `decision`, `reported_done`, `observation`, `preference`, `unknown`. Ответ ассистента не доказывает завершённую операцию.

Grounding требует дословную source quote с соответствующей ролью. Если LLM ошибся в числовых offsets, единственный точный span находится детерминированно; отсутствующий/неоднозначный quote отвергается. Результат роутера повторно проходит Hermes secret scrub перед локальной/внешней записью.

При сбое роутера исходник остаётся доступен, `memos_read/search` показывают `pending/unclassified`, job повторяется. Если валидных фактов нет, оригинал остаётся recallable в main со статусом `unclassified`. Classification исходника вычисляется из локальной квитанции; backend metadata не обновляется неподдерживаемым endpoint.

Потерянный API-ответ восстанавливается по scoped event IDs, план и IDs переживают restart. Межпроцессный delivery lock и барьеры очереди защищают порядок replace/forget. Независимые ходы и сообщения Business могут проходить мимо неудачного события до первого барьера; неудачный ход остаётся в очереди и повторяется. Неизвестные и повреждённые операции не обходятся. Нет server-side idempotency transaction: абсолютное exactly-once при произвольных частичных commits backend не заявляется.

## Router / bridge

Параметры `router`: `base_url`, `model`, `env_file`, `api_key_env`, `timeout`.

Локально read-only проверены `/health` и authenticated `/v1/models`: модель `gpt-6-luna`. Связанный env-файл — `/etc/.secrets/memos/codex-bridge.env`, имя переменной `MEMOS_BRIDGE_TOKEN`; значение читается программно, не выводится и не хранится в JSON. Без `model` router использует первый advertised `/v1/models` ID. `/v1/chat/completions` — единственный генеративный endpoint. Ошибки sanitised, proxy для локальных запросов отключён.


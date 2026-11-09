# Diary

Сервис владеет записями дневника и устойчивыми заданиями их обработки.
[Карточка](../../docs/components/diary.md), [контракт](CONTRACT.md),
[HTTP](contracts/http.openapi.json), [MCP](contracts/mcp.json).

## Поток данных

Web → Diary → Artifacts original → Transcription → rawText в Diary →
отдельная Luna → correctedText + eventDate в Diary → Web/MCP.

`src/domain.mjs` задаёт переходы и проверяет результат редактора.
`store.mjs` владеет PostgreSQL и очередью; `adapters.mjs` подключает Auth,
Artifacts, Transcription и Luna. `main.mjs` собирает сервис и один worker.
Задание в БД необходимо, чтобы обработка переживала закрытие браузера и рестарт.

## Запуск

Требуются Node.js 24.22.1, PostgreSQL, NATS, настроенные Auth, Artifacts,
Transcription и существующий Codex app-server с доступной gpt-6-luna.
Отдельный runtime модели не устанавливается. Ключи и настройки экземпляра
не входят в Git.

`DIARY_CONFIG` указывает на закрытый JSON-файл. Runtime использует:
`host`, `port`, `origin`, `allowedHosts`, `maxAudioBytes`,
`appDatabaseUrl`, `workerDatabaseUrl`, `nats` (options клиента),
`artifactsUploadOrigin`, `artifactsInternalOrigin`,
`transcriptionOrigin`, `transcriptionToken`,
`mcpBindings` (token/userId/profileId), `luna` (socketUrl/cwd).
Адреса, токены и параметры доступа задаёт оператор.
Runtime не получает ownerDatabaseUrl.

До запуска оператор создаёт отдельную БД и три разные роли: owner, app и worker.
App и worker не имеют SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION
или membership других ролей. Миграция выполняется owner, владельцем этой БД.
Её отдельный `DIARY_CONFIG` содержит `ownerDatabaseUrl`,
`ownerRole`, `appRole`, `workerRole`.
Миграция предоставляет runtime-ролям CONNECT и необходимые права таблицы;
app ограничена RLS по владельцу, worker обрабатывает очередь всех владельцев.

```sh
DIARY_CONFIG=/secure/diary-migrate.json node src/migrate.mjs
DIARY_CONFIG=/secure/diary-runtime.json node src/main.mjs
```

Проверка `GET /health` подтверждает listener. Отдельно проверь
авторизованное чтение, загрузку и обработку: health не подтверждает модель или Auth.

Web получает только `DIARY_SERVICE_ORIGIN`; сессия проверяется в обоих сервисах.
Transcription требует собственную opt-in привязку `identity:delegate`.
Заголовок владельца или входное поле запроса такую привязку не заменяют.

## Подключение агента

`node src/stdio-proxy.mjs /secure/diary-personal.json` предоставляет три MCP
инструмента. Файл принадлежит root, недоступен для записи группе и чтения остальным;
он содержит только `url` (локальный HTTP endpoint `/mcp`) и `token`.
Серверная привязка токена задаёт пользователя и профиль; каждый запрос дополнительно
проверяет активность в Auth. Один токен нельзя использовать как общий для разных людей.

## Операторское продолжение ASR

После устранения причины сбоя оператор может явно продолжить ту же запись без повторной загрузки.
`src/retry-transcription.mjs entryId previousRequestId retryId inspect|apply` использует
защищённый DIARY_CONFIG; повтор той же операции сохраняет retryId. Условия и гарантии
описаны в [контракте](CONTRACT.md#обработка-и-завершение). Перед apply нужно проверить
предыдущий исход, поддержку контейнера и фактические ограничения длительности и времени
вычисления установленного Local AI. Одного исправления MIME для длинного аудио недостаточно.

## Проверки

`npm test --workspace=@brai/diary` выполняет локальные проверки.
`DIARY_TEST_PG_URL` включает отдельный PG/HTTP/MCP fixture; он принимает только
`127.0.0.1:15489/diary_fixture`. Его соседние порты синтетические;
он не подтверждает настоящий ASR или модель. Реальные модели и полный браузерный
путь проверяются отдельно на тестовом аккаунте. Состав поставки задаёт
[component.json](component.json).

Резервирование требует согласованного состояния собственной БД и Artifacts.
Копии исходников и Git не являются резервной копией личных записей.

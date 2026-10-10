# Artifacts: хранение и мигратор

Внешний контракт — [CONTRACT.md](CONTRACT.md). Публичные DTO и wire-проверки экспортирует `@brai/artifacts/contracts`. Ядро принимает локальные операции; NATS, HTTP и MCP подключаются отдельными входными адаптерами.

## Сборка ядра

```ts
const files = await createFileStore(dataRoot);
const store = createPostgresStore(pool);
const core = createArtifactsCore({store, files, config});
```

`pool` принадлежит сборке процесса. Задайте `connectionTimeoutMillis` и конечный `max`; закрывайте его после завершения текущих операций. Адаптер ограничивает ожидание advisory lock 5000 мс и запрос 10000 мс. Параметры меняются через `createPostgresStore(pool, {lockTimeoutMs, queryTimeoutMs})`. При неизвестном исходе запроса соединение удаляется из pool; автоматического повтора DML нет.

Экспорты лежат в `src/core.ts`, `src/ports.ts`, `src/errors.ts`, `src/files.ts` и `src/postgres.ts`; сборка создаёт соответствующие `dist/*.js` и `*.d.ts`. Ядро импортирует только типы публичного контракта, стандартную криптографию и свои порты. В нём нет PostgreSQL, FS, NATS или HTTP.

| Метод | Вход и результат |
| --- | --- |
| `execute(operation, request)` | Локальные имена `prepare`, `get`, `update`, `list`, `stats`, `delete`, `relationAdd`, `relationRemove`, `relationList`, `referenceReserve`, `referenceGet`, `referenceConfirm`, `referenceList`, `referenceUpdateState`, `outputBind`, `outputList`, `linkCreate`, `linkRevoke`; запросы и ответы из внешнего контракта |
| `upload(token, source, signal?)` | `AsyncIterable<Uint8Array>`; после сохранения возвращает ready `Artifact` |
| `downloadable(artifactId)` | Проверяет готовность, возвращает `Artifact`; содержимое читает входной адаптер |
| `shared(token)` | Проверяет разрешение, срок, отзыв и готовность; возвращает `Artifact` |
| `reconcile()` | Возвращает счётчики `{ready, failed, deleted, temps}`; занятую загрузкой запись пропускает |

Транспорт сопоставляет subject с локальным именем и проверяет запрос/ответ через контракт владельца. Ядро отдельно проверяет прикладные ограничения, включая неизменяемого владельца. `ArtifactError` содержит безопасные `code` и HTTP `status`; `cause` может содержать данные драйвера и не предназначен для журнала.

## Конфигурация ядра

Обязательны `uploadBaseURL`, `internalBaseURL`, `maxUploadBytes` и `staleTempAgeMs`. Байты и миллисекунды задаются отдельно от лимитов модели и NATS. `externalBaseURL` необязателен: без него sharing возвращает `SHARING_NOT_CONFIGURED`.

| Предел | По умолчанию |
| --- | ---: |
| `maxResultBytes` | 1 MiB |
| `maxPageSize`, `maxReferenceItems`, `maxReferenceAttachments`, `maxRelations` | отсутствуют; необязательные ограничения локального caller |
| `reconcileBatchSize` | 100 |

Runtime передаёт `ARTIFACTS_MAX_NATS_RESPONSE_BYTES` как `maxResultBytes`. Ядро считает сериализованные UTF-8 байты каждого выходного DTO и итогового ответа; переполнение даёт `PAYLOAD_TOO_LARGE` без скрытого усечения. PostgreSQL отдаёт list, relations, references и output bindings через cursor пачками по 16 записей; память ограничена бюджетом ответа и одной пачкой, а прекращение чтения закрывает cursor и транзакцию. List сохраняет единый repeatable-read snapshot для total и страницы. Большой requested limit на пустой или малой странице допустим. Входные attachments, nativeItemIds, output artifactIds и itemIds ограничены wire bytes; явные локальные count limits сохраняют прежнюю проверку до обращения к портам. Сверка читает незавершённые записи страницами по ID и обходит temp последовательно. Сборка процесса запускает сверку при старте и периодически; само ядро не создаёт фоновых таймеров.

Ограничения длины строк считают Unicode code points, как JSON Schema. PostgreSQL не поддерживает NUL и непарные UTF-16 surrogates в текстовых/JSON значениях и ключах; такие входы дают `INVALID_ARGUMENT`, а не ошибку доступности хранения. Иные ошибки драйвера не переклассифицируются в ошибку клиента.

## Файлы и восстановление

`dataRoot/files/{artifactId}` содержит опубликованные файлы, `dataRoot/tmp/{artifactId}.{uuid}.part` — временные. Исходное filename остаётся метаданными. Caddy получает доступ только к `files/`; его группа должна читать директорию 0750 и файлы 0640. `tmp/` имеет режим 0700, временные файлы — 0600. Обе директории должны находиться на одном томе с поддержкой hard links и fsync.

Поток записывается последовательно порциями до 64 KiB без накопления тела. Отмена прекращает ожидание зависшего producer и очищает temp. Producer должен учитывать свой signal; ядро не может остановить стороннюю работу внутри произвольного async iterator.

После fsync файла ядро сохраняет намерение публикации с размером и SHA-256. FS публикует готовый inode через atomic hard link без перезаписи и подтверждает fsync директории. Затем фиксируется `ready`. Отмена клиента после публикации не отменяет сохранённые байты: ядро завершает запись, а неизвестный клиенту исход проверяют через `get`. Повтор загрузки ready ID даёт `CONFLICT`.

Сверка завершает намерение, если опубликованные байты совпадают с размером и SHA-256. Если файл отсутствует или не совпадает, запись становится `failed`; неизвестные опубликованные байты не удаляются автоматически. Готовые файлы и посторонние имена также не очищаются. Просроченные temp удаляются под той же межпроцессной блокировкой, поэтому активный поток защищён от очистки.

Удаление фиксирует `deleting`, закрывая внешние разрешения, затем unlink и fsync, затем `deleted`. После перезапуска сверка продолжает `deleting`. Размер, SHA-256, связи, references и output bindings остаются. Успех удаления означает отсутствие байтов и сохранённый `deleted`; связанный оригинал или копия автоматически не удаляется. Внутренний Caddy до unlink может отдавать файл, как указано в контракте.

Output bindings хранятся отдельно от входящих references. `outputBind` проверяет owner и ready только при первой записи, сериализуется с удалением и повторяется безопасно после lost ACK. `outputList` отдаёт прежние связи даже после удаления байтов; внешний доступ всё равно проверяет состояние Artifact. Миграция 002 добавляет эту таблицу к существующей версии 001 без изменений incoming ledger.

## Мигратор

Мигратор запускается отдельным процессом после сборки:

```sh
ARTIFACTS_DATABASE_URL=<owner connection> \
ARTIFACTS_OWNER_ROLE=<database owner> \
ARTIFACTS_APP_ROLE=<runtime role> \
npm run migrate --workspace @brai/artifacts
```

Роли и отдельную БД заранее создаёт оператор. Мигратор требует, чтобы текущая роль была владельцем текущей БД. Роли должны различаться, не иметь повышенных атрибутов или членства в других ролях. Проверки идут до DDL; миграция и права применяются одной транзакцией. Повтор безопасен.

Схема `artifacts` владеет таблицами `artifacts`, `artifact_links`, `artifact_relations`, `artifact_references`, `artifact_output_bindings` и таблицей версий. Runtime получает CONNECT, USAGE, SELECT и INSERT на пять прикладных таблиц. Output bindings доступны только для SELECT/INSERT; UPDATE выдан только на изменяемые колонки остальных таблиц, DELETE — только для relations. Он не получает DDL, доступ к версии миграций, изменение владельца или удаление истории. Runtime мигратор не импортирует.

## Проверки

`npm test --workspace @brai/artifacts` выполняет контрактные, независимые core и реальные FS проверки. `ARTIFACTS_TEST_ADMIN_URL=... npm run test:integration --workspace @brai/artifacts` использует только явно заданный тестовый PostgreSQL `127.0.0.1:25541/brai_artifacts_test`; suite создаёт отдельные БД/роли с собственным suffix и удаляет их после проверок.

Проверяются реальные аварийные выходы отдельного процесса до/после публикации и после unlink, параллельные загрузки, атомарное резервирование из восьми процессов, конкуренция delete/reserve, потеря PG-соединения во время незавершённого потока и неизвестный исход lock timeout. Временные файлы тестов лежат в `/tmp`. Это проверка отдельного стенда; production миграции не выполняются.


## Runtime NATS + HTTP

`npm run build --workspace=@brai/artifacts` собирает `dist/main.js`. Runtime проверяет уже созданную схему PostgreSQL, создаёт каталоги `files/` и `tmp/`, запускает NATS Service и HTTP listener, затем выполняет сверку незавершённых записей. DDL выполняет только отдельная команда `migrate`; startup его не вызывает. Caddy самостоятельно обслуживает внутренние `GET/HEAD /files/{artifactId}` из `ARTIFACTS_DATA_DIR/files` и поддерживает Range/условные запросы. Node runtime не проксирует внутренние файлы.

Обязательные переменные:

| Переменная | Значение |
| --- | --- |
| `ARTIFACTS_DATABASE_URL` | URL отдельной БД artifacts с правами runtime роли |
| `NATS_URL` | Один или несколько NATS адресов, через запятую |
| `ARTIFACTS_DATA_DIR` | Корень принадлежащего сервису файлового тома |
| `ARTIFACTS_UPLOAD_BASE_URL` | HTTP адрес загрузки, который получит вызывающий `prepare`; для браузера это тот же origin Brai с маршрутом `/upload/{token}` |
| `ARTIFACTS_INTERNAL_BASE_URL` | Явный доверенный адрес Caddy для постоянного внутреннего `internalUrl` |

NATS credentials необязательны: `NATS_USER`, `NATS_PASSWORD`; `NATS_INBOX_PREFIX` по умолчанию `_INBOX.brai_artifacts`. Sharing включается только с явно заданным `ARTIFACTS_EXTERNAL_BASE_URL`. Внешний URL никогда не используется вместо внутреннего.

`ARTIFACTS_HTTP_HOST` по умолчанию `127.0.0.1`, `ARTIFACTS_HTTP_PORT` — `3004`. Конечные положительные пределы настраиваются через `ARTIFACTS_MAX_UPLOAD_BYTES` (2 GiB, больший предел запрещён), `ARTIFACTS_MAX_CONCURRENT_UPLOADS` (4, допустимы 1–4), `ARTIFACTS_MAX_CONCURRENT_NATS` (32), `ARTIFACTS_MAX_NATS_REQUEST_BYTES` (128 KiB), `ARTIFACTS_MAX_NATS_RESPONSE_BYTES` (1 MiB), `ARTIFACTS_UPLOAD_TIMEOUT_MS` (30 min, абсолютный deadline), `ARTIFACTS_RECEIVE_TIMEOUT_MS` (30 s простоя), `ARTIFACTS_REQUEST_TIMEOUT_MS` (15 s), `ARTIFACTS_LOCK_TIMEOUT_MS` (5 s), `ARTIFACTS_QUERY_TIMEOUT_MS` (10 s), `ARTIFACTS_RECONCILE_INTERVAL_MS` (60 s) и `ARTIFACTS_STALE_TEMP_AGE_MS` (1 h). PostgreSQL pool ограничен 8 подключениями с 5-секундным connect timeout. Upload limit сервиса независим от ограничений клиента/модели.

`GET /health` проверяет собственную таблицу artifacts, обе директории файлового тома с правами чтения/записи/обхода и состояние NATS; `npm run health --workspace=@brai/artifacts` опрашивает этот маршрут. При SIGINT/SIGTERM runtime прекращает новые запросы, отменяет незавершённые входящие upload streams и ждёт текущие NATS вызовы и сверку в пределах `ARTIFACTS_REQUEST_TIMEOUT_MS`. Если NATS соединение не отвечает к этому сроку, runtime закрывает собственное соединение; результат операции, которая успела изменить данные, может быть неизвестен клиенту и восстанавливается чтением или точным повтором по контракту. Затем закрываются HTTP и PostgreSQL. Если публикация файла уже завершилась, остановка сохраняет ready объект.

Request timeout не превышает 2147482647 ms: HTTP shutdown резервирует ещё 1000 ms. Upload/receive/reconcile/query/lock timers не превышают 2147483647 ms, чтобы Node не превратил переполнение в 1 ms. Возраст stale temp не является платформенным таймером. Sharing deadline охватывает проверку разрешения, open/stat и передачу; поздно открытый после deadline descriptor закрывается, включая HEAD.

Журналирует результат, код ошибки и длительность вместе с endpoint/executor и известным requestId. Тела, метаданные, имена файлов, upload token и внешние URL не журналируются.

## MCP Streamable HTTP

MCP запускается отдельной командой `npm run mcp --workspace=@brai/artifacts` после общей сборки. Он подключается только к NATS и не требует `ARTIFACTS_DATABASE_URL` или `ARTIFACTS_DATA_DIR`. Все 18 tools соответствуют операциям `CONTRACT.md`; вызовы и проверка ответов идут по фиксированным NATS subjects. MCP не принимает и не возвращает байты файлов: `prepare` выдаёт HTTP upload URL для стандартного PUT.

По умолчанию сервер слушает `127.0.0.1:3005` и использует `/mcp`. Настройки NATS общие: `NATS_URL`, необязательные `NATS_USER` и `NATS_PASSWORD`; inbox prefix `NATS_INBOX_PREFIX` по умолчанию `_INBOX.brai_artifacts_mcp`. Параметры HTTP: `ARTIFACTS_MCP_HOST`, `ARTIFACTS_MCP_PORT`, `ARTIFACTS_MCP_ALLOWED_HOSTS` и `ARTIFACTS_MCP_ALLOWED_ORIGINS`. При bind вне loopback укажите оба allowlist; внешнюю публикацию endpoint отдельно не настраивает.

Конечные пределы: запросы 128 KiB, ответы NATS 1 MiB, 16 параллельных вызовов, 64 сессии с очисткой после 5 минут простоя, deadline запроса 15 секунд и bounded остановка 5 секунд. Их можно задать через `ARTIFACTS_MCP_MAX_REQUEST_BYTES`, `ARTIFACTS_MCP_MAX_RESPONSE_BYTES`, `ARTIFACTS_MCP_MAX_CONCURRENT`, `ARTIFACTS_MCP_MAX_SESSIONS`, `ARTIFACTS_MCP_SESSION_IDLE_MS`, `ARTIFACTS_MCP_REQUEST_TIMEOUT_MS` и `ARTIFACTS_MCP_STOP_TIMEOUT_MS`. MCP не повторяет команды автоматически; после timeout для изменения данных исход может быть неизвестен.

`ARTIFACTS_TEST_ADMIN_URL=... ARTIFACTS_TEST_NATS_URL=... npm run test:integration --workspace=@brai/artifacts` проверяет настоящий MCP SDK client на изолированных loopback fixtures. Тест создаёт собственную БД и роли с суффиксом процесса и удаляет их по завершении.

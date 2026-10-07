# Кандидатный выпуск Brai Transcription

Этот документ описывает сборку и пробный запуск текущего кандидата. На
изолированном окружении приняты настоящий coordinator, три дочерние программы,
PostgreSQL, artifacts/history, публичные HTTP/MCP/NATS операции, реальное
распознавание через local-ai и шесть сценариев восстановления после перезапуска.

## Состав и запуск

В workspace есть четыре скомпилированные программы:

| Программа | Команда | Назначение |
| --- | --- | --- |
| Helper | `npm run start:helper --workspace=@brai/transcription` | Stdio JSON-RPC, metadata и PostgreSQL |
| Coordinator | `npm run start:coordinator --workspace=@brai/transcription` | Единственный ingress; сам запускает ровно три дочерние stdio программы |
| Local executor | `npm run start:local --workspace=@brai/transcription` | Stdio JSON-RPC и отдельный NATS клиент local-ai |
| External executor | `npm run start:external --workspace=@brai/transcription` | Явный ответ `EXTERNAL_ROUTE_UNAVAILABLE` |

Обычный кандидатный запуск — один coordinator. Он запускает helper, local и
external как дочерние процессы с отдельными allowlist окружения; второй helper
или executor вручную вместе с ним не поднимать. Отдельные команды нужны для
диагностики и самостоятельных проверок. External провайдеров и notifications в
этом выпуске нет.

Одновременно работает только один coordinator. `TRANSCRIPTION_INSTANCE_ID`
обозначает конкретный процесс и должен быть новым при каждом запуске, включая
перезапуск той же версии. Стабильное имя установки для этого поля не подходит:
начальное восстановление отличает потерянный буфер по ID прошлого экземпляра.
Новый UUID можно задать явно при запуске уже подготовленного приложения:

```sh
TRANSCRIPTION_INSTANCE_ID="$(node --input-type=module -e 'import {randomUUID} from "node:crypto"; console.log(randomUUID())')" \
npm run start:coordinator --workspace=@brai/transcription
```

Миграцию запускают отдельно от приложения и под владельцем PostgreSQL:

```sh
TRANSCRIPTION_MIGRATION_TIMEOUT_MS=30000 \
TRANSCRIPTION_APP_ROLE=brai_transcription_app \
npm run migrate --workspace=@brai/transcription
```

Для этой команды `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` и `PGPASSWORD`
должны описывать существующую базу и её владельца. `PGUSER` обязан быть
владельцем базы, `TRANSCRIPTION_APP_ROLE` — заранее созданной отдельной
безопасной runtime-ролью. Timeout — положительное целое число миллисекунд.
Миграция создаёт только metadata-схему `transcription`; она не создаёт роли,
секреты или внешние сервисы. Runtime helper получает только credentials
application-role, переданные через `TRANSCRIPTION_HELPER_PG*`.

## Подготовка workspace и проверки

Пакеты не устанавливаются этой инструкцией. Используются Node/npm и зависимости,
уже подготовленные для текущего worktree по root lockfile. Перед проверками
штатная проверка worktree должна подтвердить общие package links без установки.

```sh
npm run typecheck:transcription
npm run build:transcription
npm run test:transcription
```

Ограниченный unit/contract/process набор явно содержит 14 файлов:

- `helper/tests/config.test.mjs`, `handlers.test.mjs`, `main-process.test.mjs`, `storage.test.mjs`;
- `tests/contracts/descriptors.test.mjs`, `executors.test.mjs`, `metadata.test.mjs`;
- `tests/coordinator/domain-core.test.mjs`, `recovery-controller.test.mjs`, `transport-assembly.test.mjs`, `transport.test.mjs`;
- `tests/executors/external/process.test.mjs`, `tests/local/adapter.test.mjs`, `tests/runtime/stdio-rpc.test.mjs`.

Защищённые fixture-тесты запускаются отдельно и только с их изолированными
реквизитами:

```sh
npm run test:integration:transcription:postgres
npm run test:integration:transcription:helper:rpc
npm run test:integration:transcription:nats
npm run test:transcription:metadata
npm run test:integration:transcription:asr
npm run test:integration:transcription:restart
```

Первая команда последовательно запускает два destructive теста storage/history
на изолированной PostgreSQL fixture. Helper RPC использует отдельную
application-role fixture. NATS проверка требует `TRANSCRIPTION_TEST_NATS=1` и
NATS endpoint/credentials из выделенной изолированной fixture; обычный unit
запуск её не включает. Metadata-проверка дополнительно требует `TRANSCRIPTION_TEST_METADATA=1`, собственные artifacts/history и полный coordinator config; она проверяет реальный отказ внешнего маршрута и доставку истории, без утверждения о распознавании. Ни одна из этих команд сама не поднимает fixture.

ASR требует `TRANSCRIPTION_TEST_ASR=1`, отдельный local-ai, установленную GigaAM
без переходного состояния и закрытый набор синтетических русских WAV в
`TRANSCRIPTION_TEST_ASR_FIXTURE_ROOT`. Холодный запуск (`null`, `unloaded` или
`error`) проверяет autoload; повторная проверка допускает уже готовую модель и
сохраняет её фактический ready. Такой тёплый запуск сам по себе не доказывает
холодный autoload; его приёмка требует отдельного холодного сценария.
Restart требует отдельную конфигурацию
с `TRANSCRIPTION_TEST_RESTART_READY=1`, полным selector в
`TRANSCRIPTION_TEST_RESTART_MODEL_JSON` и проверенным Ansible-контроллером
собственной history в `TRANSCRIPTION_TEST_RESTART_HISTORY_CONTROL`. Эти тесты
проверяют точные адреса и имена изолированного стенда; общие реквизиты сервера
для них не подходят. Они не входят в обычный набор из 14 файлов.

## Runtime asset closure

Запускать из корневого workspace: Node package imports и публичные owner assets
разрешаются относительно workspace, они не копируются в `dist`. Runtime closure
включает:

- `services/transcription/contracts/index.mjs`, `index.d.mts`, все JSON
  descriptors в `contracts/`, `schemas/messages.schema.json` и `methods.json`;
- `services/history/schemas/common.schema.json` и `messages.schema.json`;
- `services/artifacts/contracts/index.mjs` и
  `services/artifacts/schemas/messages.schema.json`;
- `services/local-ai/contracts/index.mjs`, `schemas/messages.schema.json` и
  `schemas/facts.schema.json`;
- `services/transcription/helper/migrations/001.sql`.

Coordinator и local executor загружают только опубликованные contracts
providers. При выпуске local-ai с best-effort историей runtime artifact transcription
должен включать новую owner `StatusResponse`: `state`, `components.database`,
`components.nats`, `components.executables`, `components.weights`. Поля
`components.history`, `components.outbox` и `outboxCounts` удалены. Owner
contracts и обе owner schemas local-ai обновляют одновременно; старый runtime
artifact не совместим с этим ответом. In-flight cancellation local executor
остаётся `supported: false`, `guaranteed: false`. Транскрипционный валидатор загружает history schemas. SQL migration
разрешается относительно `#transcription-contracts`; compiled и source helper
используют один canonical SQL. Не копировать owner схемы, descriptors,
validators или SQL в `dist` и не импортировать приватный код соседних сервисов.

## Настройка coordinator

Все обязательные настройки читаются из окружения coordinator. Числовые лимиты
должны быть положительными safe integers в десятичной записи; параметры,
используемые Node timers, не превышают `2147483647`. Нулевые значения и скрытые
значения по умолчанию не допускаются.

| Группа | Обязательные переменные |
| --- | --- |
| Идентификаторы и execution | `TRANSCRIPTION_INSTANCE_ID`, `TRANSCRIPTION_WORKER_ID`, `TRANSCRIPTION_MAX_EXECUTE_CONCURRENCY`, `TRANSCRIPTION_LEASE_RENEW_INTERVAL_MS`, `TRANSCRIPTION_DEFAULT_EXECUTION_TIMEOUT_MS`, `TRANSCRIPTION_RESULT_TTL_MS`, `TRANSCRIPTION_MAX_RESULT_COUNT`, `TRANSCRIPTION_MAX_RESULT_BYTES`, `TRANSCRIPTION_MAX_TOTAL_RESULT_BYTES` |
| Публичная аутентификация | `TRANSCRIPTION_AUTH_BINDINGS_JSON` — непустой JSON-массив уникальных bearer tokens и DTO trusted principals |
| HTTP/MCP | `TRANSCRIPTION_HTTP_HOST`, `TRANSCRIPTION_HTTP_PORT`, `TRANSCRIPTION_ALLOWED_HOSTS_JSON`, `TRANSCRIPTION_ALLOWED_ORIGINS_JSON`, `TRANSCRIPTION_HTTP_HEADER_BYTES`, `TRANSCRIPTION_HTTP_REQUEST_BYTES`, `TRANSCRIPTION_HTTP_RESPONSE_BYTES`, `TRANSCRIPTION_HTTP_REQUEST_TIMEOUT_MS`, `TRANSCRIPTION_HTTP_MAX_CONNECTIONS`, `TRANSCRIPTION_HTTP_CONCURRENT_REQUESTS` |
| Coordinator NATS | `TRANSCRIPTION_NATS_URL`, `TRANSCRIPTION_NATS_INBOX_PREFIX`, и либо пара `TRANSCRIPTION_NATS_USER` + `TRANSCRIPTION_NATS_PASSWORD`, либо `TRANSCRIPTION_NATS_TOKEN`; также `TRANSCRIPTION_NATS_REQUEST_BYTES`, `TRANSCRIPTION_NATS_RESPONSE_BYTES` |
| Dependency и worker limits | `TRANSCRIPTION_DEPENDENCY_REQUEST_TIMEOUT_MS`, `TRANSCRIPTION_MAX_CATALOG_ITEMS`, `TRANSCRIPTION_CATALOG_PAGE_SIZE`, `TRANSCRIPTION_RPC_FRAME_BYTES`, `TRANSCRIPTION_RPC_BATCH_ITEMS`, `TRANSCRIPTION_RPC_CONCURRENT_REQUESTS`, `TRANSCRIPTION_RPC_CONCURRENT_EXECUTE`, `TRANSCRIPTION_RPC_CONTROL_TIMEOUT_MS`, `TRANSCRIPTION_CHILD_SHUTDOWN_TIMEOUT_MS` |
| Helper PostgreSQL и storage | `TRANSCRIPTION_HELPER_PGHOST`, `TRANSCRIPTION_HELPER_PGPORT`, `TRANSCRIPTION_HELPER_PGDATABASE`, `TRANSCRIPTION_HELPER_PGUSER`, `TRANSCRIPTION_HELPER_PGPASSWORD`, `TRANSCRIPTION_PG_POOL_MAX`, `TRANSCRIPTION_HISTORY_CAPACITY`, `TRANSCRIPTION_REQUEST_LEASE_MS`, `TRANSCRIPTION_HISTORY_LEASE_MS`, `TRANSCRIPTION_TRANSACTION_TIMEOUT_MS`, `TRANSCRIPTION_RECOVERY_BATCH_SIZE` |
| Recovery и history delivery | `TRANSCRIPTION_RECOVERY_MAX_BATCHES`, `TRANSCRIPTION_RECOVERY_CYCLE_TIMEOUT_MS`, `TRANSCRIPTION_RECOVERY_POLL_INTERVAL_MS`, `TRANSCRIPTION_HISTORY_MAX_DELIVERIES`, `TRANSCRIPTION_HISTORY_POLL_INTERVAL_MS`, `TRANSCRIPTION_PUMP_POLL_INTERVAL_MS` |

RPC limits удовлетворяют `CONCURRENT_EXECUTE < CONCURRENT_REQUESTS`, а domain
`MAX_EXECUTE_CONCURRENCY` не больше RPC `CONCURRENT_EXECUTE`. `MAX_RESULT_BYTES`
не больше `MAX_TOTAL_RESULT_BYTES`. Порты лежат в диапазоне 1–65535. Allowed
hosts и origins задаются непустыми JSON-массивами строк; origins должны быть
каноническими `http` или `https` origins. `TRANSCRIPTION_NATS_INBOX_PREFIX`
явно задаётся в разрешённом ACL namespace, например
`_INBOX.brai_transcription_coordinator`.

Локальная NATS зависимость на coordinator необязательна для честного degraded
режима. Когда local-ai подключён, обязательны отдельные переменные
`TRANSCRIPTION_LOCAL_AI_NATS_URL`, `TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX`,
`TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS`,
`TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS`,
`TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES` и реквизиты:
`TRANSCRIPTION_LOCAL_AI_NATS_USER` + `TRANSCRIPTION_LOCAL_AI_NATS_PASSWORD`
парой либо `TRANSCRIPTION_LOCAL_AI_NATS_TOKEN`. URL не должен содержать credentials. Inbox prefix задаётся явно под ACL;
для coordinator парсер требует `_INBOX.` и непустые subject tokens. Числовые
control/hop timeout не превышают `2147483647`; hop timeout ограничивает ожидание
одного NATS request, а исходный `deadlineAt` транскрипционного вызова передаётся
local-ai неизменённым. `TRANSCRIPTION_DEFAULT_EXECUTION_TIMEOUT_MS` нужно
согласовать с опубликованным `transport.maxRequestMs` local-ai: оставшийся
срок вызова не должен превышать предел владельца. Hop timeout может включать
отдельный запас на ответ и не меняет deadline. `requestId` local-ai сохраняет
ID запроса transcription, `operationId` — отличный от него ID попытки; ответ
проверяется по обоим идентификаторам. Endpoint, credentials, limits и prefix forwarded local
child явно; generic `NATS_URL` не является fallback.

ACL coordinator разрешает подписку на шесть metadata subjects из AsyncAPI,
его собственный inbox и стандартные `$SRV.PING`, `$SRV.INFO`, `$SRV.STATS`
(общие, с именем `brai_transcription` и с ID экземпляра), а также ограниченные
ответы на принятые запросы. Исходящие запросы — `brai.artifacts.v1.get` и
`brai.history.v1.append.transcription`. Отдельная local-ai identity разрешает
опубликованные owner subjects `models.list`, `invoke.transcribe`, `status`
и свой inbox; coordinator использует её для каталога, local child — для
выполнения и health. Публичный клиент имеет собственную identity и inbox,
а bearer token сопоставляется с trusted principal в конфигурации coordinator.

Local executor также требует общие `TRANSCRIPTION_RPC_*` limits. При полном
отсутствии local-ai URL он может стартовать с health
`configured=false, verified=false, available=false`; настроенный URL без
обязательного ACL prefix, control/hop timeout или response byte cap — ошибка
конфигурации.

Установленная поддерживаемая модель доступна для выбора и при `ready:false`:
local-ai загружает её при первом `invoke.transcribe`. Полный selector закреплён
до отправки; фактический флаг готовности каталога не меняется искусственно.

## Состояние и rollback

Текст результата хранится только в памяти coordinator до native TTL
`TRANSCRIPTION_RESULT_TTL_MS`. Перезапуск/потеря coordinator может сделать уже
выданный результат недоступным; metadata в PostgreSQL не содержит transcript.
Потерянный ответ executor не означает, что compute остановлен или может быть
безопасно повторён. Автоматического retry/fallback нет. После `unknown` клиенту
нужно явно начать новую операцию с новым request/idempotency key, понимая, что
предыдущая операция могла завершиться у provider.

Для rollback прекратить новые ingress-вызовы, штатно остановить coordinator и
его процессы, затем запустить прежнюю ревизию приложения. Оставить созданные
metadata schema/tables/settings и history outbox без изменений; не выполнять
ручной `DROP` в качестве rollback. Миграция additive и проверяет разделение
database owner/runtime роли.

## Результаты изолированной приёмки

| Проверка | Результат |
| --- | --- |
| Typecheck и сборка transcription | exit 0 |
| Ограниченный unit/contract/process набор | 98/98 |
| PostgreSQL storage и history delivery | 13/13 и 3/3 |
| Helper RPC под application-role | 6/6 |
| Реальный NATS Services transport | 1/1 |
| Полный metadata-путь coordinator/helper/artifacts/history | 1/1 |
| Реальный локальный ASR и lifecycle результата | 1/1 |
| Шесть restart-сценариев и общий wrapper | 7/7 |
| Отдельный artifact lifecycle/shutdown без вычисления | 1/1 |
| GigaAM: декодирование, VAD bridge и PCM timeline | 63/63 |

Metadata-проверка прошла семь HTTP/MCP методов и шесть NATS endpoints,
изоляцию владельца, настройки, внешний отказ и штатное завершение четырёх
программ. Миграция выполнялась владельцем базы; runtime helper использовал
application-role без DDL.

Реальная GigaAM обработала синтетическую русскую речь: WAV 3.445 с и 40.454 с,
включая VAD для длинного файла; отдельно проверена тишина. Холодный запуск
подтвердил installed `runtimeState:null` → autoload при первом invoke → READY.
Полный итоговый ASR выполнен на уже готовой модели: native 1/1, завершённое
тело теста и cleanup `NONE`. Тёплый итог не заменяет отдельную проверку холодного запуска.
Проверены оба идентификатора, строгий selector, nullable usage/cost,
metadata-only PostgreSQL/history, TTL, идемпотентность и новый явный ключ
после потери текста. Pending/deleted/чужой файл и отсутствующая модель не
вызвали скрытого распознавания. Unsupported MIME дал
`DEPENDENCY_UNAVAILABLE`, повреждённый WAV — `INVALID_ARGUMENT`.

Проверки перезапуска охватили первую отправку принятой ожидающей задачи,
неизвестный исход после устойчивого намерения и наблюдаемой отправки до
ответа local-ai, потерю уже вычисленного оперативного буфера, неизвестную
выдачу после разрыва HTTP и остановку/возвращение собственной history.
Наблюдение invoke подтверждает границу отправки/ожидания, без утверждения
о конкретном моменте работы CPU модели. Повторных вычислений не было;
доставка истории возобновилась с прежними event IDs. Новый запрос
потребовал новый ключ.

Operator controls стенда: longform maximum 120 с, decode timeout 30 с,
request deadline 120000 мс и отдельный hop timeout 135000 мс, память 8 ГиБ,
CPU quota 200%, concurrency 1. Эти значения описывают тестовый запуск,
не являются defaults продукта или измерением максимальной скорости модели.
Фактическая ASR проверена на WAV; model-free FFmpeg проверки других
контейнеров не подтверждают их модельное распознавание. Лексическая точность
и нагрузочная производительность не измерялись.

Стенд использовал отдельные PostgreSQL/NATS/artifacts/history/local-ai,
собственные синтетические входы и копии уже подготовленных публичных
моделей. Пакеты и модели не устанавливались и не скачивались.
Production-развёртывание требует отдельного поручения.

После приёмки собственный стенд удалён: unit/cgroups, контейнеры, тома,
сеть, защищённые входы и синтетические данные. Независимая проверка отсутствия
прошла 27/27; отдельная штатная Docker-проверка — 19/19. Worktree сохранён.

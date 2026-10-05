# Контракт сервиса local-ai

Владелец публичного API — `services/local-ai`. Draft-07 DTO находятся в `schemas/messages.schema.json`; строгие метаданные истории — в отдельной `schemas/facts.schema.json`. `asyncapi.yaml` ссылается на эти схемы, а `contracts/index.mjs` предоставляет валидаторы. Объекты закрыты: неизвестные поля отклоняются.

## Операции

| Subject | Назначение |
| --- | --- |
| `brai.local_ai.v1.models.list` | Читает локальный каталог с фильтрами по задаче, входу, выходу, языку, установленности и готовности. |
| `brai.local_ai.v1.models.get` | Возвращает карточку модели, включая известные ограничения, hardware requirements, параметры и состояния. |
| `brai.local_ai.v1.catalog.search` | Ищет публичные модели, явно отмечая неподдержанные local-ai профили. |
| `brai.local_ai.v1.models.install` / `operations.get` | Запускает установку закреплённой ревизии и читает её состояние в области owner. |
| `brai.local_ai.v1.models.configure` | Задаёт `idleUnloadSeconds`: число от 1 до 2 147 483 647 либо `null` для отключения таймера. Верхняя граница соответствует формату хранения SQL integer. |
| `brai.local_ai.v1.models.load`, `unload`, `remove` | Управляет явно выбранными model ID, revision и profile ID. |
| `brai.local_ai.v1.invoke.embed` | Принимает список текстов только в памяти и назначение `query`, `document` или `symmetric`. |
| `brai.local_ai.v1.invoke.transcribe` | Принимает ID аудиоартефакта. Схема не принимает аудиобайты, локальные пути или URL. |
| `brai.local_ai.v1.cancel` | Отдельно запрашивает отмену операции по operation ID и owner. |
| `brai.local_ai.v1.status` | Возвращает состояние NATS, БД, исполняемых файлов, весов, history и давления outbox. |

Входы с длительным выполнением имеют абсолютный `deadlineAt`. Истечение срока и явная отмена — разные исходы. Deadline ограничивает ожидание клиента, но не гарантирует, что исполнитель уже остановлен. Потерянный ответ оставляет исход неизвестным. NATS request/reply и перезапуск не обещают сохранение результата или однократное вычисление. Автоматический повтор и незаметная замена выбранной модели запрещены. Повтор `invoke` — новая попытка; для установки клиент сверяет состояние через `operations.get`.

Ответ вызова указывает фактически использованные model ID, revision и profile ID. Embedding возвращает только векторы; transcription — текст и поле `segments`, равное `null` либо содержащее временные смещения. Сегменты не обещают word timestamps. Runtime получает временный локальный путь только внутри приватного adapter callback.

## Карточка модели

Каталог отделяет декларативные возможности модели от исполненного профиля. Неподдержанные модели возвращаются с `supported: false`, `profileId: null`, пустым списком локальных операций и состоянием `unsupported`; это не обещание запуска найденной модели. Для поддержанного профиля указываются только закреплённые операции, входы, выходы, языки и параметры. Hardware requirements и пределы допускают `null`, пока их не измерили или не закрепили. Пустое или неизвестное значение не заменяется правдоподобным числом.

Файлы в карточке описываются относительным путём внутри источника, размером и SHA-256. Абсолютные пути установки не выдаются. Локальные directory paths хранятся только во внутренних installation records и передаются RuntimeFactory.

Первый профиль эмбеддингов сохраняет существующие 1024 измерения, Q8_0, mean pooling, L2-нормализацию и поисковую инструкцию. Это свойства существующего закреплённого профиля. Не измеренные CPU/RAM/скорость или пределы аудио не заявляются. Публичные настройки вызова ограничены назначением embedding; RPC executor не является частью этого API.

## Ошибки и NATS

NATS Services использует request/reply, queue group `brai_local_ai`, стандартные PING, INFO и STATS. Успешный ответ — прямой DTO. Ошибки содержат закрытый безопасный DTO `ErrorResponse` и заголовки `Nats-Service-Error` (код) и `Nats-Service-Error-Code` (числовой статус); ни одна часть ответа не раскрывает внутренние детали.

Коды ошибок перечислены в `ServiceErrorCode`: `INVALID_ARGUMENT`, `MODEL_NOT_FOUND`, `MODEL_NOT_INSTALLED`, `UNSUPPORTED_OPERATION`, `MODEL_IN_USE`, `INPUT_TOO_LARGE`, `RESULT_TOO_LARGE`, `BUSY`, `MODEL_LOAD_FAILED`, `ENGINE_UNAVAILABLE`, `DEADLINE_EXCEEDED`, `CANCELLED`, `ARTIFACT_NOT_AVAILABLE`, `DEPENDENCY_UNAVAILABLE`, `INSTALLATION_FAILED`, `REVISION_CONFLICT`, `NOT_SUPPORTED`, `INTERNAL`. Числовые пределы NATS, очереди, аудио и ответов устанавливаются только с принятым профилем runtime и фактической конфигурацией выпуска.

## История и приватность

Факты записываются рядом с соответствующим изменением состояния через транзакционный outbox и должны помещаться в ограничение service_history 65 536 байт. `facts.schema.json` разрешает только ID, область/владельца, model/revision/profile, operation, фазу, outcome, длительности, размеры и безопасный error code. Содержимое текстов, транскрипции, аудио, векторов, файлов, произвольных параметров и токенов отвергается. Вызовы используют `scope_type=user` и `scope_id=ownerId`; управление использует `scope_type=system` и `scope_id=local_ai`. Source задаётся доверенным NATS subject, а не телом события.

Список `type_id` сверён с живым history MCP: 902 download, 103 delete, 1201 execute, 1202 cancel, 301 transition, 1301 configure, 203 activate и 204 deactivate. Имена и описания типов принадлежат справочнику history.

Для admission вычисления outbox атомарно записывает принятие и резервирует место с заранее созданным ID терминального факта. Завершение заменяет резерв записью успеха, отказа, отмены или interrupted. Конечная ёмкость учитывает и ожидающие доставки события, и резервы; terminal fact не может быть вытеснен событием accepted. После перезапуска startup recovery фиксирует reserved операции как interrupted/unknown и не выполняет их повторно. Доставка использует lease claim token, поэтому просроченный отправитель не подтверждает новый claim. Постоянно отклонённое событие остаётся учтённым и влияет на статус outbox.

## Прикладные порты

`src/ports.ts` задаёт RuntimeFactory/RuntimePort, ArtifactPort, ModelIdleGuard, LocalAiStore и OutboxDeliveryPort. RuntimeFactory открывает только конкретную установленную revision/profile; `RuntimePort.exited` сообщает фактическую остановку процесса, а `close` должен быть безопасен при повторном вызове. ArtifactPort проверяет владельца и состояние ready, передавая рабочий путь только в callback и удаляя временную копию после его выхода. ModelIdleGuard сериализует удаление/выгрузку с активными и ожидающими вызовами. Ядро не зависит от NATS, SQL и внутренних модулей artifacts/history/runtime.

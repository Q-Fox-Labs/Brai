# Контракт Приёма v1

Приём владеет регистрацией, первичной классификацией, неизменяемым оригиналом,
снимками назначения и связью со сквозным процессом. Вход обоих режимов — JetStream.
Рабочий Telegram этим выпуском не переключается.

## Вход и доверие

Схема: [messages.schema.json](schemas/messages.schema.json), Draft-07.
Источник публикует в brai.intake.v1.ingress.<sourceId>. NATS ACL разрешает только
его subject. Runtime сопоставляет suffix с защищённым sources; source payload
обязан совпасть. ownerId не принимается от отправителя.
message.incoming допускает human; message.outgoing — agent и готовые artifact IDs.
event.recorded содержит recipient и payload; recipient входит в allowlist привязки.
operation.result и processing.resume адресуются существующему пакету владельца.
Unknown types, чужой owner, результат не назначенного исполнителя запрещены.

eventId устойчив в пределах источника. Хеш включает каноническое событие целиком,
сортирует ключи объектов и сохраняет порядок массивов. Строковые ID не меняются.
Одинаковый ключ/хеш возвращает прежнюю регистрацию; иной хеш — EVENT_ID_CONFLICT.
Это относится также к operation.result и processing.resume: их идентичность
фиксируется атомарно с изменением пакета. Повтор после потерянного Signal доводит
уведомление, не применяя переход повторно. Переход unknown → определённый результат
использует новый eventId и прежний operationId; общий ключ source/eventId не может
быть переиспользован обычным или другим управляющим событием.
Альбом — одно сообщение с упорядоченными вложениями. Новое содержимое имеет новый
eventId и revision; повтор вложения сохраняет своё место. Первый API не собирает
отдельные Telegram updates.

Для сообщения causationId может ссылаться на внутренний packet ID исходного
обращения; replyToMessageId — на сохранённое сообщение Входящих. correlationId
объединяет связанные сообщения без общего ожидающего родительского workflow.
Точные внешние Telegram IDs сохраняются в sourceRef.

## Передача ответственности

PubAck издателю означает сохранение брокером, не успешную обработку.
Приём сохраняет пакет, затем запускает intakeMessageV1 с ID intake/v1/<packetId>,
после подтверждения старта ACK входа. Разрыв COMMIT/start восстанавливает JetStream;
потерянный ACK переиспользует тот же процесс. БД защищает и после retention Temporal.
В режиме без Temporal ACK следует за PubAck выходной публикации.
forwarded не означает бизнес-завершение получателя.

Streams BRAI_INTAKE_INGRESS_V1 и BRAI_INTAKE_DISPATCH_V1: File, WorkQueue,
DiscardNew, MaxAge=0, MaxBytes=268435456, MaxMsgSize=131072, без MaxMsgs/PerSubject.
Durable intake_ingress: pull, Explicit ACK, AckWait=30s, MaxAckPending=8,
MaxDeliver=-1, filter brai.intake.v1.ingress.*. Получатели dispatch используют
непересекающиеся filters по своему recipientId и сохраняют ключ перед ACK.
Переполнение отклоняет новые публикации, сохраняя принятые. Приём не создаёт
и не исправляет broker resources; несовпадение — NOT_READY.
Переданные dispatch headers Brai-Owner-Id и Brai-Intake-Packet-Id назначает Приём;
только его runtime identity имеет право публиковать в эти subjects.
Временный отказ — NAK с задержкой 5s; во время handoff — working каждые 10s.
Невалидный вход ACK только после записи безопасного отказа без сырого payload.

## Отдельные процессы сообщений

Вход: контекст канала/расположение/правила → контакт → файлы → Входящие →
параллельно Hermes и Понимание → память.
Выход: контекст → проверка готовых файлов → Входящие →
параллельно Telegram-доставка и Понимание → память.
Hermes подтверждает свою операцию после надёжной публикации всех ответов в общий
вход. Входящий процесс не ждёт доставки этих ответов: у каждого отдельный workflow.
Аналитический результат является operation.result, не содержательным ответом.
Содержательный ответ не запускает новый пользовательский ход.

Внешние порты задаются адресами config. channel/contact/inbox возвращают
непустые channelId/rulesVersion/locationRef, contactId и messageId соответственно.
При channel передаётся asOf=receivedAt; возвращённые версии фиксируются.
Соседние сервисы обязаны сохранять устойчивый operationId и точное содержимое.
Вызовы изолированы NATS ACL; ownerId в вызове является доверенным контекстом
Приёма для downstream, а не полномочием произвольного издателя.

hermes/understand/memory/deliver принимают job с operationId и отвечают
{accepted:true, operationId}. Результат публикует только закреплённый resultSource:
{packetId, operationId, outcome:succeeded|failed|unknown, result:{...}}.
Успешный understand возвращает MaterialResult из owner JSON Schema:
{resultRef,provenance:{packetId,materialId,revision,inputHash}}. Все поля происхождения
совпадают с зарегистрированным пакетом; inputHash — SHA-256 исходного события,
не хеш текста или prepared. resultRef — непустая устойчивая ссылка на сохранённый
результат. Успешный memory возвращает MemoryResult с теми же полями и
understandingRef, равным resultRef успешного текущего understand.
Оба DTO определены в schemas/messages.schema.json#/definitions; выбор схемы
делается по сохранённому kind задания, а не по заявлению отправителя.
Пустой/чужой/неполный результат отвергается INVALID_JOB_RESULT до изменения состояния;
completed повторно проверяет результаты актуальных попыток.
Повтор подтверждённого результата должен совпадать. Сначала сохраняется intent,
затем выполняется вызов; потерянный ответ повторяется с прежним ключом.
Сервис отвечает за идемпотентность собственной операции. Такой общий DTO описывает
требования порта Приёма и не объявляет существующим API ещё не созданного сервиса.

Temporal ждёт результат без занятой долгим ожиданием Activity. unknown не создаёт
новую попытку; ожидается определённый результат того же задания.
Подтверждённый failed останавливает ветку. Авторизованный resume с
expectedResumeVersion разрешает новую явную бизнес-попытку с тем же input;
предыдущие задания сохраняются. Потеря completion Activity после COMMIT не меняет
границу уже записанной остановки и не поглощает принятый resume. Повтор retryJob
для того же failed operationId сохраняет ту же следующую бизнес-попытку;
технический retry не увеличивает её номер. STEP_REQUIRES_ATTENTION сохраняет остановку
неповторяемого шага. Технические transient ошибки повторяет Temporal.
Ни retry Activity, ни redelivery не являются новой версией материала.

## Файлы

Входящий fileId разрешается только относительно фиксированного fileBaseUrl
источника, без redirect; это внутренний адаптер источника, не URL от клиента.
fileId является одним непрозрачным сегментом пути: . и .. запрещены схемой и
адаптером до побочных эффектов, остальные символы кодируются; нормализованный
URL обязан оставаться внутри согласованного pathbase и origin.
Приём использует Artifacts prepare с устойчивым requestId, HTTP PUT и get.
Созданный Hermes файл приходит с готовым artifactId и не публикуется повторно.
Владелец и ready проверяются. Байты не проходят через JetStream или Temporal.
Максимум 2 GiB соответствует Артефактам; таймаут передачи 30 минут.
Неподтверждённая отправка в Telegram не повторяется автоматически: исполнитель
обязан сохранять квитанции, выдавать unknown и разрешать восстановление по контракту.

## Хранение и История

intake_receipts — логический материал; intake_packets — исходник, контекст,
подготовленный пакет, jobs и итоги; intake_rejections — безопасные отказы; intake_control_events — source/eventId,
owner/input hash и packet ID принятых управляющих событий. Отдельная таблица
не является очередью и не содержит сырые результаты. Запись управляющего ключа
и изменение пакета входят в одну PostgreSQL транзакцию.
Доступ других сервисов к таблицам запрещён. Runtime получает DML пакетов и только SELECT/INSERT реестра управляющих событий;
миграции 001 и 002 идут
отдельной owner-ролью. Автоочистки оригиналов/ключей в v1 нет.
receivedAt фиксирует время приёма брокером и сохраняется один раз в БД; prepared и original не меняются.

История: source service_intake, scope user/ownerId, object intake_packet/id.
receive 1105 — регистрация, deliver 1106 — завершённая передача обязательным
получателям. Детерминированный UUID и время факта сохраняют точный повтор.
Нет текстов сообщений, файлов или credentials в data.
Получение пишется независимой веткой; завершающий факт — после бизнес-веток.
Недоступность Истории не задерживает уже готовую доставку, но workflow ждёт журнал.
Потоковые event.recorded не создают дублирующий предметный аудит v1.

## Read API и эксплуатация

NATS Services service_intake 1.0.0 поддерживает PING/INFO/STATS.
get.<callerId> принимает {source,eventId,expectedHash?} либо {source,sequence}
для безопасной диагностики отказа по квитанции входного брокера; callerId связан с read
привязкой, доступ только своему owner. Чужое/отсутствующее — NOT_FOUND.
status возвращает {jetstream:boolean,temporal:boolean}; готовность режимов раздельна.
Сервисные ошибки — Nats-Service-Error и Nats-Service-Error-Code.
Коды: INVALID_ARGUMENT/400, FORBIDDEN/403, NOT_FOUND/404,
EVENT_ID_CONFLICT/409, INVALID_JOB_RESULT/400, BUSY/503, NOT_READY/503. Входной отказ хранит безопасный код. Глубина JSON ограничена 64 уровнями;
ревизия — положительным PostgreSQL integer. Пустое сообщение без текста/файлов
не является поддержанным профилем v1.
Read API: до 8 запросов, вход до 128 KiB, ответ до 1 MiB.
Runtime: INTAKE_CONFIG; миграции: INTAKE_OWNER_DATABASE_URL и INTAKE_RUNTIME_ROLE.
Отдельные main/worker; пул до 4 на программу, worker до 4 Activity/8 Workflow Tasks,
кеш до 32 workflow. Временные ресурсы и тестовые соседи не входят в runtime.

Конфигурация содержит databaseUrl, natsUrl, optional natsOptionsFile,
temporalAddress, temporalNamespace, taskQueue, artifactBaseUrl, sources, ports.
Порты: channel, contact, inbox, hermes, understand, memory, deliver; каждому subject,
долгим также resultSource. Отсутствующий исполнитель остаётся ошибкой/ожиданием,
а не синтетическим успехом. Секреты держатся в защищённом файле вне Git.

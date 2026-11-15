# Контракт bug-hunt v1

Владелец — services/bug-hunt. [JSON Schema](schemas/messages.schema.json) задаёт
закрытые DTO, [AsyncAPI](asyncapi.json) — NATS Services. Одно ядро обслуживает
оба транспорта. PostgreSQL — отдельная БД, не общий каталог чужих таблиц.
Операции v1 не ждут моделей. Добавочная [систематизация v2](SYSTEMATIZATION.md)
не меняет их DTO или смысл. Опциональное расширение v3 расследует наблюдения и публикует отдельные доказательные выводы; см. [VERIFICATION.md](VERIFICATION.md). Программу оно не исправляет.

## Идентичность и границы

MCP Streamable HTTP предоставляет bug_hunt_help, bug_hunt_report, bug_hunt_get,
bug_hunt_list. Help принимает только {}, возвращает публичные правила и пример
без регистрации наблюдения и без NATS/SQL. В постоянных server instructions
только одна короткая строка; подробный текст загружается вызовом help. Каждый HTTP-запрос заново проверяет credential по защищённому
реестру и действующий active owner через Auth identity-get. Нет общего владельца
для всех клиентов. principalId стабилен при ротации токена; bearer и connection ID
не входят в ключ повтора. У MCP нет сохраняемых сессий.

NATS принимает {context,input}. Web context — {kind:"web",headers}; headers
допускает только cookie, origin, user-agent, sec-fetch-site. Auth session должна
быть действующей, active, иметь совпадающие user.id/session.userId и будущий
expiresAt. reviewer=true назначается только текущей роли admin из Auth.
Hermes context — {kind:"hermes",userId,profileId}; передать его может только
доверенный broker после SO_PEERCRED/UID-проверки. Сервис повторно сверяет Auth,
active user и profileId. Обычный профиль не получает NATS credentials broker.

owner_id, actor_id, installation_id, reviewer, permissions не входят
в аргументы модели и не принимаются в observation. installationId задаётся
оператором и сохраняется при обновлении/восстановлении. ownerId — каноническая
строка Brai, UUID не требуется. Источник codex/hermes/web назначает адаптер.
Клиентские версии, время и диагностика остаются заявленным наблюдением.

NATS ACL допускает subjects только доверенным Web, broker и оператору.
Наличие owner ID в произвольном сообщении не доказывает личность.
Web самостоятельно проверяет Origin и текущую сессию перед POST. Браузер
не может включить reviewer или задать owner. Новые вызовы учитывают отзыв.

## Операции

| Subject brai.bug_hunt.v1. | Предметный вход | Результат и доступ |
| --- | --- | --- |
| report | request_id, observation | report_response, текущий владелец |
| get | case_id, cursor?, limit? | get_response, владелец или проверяющий |
| list | filters?, cursor?, limit? | list_response, только свои карточки |
| operator-list | тот же list input | отдельный общий список для проверяющего |
| review | request_id, case_id, expected_revision, review_state, explanation | review_response, только проверяющий |
| status | {} без context | status_response, только операторский ACL |

Service name/queue — brai_bug_hunt, версия 1.0.0; PING/INFO/STATS следуют
NATS Services. PING сам по себе не доказывает готовность БД.
Status проверяет schema 1, таблицы, app credentials без owner/superuser прав
и работающий NATS request-reply. Готовность не вызывает модели.

Report требует title, operation, expected, observed. component_id при отсутствии
даёт unknown в карточке; исходный observation не переписывается. steps,
component_version, commit_sha, deployment_revision, error_code, diagnostic_text,
client_occurred_at, run_id, conversation_ref, supersedes_report_id необязательны
и допускают null. Отсутствие отличается от явно переданного значения для hash.
evidence_artifact_ids — необязательный массив уникальных UUID. Неизвестные
поля, пути, URL, inline binary не принимаются вместо Artifact IDs.
Сервер назначает registered_at; client_occurred_at не управляет выдачей.

Каждый новый request_id создаёт отдельное наблюдение и отдельную карточку.
V1 возвращает отдельные карточки; производные группы читаются отдельно через v2. Исправление описания — новое наблюдение,
при необходимости со ссылкой на собственный supersedes_report_id.
Чужой и отсутствующий case/report ID дают одинаковый NOT_FOUND.

Карточка начинает с review_state=new, verification_status=unverified, revision=1.
Допустимы new → triaged, new/triaged → archived, archived → new.
Переход требует объяснения и expected_revision. Изменение, новая revision,
неизменяемый аудит и квитанция фиксируются вместе. Проигравший конкурент
получает REVISION_CONFLICT без эффекта. verification_status всегда unverified.
Нет confirmed, resolved, false_positive, severity и автоматических выводов.

Get возвращает одну карточку, исходное наблюдение и ограниченную страницу
решений. List сортируется по registered_at DESC, id DESC. Фильтры фиксированы:
review_state, component_id, source, registered_from, registered_to.
Курсор — непрозрачный HMAC, связан с владельцем/режимом/фильтрами и позицией;
изменение области или фильтров требует новой первой страницы. Новые вставки
не повторяют уже пройденные строки. Время регистрации и аудита имеет точность
миллисекунд; серверные курсоры сохраняют эту точность.

## Повторы и ошибки

Ключ принятой мутации: installationId, ownerId, стабильный actorId,
операция, request_id. SHA-256 вычисляется по JSON с отсортированными ключами.
Порядок полей объекта не влияет на hash; строки, массивы, null и клиентское
время сохраняются точно. Принятый вход и аудит runtime не изменяет и не удаляет.

Идентичный повтор возвращает прежнюю исходную квитанцию и replayed=true,
включая первоначальные state/time/IDs. Текущее состояние читается get.
Другое содержимое принятого ключа даёт IDEMPOTENCY_CONFLICT.
Параллельные повторы создают одну запись. Повтор review проверяется до
expected_revision. Квитанции переживают рестарт и не вытесняются по TTL.

Ошибки: INVALID_ARGUMENT, REQUEST_TOO_LARGE, RESULT_TOO_LARGE,
UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, IDEMPOTENCY_CONFLICT,
REVISION_CONFLICT, BUSY, DATABASE_UNAVAILABLE, DEPENDENCY_UNAVAILABLE,
DEADLINE_EXCEEDED, INTERNAL. Payload {code,message,outcome,retryable}
не содержит SQL, stack trace, upstream body или credentials.
not_accepted подтверждает отсутствие принятой новой мутации; unknown
не разрешает создавать новый request_id. После возможного commit следует
повторить исходный вход с прежним ключом. Отказ до commit откатывает
карточку, наблюдение, аудит и квитанцию вместе.

NATS возвращает оба Nats-Service-Error и Nats-Service-Error-Code:
400 для аргументов, 401/403 для доступа, 404 для скрытого отсутствия,
409 для конфликтов, 413 для размера, 429 для BUSY, 503 для зависимостей,
504 для deadline, 500 для INTERNAL. MCP возвращает isError с безопасным DTO;
ошибки HTTP аутентификации/формата сохраняют соответствующий статус.

## Доказательства и интерфейс

При первом принятии каждый заданный Artifact должен существовать, быть ready
и принадлежать owner. Метаданные читаются через публичный Artifacts get,
байты не открываются. При выключенном Artifacts текстовый report работает,
а запрос с непроверяемыми IDs явно отклоняется. Принятый replay возвращает
прежнюю квитанцию даже после последующего удаления доказательства.

Web показывает текст как данные, не исполняет HTML и не превращает пути в файлы.
HEAD доказательства проверяет текущую сессию, связь с карточкой и владельца;
GET повторяет проверки и передаёт байты существующим защищённым download
с проверкой размера/hash. Доступ к чужой карточке для разбора не даёт права
скачать чужой файл. Недоступный Artifact остаётся ссылкой исходного наблюдения
и показывается недоступным. Ссылка не обещает вечное хранение.

Пользовательский агент сохраняет request_id, отправляет минимум очищенной
диагностики без секретов и полной переписки, не сообщает о регистрации без
квитанции и не отправляет сбой bug-hunt рекурсивно. Регистрация не расширяет
полномочия, не отменяет ранее порученное исправление и не разрешает повтор
исходной операции с неизвестным эффектом.

## Ресурсы и эксплуатация

| Ресурс | Предел |
| --- | --- |
| Предметный JSON | 64 КиБ UTF-8, без молчаливого усечения |
| Транспортный envelope | дополнительно до 4 КиБ; большие пакеты отклоняются |
| Полный ответ | 256 КиБ, включая MCP envelope |
| title / operation / version / error_code | 200 Unicode code points |
| expected / observed / explanation | по 4000 code points |
| steps / diagnostic_text | 8000 / 16000 code points |
| Artifact IDs | до 8, уникальные |
| Страница | по умолчанию 20, максимум 50 |
| Активные операции / ожидание | 8 / 16, FIFO |
| Общий срок | до 10 секунд вместе с ожиданием и Auth |
| SQL pool / statement timeout | 8 / не более 7 секунд и остатка deadline |
| MCP | stateless, 0 сохраняемых sessions; maxConnections из config, до 32 |

NUL и непарные surrogates запрещены. Полный вход отклоняется до записи,
не сокращается. Большая карточка/страница даёт RESULT_TOO_LARGE; get допускает
меньший limit для аудита. Список и аудит всегда читаются SQL LIMIT.

maxReports (до 1000000), reportsPerMinute (до 6000) и maxDatabaseBytes
(минимум 16 МиБ) обязательны в конфигурации экземпляра. Порог БД проверяется
перед каждой новой мутацией, включая review; это порог приёма, не системная
дисковая квота. Последняя принятая транзакция может немного превысить порог.
Новые мутации при достижении пределов получают BUSY; принятый replay и чтения
сохраняются. Лимит частоты касается новых report одного стабильного principal.
Старые данные ради приёма новых не удаляются.

После deadline активный слот остаётся занят до фактического завершения SQL.
Запуск не выполняет миграции. Завершение прекращает admission, закрывает
адаптеры, ждёт работающие операции и освобождает NATS/SQL.

Диагностика содержит операцию, безопасный код исхода, длительность и
SHA-256 request_id. Исходные тексты, cookies, tokens и upstream body не пишутся.
Есть счётчики новых наблюдений, replay, конфликтов, отказов, BUSY, БД и
длительности операций. Счётчики процесса не заменяют аудит БД.

Справочники History прочитаны при реализации. Внешние события первого этапа
не нужны: источник ручного аудита — собственная транзакционная БД.
В операциях v1 нет outbox, расследований, JetStream или синхронизации.
Производные группы и модели принадлежат отдельному контракту v2.
Порядок резервной копии, восстановления и отката — в [DEPLOYMENT](DEPLOYMENT.md).

## Дополнение: поколения embedding

Систематизация остаётся добавочным v2-контрактом из SYSTEMATIZATION.md.
Миграция 004 сохраняет поколения, активный указатель и аудит; исходная схема
v1, IDs и квитанции не меняются. Защищённый targetGeneration создаёт отдельные
embedding jobs, сохраняя local/Jev и неизвестные платные исходы.
Пользовательский similar читает только active. Явная operator-only команда
processing.activate-generation проверяет CAS и полный корпус, сохраняет
квитанцию и инвалидирует signed cursor. Подготовка build не активирует его.
Точные DTO и ошибки — schemas/processing-v2.schema.json; правила — раздел
«Подготовка и активация поколения» в SYSTEMATIZATION.md.

## Проверка наблюдений v3

Capability verification=3 и миграция 005 добавляют requests, snapshots, effects,
evidence, results, ручной audit и расписание. Старые DTO v1/v2 и поле
verification_status=unverified сохраняют прежний смысл. Контракт, доказательные
критерии и ограничения: [VERIFICATION.md](VERIFICATION.md). Машинные входы:
schemas/verification-v3.schema.json; NATS: asyncapi-v3.json; локальный runner:
runner.openrpc.json. Capability не означает, что verification worker включён.

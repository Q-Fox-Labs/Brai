# Контракт providers v0

Экспериментальный синхронный endpoint — `brai.providers.v0.invoke.decide`.
Постоянные consumers не подключаются. Машинный контракт: [AsyncAPI](asyncapi.yaml)
и закрытые [Draft-07 схемы](schemas/v0.schema.json).

## Путь и доверие

NATS Services adapter → чистое ядро → LiteLLM 1.104.2 `/v1/systemone` →
одноразовый egress → фиксированный TypeSafe `/v1/systemone` → обратно.
Egress — маленький HTTP-модуль той же TS-программы, не отдельный процесс.
Он не адаптирует модельный API, не выбирает модель и не выполняет вызов без
предшествующего запроса LiteLLM. Секрет получает только LiteLLM штатным env_file;
egress пересылает его Authorization без чтения secret-файла и без журналирования.
LiteLLM доступен только доверенной программе Brai; приватный egress listener —
loopback, зарегистрированные случайные capabilities, фиксированные метод/origin/path.

Доверенная граница caller задаёт ownerId. UUID и ownerId не дают полномочий;
NATS broker/ACL изолируют вход. Нет публичного HTTP или браузерного входа.
Окружение запуска явно передаёт NATS_URL, LITELLM_URL, PROVIDERS_EGRESS_PORT
(по умолчанию loopback18401). Health модели отсутствует.

## Данные и ограничения

Запрос: UUID requestId, непустой ownerId ≤255 символов, provider=`typesafe`,
model=`jev-1.13.0`, state ≤16384 символов, ровно один вопрос noul с instructions
≤2048 символов; deadlineAt — абсолютный RFC3339. Имена вопроса: латинская буква,
затем буквы/цифры/подчёркивания, ≤64 символов. Неизвестные поля отвергаются.
Максимальный UTF-8 JSON запроса32768 байт, ответа upstream16384 байта.
Выход семантически ограничен одной вероятностью noul в [0,1]; max_tokens
не добавляется, System One его не поддерживает. Нет генерации свободного текста.
Параллелизм2, очередь отсутствует; время ожидания ≤min(deadlineAt-now,30000мс).
NATS caller выбирает timeout больше этого срока с запасом доставки; broker payload
должен быть ≥32768 байт. У fixture стандартный конечный NATS limit1MiB.

Ответ содержит requestId, provider, requestedModel, actualModel, answers и usage.
actualModel обязан быть точным jev-1.13.0; неизвестная/другая модель — отказ протокола.
Вероятность не округляется. Usage содержит inputTokens/outputTokens либо null,
когда реальный upstream не сообщил счётчики. Egress сохраняет только наличие
и проверенные counts до нормализации LiteLLM, не промпт или ответ. Программа
возвращает реальные counts, а не созданные LiteLLM нули.

## Повторы, дедлайн и ошибки

Прикладных retries/fallback нет. Настраиваемые retries LiteLLM/router отключены,
drop_params=false, модель одна. Stock 1.104.2 содержит безусловный транспортный
replay POST при RemoteProtocolError/ConnectError. Поэтому egress атомарно claim-ит
одноразовый случайный nonce до внешнего fetch; любой replay/late/unknown nonce
отвергается до обращения к TypeSafe. Nonce хранится только во время полного
вызова LiteLLM, ≤2 active entries. Он не равен requestId caller и не создаёт
дедупликацию повторных запросов caller. Число внешних dispatch на попытку ≤1.

Abort прекращает локальное ожидание, но не доказывает остановку TypeSafe или
отсутствие списания. Слот удерживается до остановки локальных HTTP-действий.
После возможной отправки timeout, разрыв или потеря ответа означает unknown;
автоматическая новая попытка запрещена. После перезапуска состояние не восстанавливается.

Ошибки — оба заголовка Nats-Service-Error/Nats-Service-Error-Code (500)
и прямой DTO {code,outcome}; code из схемы, outcome=not_sent|failed|unknown.
INVALID_REQUEST, MODEL_NOT_ALLOWED, DEADLINE_EXCEEDED и OVERLOADED до отправки:
not_sent. 401/403: UPSTREAM_ACCESS/failed;429: UPSTREAM_RATE_LIMIT/failed;
5xx: UPSTREAM_FAILURE/unknown; невалидный ответ: UPSTREAM_PROTOCOL/unknown;
обрыв/abort: OUTCOME_UNKNOWN/unknown. Сырые upstream body/exception не возвращаются.
Сбой egress после возможной отправки даёт безопасный5xx/unknown.

NATS Services: brai_providers, version0.0.1, уникальный instance ID,
queue brai_providers, стандартные PING/INFO/STATS. PING не проверяет TypeSafe.
Нет БД, каталога, потоков, tools, файлов, истории, уведомлений и фоновых задач.
Справочники History прочитаны при разработке; события в v0 не требуются и не публикуются.

## Проверка и готовность

Существующими зависимостями: `npm test --prefix services/providers`.
Для real NATS задайте PROVIDERS_TEST_NATS_URL собственного изолированного broker;
без него NATS-тест явно skipped. Контроль HTTP/egress бесплатный, не заменяет
stock LiteLLM и настоящий Jev. Начальные18 тестов включали real NATS.
Живая приёмка v0 выполнена 2026-10-18 через authenticated stock1.104.2 и
TypeSafe jev-1.13.0; requested/actual model совпали. Health модели не вызывает.

[LiteLLM1.104.2 source](https://github.com/BerriAI/litellm/tree/v1.104.2),
[TypeSafe API](https://docs.typesafe.ai/api), [цена](https://docs.typesafe.ai/models).

## v1: каталог и устойчивое решение

v0 и его закрытые DTO остаются доступны. v1 имеет отдельный NATS Services
`brai_providers_v1`, version1.0.0, queue `brai_providers_v1`. Все сообщения
принадлежат [v1.schema.json](schemas/v1.schema.json); subjects и формы ответов —
в [AsyncAPI](asyncapi.yaml). Сервисная ошибка содержит оба NATS error headers,
код500 и безопасные `code/outcome`, без exception или upstream body.

- `brai.providers.v1.models.list`: `{}` → `{version,models}`.
- `brai.providers.v1.models.get`: `{provider,model}` → публичная карточка.
- `brai.providers.v1.invoke.decide`: ownerId, operationId UUID, provider, model,
  state, questions, deadlineAt → операция, без ожидания вычисления.
- `brai.providers.v1.operations.get/cancel`: `{ownerId,operationId}` → операция.
- `brai.providers.v1.status`: `{}` → `{ready,active,capacity:2,waiting:0}`;
  модели для проверки готовности не вызываются. active относится к v1;
  общий egress ограничивает также совместные вызовы v0/v1 двумя отправками.

`catalog.json` — единственный декларативный источник публичных capabilities и
маршрутов LiteLLM. `npm run catalog` генерирует `litellm.yaml` (JSON — подмножество
YAML); проверка запрещает дрейф. Поддерживаются TypeSafe jev-1.13.0 (`decide`) и OpenRouter
deepseek/deepseek-v3.2 (`chat`, `stream`, `tools`). Название неизвестной capability не включает её автоматически.
Ключи хранятся во внешнем env_file, каталог содержит только имя переменной.

Вход: state string/object/array;1–16 вопросов noul/choice/score. Instructions —
строка1–2048 символов. Choice содержит2–32 опций criteria, score2–10 уровней.
Структура state/criteria сохраняется; text state и строки criteria до16384 символов.
Предел полного UTF-8 JSON65536 bytes, глубина32, конечные числа, корректный Unicode,
без NUL. Неизвестные поля отвергаются. Поля questions и answers имеют те же ключи
и типы; distributions, confidence и legend сохраняются без округления. Вероятности
[0,1], сумма распределения1 с погрешностью≤1e-6; choice принадлежит criteria
и имеет максимальную вероятность. Score находится в диапазоне уровней.
Форма соответствует [TypeSafe System One API](https://docs.typesafe.ai/api).
Raw отсутствие usage восстанавливается в null до нормализации LiteLLM.
Для v1 egress сохраняет bounded raw ответ; normalized answers должны точно
совпасть с ним по canonical JSON, иначе протокол отклоняется без второго вызова.
Ответ другой модели, лишние/потерянные ответы и невалидный metadata — protocol error,
`outcome_unknown`; fallback и повтор вычисления не выполняются.

## Журнал, повтор, отмена и рестарт

Владелец данных — providers; PostgreSQL база и роль должны быть отдельными от
LiteLLM и соседних сервисов. [Миграция001](migrations/001_operations.sql)
применяется явно: `npm run build && npm run migrate`, с PROVIDERS_DATABASE_URL.
Миграция повторяема. Runtime не создаёт БД и не запускает миграции.
Один экземпляр удерживает session advisory lock в собственной БД; второй
runtime не стартует. Потеря lock-сессии останавливает процесс.

`(ownerId,operationId)` — ключ; hash SHA256 вычисляется по полному каноническому
JSON запроса, включая deadlineAt (для chat кроме транспортного streamInbox), с сортировкой object keys и сохранением array
order. Вход сохраняется только в памяти активного слота. Долговечная запись
содержит hash, route/version, фазу, cancelRequested, даты и ограниченный итог.
Проверка идентичного повтора выполняется до чтения каталога и до проверки
просроченного дедлайна. Replay возвращает сохранённую операцию; другой hash даёт
IDEMPOTENCY_CONFLICT. Равные конкурентные запросы присоединяются к принятию
своего ключа; новой внешней отправки нет. Чужой get/cancel даёт NOT_FOUND.
Owner берётся от доверенного caller; ACL NATS обязаны ограничивать доступ.

Фазы: accepted → dispatching → succeeded/failed/outcome_unknown. accepted может
стать cancelled. PostgreSQL CAS accepted→dispatching коммитится **до** model port
и выделения egress nonce. Одноразовый egress предотвращает повторный HTTP POST
stock LiteLLM; он не заменяет журнал. Рестарт отменяет accepted с
RESTART_BEFORE_DISPATCH, а dispatching переводит в outcome_unknown. Вычисление
никогда не возобновляется. Даже падение до фактического send после dispatch intent
может дать консервативный unknown. Finish имеет CAS по hash и незавершённой фазе:
поздний итог не заменяет новую операцию с переиспользованным ключом.

Cancel accepted атомарно предотвращает dispatch. После dispatch только сохраняет
cancelRequested и сигнализирует локальному abort; ответ billingMayContinue=true
не обещает прекращение внешней работы/списания. Даже после отмены возможен
неизвестный исход. Сбой сохранения результата не запускает модель повторно;
при недоступном журнале ready=false, новое вычисление отклоняется.

Ключи хранятся7суток с принятия, итог24часа с финала. get/replay после24h содержит
resultExpired=true/result=null, сохраняя фазу и metadata ключа до7суток. После
7суток NOT_FOUND; повторное принятие такого ID считается новой операцией.
Сборщик каждую минуту удаляет истёкший итог и ключи, чтение скрывает итог сразу
при TTL. База имеет admission limit100000 ключей, затем OVERLOADED. Результат и
upstream≤65536 bytes; JSONB storage constraint131072 bytes учитывает пробелы
представления PG. Полный ответ операции≤73728 bytes. Промпты не журналируются.

Два активных v1 слота включают подготовку/dispatch/локальную остановку; очереди
вычислений нет. Admission≤8, отдельно get/cancel/status/catalog≤8; переполнение
даёт OVERLOADED до новой отправки. SQL pool10, connect≤3s, statement≤3s,
query≤4s; ожидание SQL конечно. Слот возвращается после остановки локального
порта. Дедлайн Jev≤min(deadlineAt-now,catalog.deadlineMs,
PROVIDERS_JEV_DEADLINE_MS), по умолчанию30s; override1–30000ms. NATS invoke
может завершиться по caller timeout после принятия: читать/replay тот же ID,
никогда не создавать новый ID автоматически. Брокер должен допускать payload≥73728.

Assembly `main.ts` подключает store/model ports к lifecycle и NATS. Дополнительные
chat использует тот же OperationStore, dispatch CAS, TTL и Json result.
Image остаётся следующей задачей. History/Alerts и
HTTP consumer остаются следующими задачами. Параметры запуска дополнены
PROVIDERS_DATABASE_URL и необязательным PROVIDERS_JEV_DEADLINE_MS. Без
PROVIDERS_DATABASE_URL main запускает только v0, как прежний fixture задачи1;
ready log явно содержит protocols=[v0], v1 endpoints не регистрируются.
С PROVIDERS_DATABASE_URL запускаются v0+v1 после lock/recover. Остальной v0
путь и private egress неизменны.

Controlled HTTP/PG/NATS проверки подтверждают протокол и lifecycle.
Живая приёмка v1 выполнена 2026-10-18: один NATS invoke через собственный PG
journal, authenticated stock LiteLLM1.104.2 и одноразовый egress вернул
реальный jev-1.13.0. Noul/choice/score и object state прошли без потери
metadata; dispatch зафиксирован до model port. Get и точный invoke replay
вернули тот же сохранённый итог при одном model call. Usage363input/61output.
Иные capabilities этой приёмкой не подтверждаются.

## v1: один chat-ход и инструменты caller

`brai.providers.v1.invoke.chat` принимает [chatRequest](schemas/v1.schema.json)
и возвращает обычную durable операцию. Новый журнал, очередь и agent loop
не добавлены. Chat и decide делят два inference слота; control имеет отдельные
восемь. Повторы, cancel, unknown, рестарт и TTL совпадают с decide.
Дедлайн chat — min(deadlineAt-now, catalog.deadlineMs,
PROVIDERS_CHAT_DEADLINE_MS), по умолчанию90s; override1–90000ms.

Профиль: `openrouter/deepseek/deepseek-v3.2` в stock LiteLLM1.104.2;
точный OpenRouter endpoint `deepinfra/fp4`. `provider.only` и `order` содержат
только этот tag, `require_parameters=true`, `allow_fallbacks=false`;
`reasoning.enabled=false`. Endpoint и его tools/tool_choice/reasoning проверены
через [публичный API](https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints).
[Правила маршрутов](https://openrouter.ai/docs/guides/routing/provider-selection)
разрешают точный endpoint tag. Цена на дату разработки: $0.26/M input,
$0.38/M output; live-приёмка отдельно сверяет текущую цену перед каждым резервом.
Профиль передаёт max_tokens, stream и stream_options.include_usage.
Автоисполнение MCP не включено: допустимы только function tools.
Неизвестные параметры, включая произвольные extra_body/api_base/reasoning,
отвергаются закрытой схемой. Drop_params=false; fallback и retries отключены.

Private egress по-прежнему выделяет nonce только после PG dispatch CAS, claim
происходит до внешнего fetch. Для chat разрешён исключительно POST на
фиксированный `https://openrouter.ai/api/v1/chat/completions`, путь capability
заканчивается `/v1/chat/completions`. Отдельный model-level api_base regex
допускает только loopback18401/dispatch/nonce/v1; Jev regex не расширен.
Глобального credential bypass нет, Proxy требует master-key. Egress передаёт
raw SSE bytes с ограничением и backpressure HTTP, не делает модельную адаптацию.
Он собирает raw сообщение и usage до преобразований LiteLLM; text/tools/finish
после Proxy обязаны совпасть. Raw отсутствие usage возвращается как null.
Неизвестные поля provider message сохраняются точно в opaque state; если
неизвестное поле меняется между delta без поддержанного правила сборки,
поток отклоняется как UPSTREAM_PROTOCOL, поле молча не теряется. Reasoning
в этом профиле выключен; восстановление скрытых мыслей не поддерживается.

Вход дополнен connectionId, streamInbox, messages, tools, maxTokens и toolChoice.
Messages — до32 system/user текстов, каждый1–8192 символов. Пустой список
допустим при continuation. Tools должны включать определения всех вызванных
на предыдущем ходу функций; toolChoice=none запрещает новые вызовы. Tool definitions — до8 function, имя≤64, description
≤2048; минимальный JSON Schema subset — object, до16 именованных scalar
properties (string/number/integer/boolean), required и additionalProperties=false.
Refs/regex/вложенные schema/неизвестные keywords не поддерживаются и отвергаются.
Полные tool arguments проверяются по этому subset; required должен ссылаться
на объявленные properties. maxTokens1–2048, toolChoice=auto|none|required.

Caller создаёт приватную подписку и делает NATS flush **до invoke**.
Inbox имеет форму `{PROVIDERS_INBOX_PREFIX}{connectionId}.{token}`; default
`_INBOX.`, допустим ещё один/два namespace segments внутри `_INBOX`.
ConnectionId и token —1–64 ASCII letters/digits/_/-. Адаптер сверяет prefix
и connectionId, никакие broadcast subjects не принимает. Namespace задаётся
доверенной runtime конфигурацией; NATS ACL обязаны удостоверять owner/connection
и право caller на этот inbox. Поля payload сами по себе не аутентифицируют caller.

Events содержат operationId и sequence1…16384, закрытые типы: started,
text.delta, tool_call.delta, tool_call.ready, usage, completed, error.
Индексы tools0…7, ID непустые и уникальные. Чередующиеся JSON fragments
собираются отдельно для каждого индекса; index gap, смена ID и неверные args
дают UPSTREAM_PROTOCOL/unknown. Ready появляется только после полного
finish_reason=tool_calls и проверки всех аргументов. Delta ничего не исполняет.
Finish_reason сохраняется. Completed публикуется после durable finish,
ошибка потока помечает увиденный caller текст как partial.

Конечные пределы одного хода: вход65536 bytes/depth32, upstream raw и normalized
SSE каждый1MiB, frame32768 bytes/8192 frames, text8192 bytes, arguments4096 bytes
на tool, tools8, provider replay context24576 bytes/64 messages. UTF-8 decoder
строгий, EOF без [DONE] и finish — unknown.
[Accounting frame OpenRouter](https://openrouter.ai/docs/api_reference/streaming)
может повторять прежний finish_reason с usage и пустой assistant delta; он
обновляет счётчики, не создавая второй finish. Новые tokens/tools или изменённый
finish после terminal frame остаются protocol error. Итог≤65536 bytes, ответ операции
≤73728 bytes; прежняя PG JSONB граница131072 bytes остаётся. Исчерпание input
context отклоняется до dispatch; переполнение output/stream после dispatch — unknown.

Локальный publisher удерживает≤32768 неподтверждённых bytes на операцию;
переполнение/ошибка прекращает live delivery, best-effort error
STREAM_DELIVERY_INTERRUPTED оставляет caller путь к get. Финальный bounded
результат может сохраниться; streamDelivery=interrupted либо unconfirmed.
Unconfirmed означает лишь локальную публикацию, не обработку подписчиком.
Core NATS не хранит tokens и не оказывает backpressure по скорости caller.
Caller ограничивает свою подписку; sequence gap, slow-consumer, разрыв, timeout
или отсутствие completed требуют get того же ID. Новой отправки модели нет. Новый inbox при replay не меняет вычислительный hash
и возвращает прежнюю операцию; live events в новый inbox не переигрываются.

Полный chatResult содержит provider/requestedModel/actualModel, connectionId,
text, все toolCalls с ID/index/name/parsed arguments, finishReason, usage,
partial=false (получен целый upstream turn), streamDelivery и continuation.
Continuation содержит operationId и opaque base64url state; state включает
точные исходные context messages и raw assistant message. Stock LiteLLM удаляет
assistant content:null рядом с tool_calls; только wire-запрос опускает этот null,
исходный durable state остаётся неизменным. IDs, arguments и opaque поля
передаются без такой нормализации. Это содержимое
результата с TTL24h, не диагностический лог. Его нельзя журналировать.

Следующий ход имеет **новый operationId**, `continuation:{operationId:previous}`
и toolResults `{id,content}` для каждого исходного tool ID ровно один раз.
Инструменты и проверка полномочий принадлежат caller. Providers читает сохранённый
state по reference, не принимает caller-подмену opaque state. Старый owner,
connection, provider/model должны совпасть; истёкший/несуществующий/чужой
reference и неполный/лишний набор ID дают INVALID_CONTINUATION/not_sent.
Нужные tool results добавляются с исходными IDs, затем новые system/user
messages; общий replay context ограничен. После рестарта сохранённый success
остаётся пригоден для continuation, dispatching остаётся unknown без resume.

Контролируемые chat/HTTP, настоящий изолированный NATS/PG и бесплатный stock
LiteLLM probe подтверждают протокол, два tools, raw state/usage и single dispatch
при transport disconnect. Внешняя приёмка завершена 2026-10-18: authenticated
stock1.104.2 → OpenRouter deepinfra/fp4, первый ход дал два tool calls
(430 input/77 output tokens), caller вернул оба результата с исходными IDs,
новый operationId завершил ответ потоково (184/16 tokens). Контент поступил
до финала, get/replay совпали, raw continuation сохранён. Принятый первый ход
не повторялся; после бесплатных parser/wire fixes продолжался сохранённый op.
Один отдельный continuation получил429, после разрешённой ручной проверки
временной недоступности следующий завершился; автоматических retries/fallback
нет. Metadata receipts root600: /var/lib/brai-dev/providers-test/task3-live.json
и task3-live-before-continuation.json; не содержат промпта/ответа/ключей.

# Инструменты Hermes

Владелец этой границы — `services/hermes`. Программа `tools.mjs` предоставляет MCP stdio по официальному SDK. Её входные схемы берутся из MCP владельца или опубликованных JSON Schemas соседей. Собственных таблиц, очереди и универсального транспорта команд нет. Историю изменений сохраняют владельцы; мост не создаёт дублирующих History фактов.

## Связи и доверие

| Вход Hermes | Порт владельца | Ограничение |
| --- | --- | --- |
| `elements_*` | [game-core MCP](../elements/CONTRACT.md) | Owner-bound endpoint; human claim/complete/fail модели запрещены. |
| `publish_file`, `fetch_file` | [publisher MCP stdio](../agent/PUBLISHER.md) | Независим от основного Agent. Metadata NATS, байты HTTP, owner/ready/SHA-256 проверяются publisher. |
| `timer_*` | [Timer v2](../timer/README.md) | Команды JetStream; чтение NATS Services; userId добавляет мост. |
| `history_list`, `history_get` | [History scoped queries](../history/CONTRACT.md) | Только user scope текущего owner, без SQL/произвольного scope. |
| Три инструмента справочника History | Готовый History MCP | Только categories_list, types_list, type_get; административные инструменты скрыты. |
| `alerts_*` | [Alerts owner API](../alerts/CONTRACT.md) | list/get/summary/read/read_all; user_id добавляет мост. |
| `transcription_*` | [Transcription MCP](../transcription/CONTRACT.md) | Trusted bearer с фиксированным principal; обычные локальные расшифровки идут через coordinator. |
| `local_ai_*` | [Local AI owner API](../local-ai/CONTRACT.md) | Каталог, install/state/configure/load/unload/remove, embed, synthesize, cancel/status. OwnerId добавляет мост. |

Поток файла: Hermes working file → publisher snapshot → Artifacts prepare → HTTP bytes → подтверждение ready/hash → неизменяемая локальная копия → Telegram native upload. Входящий Telegram файл проходит тот же publish; последующие потребители получают Artifact ID. Модель не получает произвольный NATS/SQL инструмент, upload URL или право читать чужой артефакт.

Запуск требует защищённого JSON и отдельного доверенного `BRAI_HERMES_OWNER_ID`. Они должны совпадать. NATS identity Hermes имеет только необходимые subjects и свой inbox; старые связи сервисов не меняются. Credentials не включаются в ошибки. Конфигурация экземпляра отвечает за owner binding Elements endpoint и Transcription bearer. Подмена owner во входе отвергается.

## Голосовой вход через Transcription

`transcribe.mjs --input <absolute-audio-path> --output <absolute-text-path>` — файловый адаптер штатного command STT Hermes. Он использует существующий publisher и [Transcription MCP](../transcription/CONTRACT.md); собственного ASR runtime, ключа провайдера и долговечного хранилища текста нет. `config.stt.model` — полный selector по owner-схеме `ModelSelector`: `{modelId,revision,profileId}`. Неизвестные поля selector отклоняются. Owner берётся из защищённой конфигурации подключений, а не из CLI или запроса модели.

Вход должен быть непустым обычным файлом, допускаемым read roots publisher. После одного `publish_file` принимаются только MIME `audio/ogg`, `audio/wav`, `audio/flac`, `audio/mpeg` и UUID готового артефакта владельца. Штатный publisher автоматически распознаёт OGG/Opus или Vorbis, WAV и FLAC по байтам; MP3 пока не поддержан файловым мостом из-за отсутствия audio sniff в publisher. Произвольный `application/octet-stream` не принимается. Один `transcription_request_submit` получает новый `clientIdempotencyKey`, `audioArtifactId`, `{route:"local",selection:"required",modelId}` и абсолютный `deadlineAt`. API Transcription сам фиксирует revision/profile; мост проверяет все поля фактического selector против конфигурации. Схемы запросов и ответов принадлежат Transcription и не копируются в Hermes.

После submit читается только `transcription_request_get` с интервалом 250 ms. Когда task succeeded и result available, один `transcription_result_get` получает эфемерный текст и actual selector. Проверяются request ID, требуемая модель и owner DTO ответа. Непустой UTF-8 текст размером до 1 MiB записывается без изменения в новый output с правами `0600`; существующий путь не перезаписывается, в том числе если он появился во время вычисления. Groq-нормализация к этому тексту не применяется.

Общий срок publish/submit/poll/output — максимум 180 секунд; тот же абсолютный deadline передаётся Transcription. Тестируемая функция `transcribeFile` допускает более короткий `timeoutMs`, CLI его не переопределяет. Native command provider задаёт timeout 200 секунд для запаса на подключение и закрытие. Timeout не подтверждает физическую остановку вычисления; его deadline и lifecycle принадлежат Transcription/Local AI. Мост не выполняет автоматический повтор, resubmit, замену модели или удаление готовых артефактов.

`OUTCOME_UNKNOWN` означает потерю подтверждения изменяющего вызова, невалидный ответ submit либо явно неизвестный исход владельца. `MODEL_MISMATCH` запрещает принимать другую модель или result request ID. `RESULT_UNAVAILABLE` обозначает потерянный или истёкший результат; `EMPTY_TRANSCRIPT` — отсутствие распознанных слов. `INVALID_ARGUMENT`, `OUTPUT_EXISTS`, `RESULT_TOO_LARGE`, `DEADLINE_EXCEEDED` и безопасные ошибки владельцев завершают команду без нового compute. CLI выводит только безопасный код в stderr; stdout не содержит текст или служебный протокол. Нативный command STT читает output-файл. Настройка provider показана в [README](README.md#telegram-и-голос).

Сам мост не имеет fallback. До включения экземпляра нужно проверить, что fallback нативного gateway не может незаметно заменить выбранный сервис установленным альтернативным локальным backend. Это отдельная проверка runtime; настройка named provider сама по себе не доказывает отсутствие такого backend.

## MemOS embeddings

`memos/embedding/adapter.mjs` предоставляет `POST /v1/embeddings` для закреплённой модели `embeddinggemma-2-q8` через публичный Local AI invoke.embed. Owner и selector берутся из доверенной конфигурации, назначение всегда `symmetric`; порядок входного пакета сохраняется. Настройка процесса описана в [MemOS README](memos/README.md).

JSON принимает только `model`, текстовый `input`, необязательные `dimensions` и `encoding_format`. `dimensions` допускает только целое число `768`; отсутствие поля означает ту же размерность, уменьшения вектора нет. `encoding_format` принимает `float` или `base64`, по умолчанию `float`. Ответ содержит соответственно массив чисел либо base64 точных little-endian float32 байт всех 768 элементов. Python OpenAI SDK по умолчанию запрашивает base64 и сам преобразует эти байты в массив чисел. Параметры формата не передаются в Local AI.

Другая модель, размерность, формат или неизвестное поле отклоняются HTTP 400 до вызова Local AI. Некорректный ответ владельца, включая неверную длину вектора, нечисловые/бесконечные значения либо переполнение float32 при base64, даёт HTTP 502. Ошибка транспорта Local AI даёт HTTP 503; автоматических повторов нет.

## Выполнение и неизвестный исход

Обычный NATS timeout — 12 секунд, конфигурируемый до 60 секунд. Долгие Local AI/MCP вызовы — до `longRequestTimeoutMs`, по умолчанию 300 секунд и максимум 30 минут. Publisher сохраняет собственный deadline до 30 минут. Переданный `deadlineAt` Local AI не переписывается. До 8 MCP вызовов исполняются одновременно; очереди нет, девятый получает `OVERLOADED`. Publisher дополнительно ограничивает собственные операции до двух. JSON вход ограничен 65536 байтами, NATS ответ — 1 MiB; DTO владельца могут иметь более строгие ограничения. Остановка закрывает собственные MCP/NATS подключения и дочерний publisher.

Команда Timer возвращает `{commandId,status:"stored",outcome:"unknown",nextTool:"timer_command_get"}` после PubAck. Это подтверждает только хранение команды. Итог читается по прежнему commandId. PubAck timeout не означает отсутствие команды. `Nats-Msg-Id` не используется: изменённая команда с прежним ID должна получить owner conflict, а не быть скрыта транспортной дедупликацией.

При возможной отправке mutation и потерянном/просроченном ответе мост выдаёт `OUTCOME_UNKNOWN`. Автоматического повтора нет. Caller сохраняет исходные параметры и ключ: Timer — commandId, publisher — requestId, Elements claim — idempotency_key, revise — revision_id. Для create заранее задаются устойчивые UUID; после неизвестного исхода читается graph. Local AI invoke не имеет гарантии однократности; новый вызов означает новую вычислительную попытку. Transcription после submit сверяется через request.get/result.get, без повторного compute. Подтверждённые бизнес-ошибки сохраняют безопасный код владельца.

## Человеческие действия

Модель может создать Action и вызвать `elements_request_human_action({moveId})`. Ответ содержит moveId, revisionId, targetId, title и `nextTool:brai_telegram_request_confirmation`. Это чтение; оно не начинает и не подтверждает попытку. Плановая и итоговая приёмка показываются одной бессрочной кнопкой «Принять». `clarify` показывается как вопрос без кнопки; ответ владельца проходит через текущий Telegram MessageEvent и private `actions.feedback`, который завершает только текущий human Action с `metadata.stage=clarification`, `metadata.outcome=answered` и фактическим текстом/происхождением. Модель не передаёт текст ответа.

Доверенный Telegram плагин проверяет личный чат владельца, сохраняет случайный одноразовый callback token и вызывает `actions.prepare` до показа кнопки. Pending запись связывает token с точными moveId, attemptId, revisionId и stage. На click плагин атомарно поглощает token, сверяет private owner и передаёт точные связанные поля в private `actions.complete`. Данные решения формирует callback, а не текст модели. Обычный MCP ограничивает executor_kind до agent; перед complete/fail дополнительно читает graph и отклоняет human Action.

Доверие private RPC основано на вызывающем runtime. Само отсутствие метода в MCP не изолирует private CLI от terminal инструмента, работающего тем же Unix пользователем и читающего ту же конфигурацию. Для такой угрозы развёртывание должно отдельно ограничить shell и доступ к human credentials; секрет в доступном модели окружении не создаёт эту границу.

Private `actions.complete` проверяет текущую попытку, human, running и revision. Game-core атомарно проверяет статус попытки и актуальную planning revision, задаёт `confirmed_by` владельцу и сохраняет результат. Для review/final проверка revision в мосте является предварительной: текущий owner API не даёт общего атомарного CAS. Это известная граница, а не обещание блокировки параллельного редактирования.

Отмена и восстановление незавершённой отправки используют private `actions.cancel`: только та же текущая human/running попытка завершается через owner fail; Move снова planned. Прежний reason=expired остаётся совместимым с private API, но Telegram больше не задаёт срок решения и не отменяет доставленные кнопки по таймеру. При нажатии проверяются актуальные revision/attempt и отправитель; повтор callback не создаёт новую попытку. Неизвестный исход сохраняется как unknown; он не выдаётся за отказ или успешное решение.

`post_tool_call` сохраняет UUID только подтверждённых `elements_move_claim` agent Операций и удаляет запись после успешного complete/fail. Native `on_session_end` и `agent_loop_stopped` завершают только terminal attempts; при plugin startup сохранённые exact claims проходят trusted recovery. Private `actions.fail_agent` повторно читает owner graph и вызывает `elements_move_fail` только для того же всё ещё running agent attempt; уже заменённая попытка и human actions не затрагиваются. При неизвестном результате запись остаётся для следующего старта.

## Private stdio RPC

`trusted.mjs` использует JSON-RPC 2.0, UTF-8, один JSON документ на строку. Поддерживаются batch и notifications, строковый id рекомендуется. stdout содержит только ответы, stderr — безопасный код диагностики. Метод не принимает owner identity. Машинный контракт — [trusted.openrpc.json](trusted.openrpc.json).

| Метод | Вход |
| --- | --- |
| `files.publish` | `{path,requestId,title?}` по publisher контракту; requestId 1–256, файл до 2 GiB. |
| `files.fetch` | `{artifactId}`; возвращает проверенную копию владельца. |
| `actions.read` | `{moveId}`; текущие target/revision, move status, attemptId/status/executor, title/description, inputResourceIds. |
| `actions.prepare` | `{moveId,revisionId,idempotencyKey,inputResourceIds?}`; ключ 1–200; возвращает связанную human attempt и currentRevisionId. Если inputs не заданы, берёт текущие разрешённые owner API inputs. При claimed восстанавливает только точную текущую running попытку прежнего ключа, даже если revision уже сменилась; такой recovery используется для отмены после перезапуска. |
| `actions.complete` | `{moveId,attemptId,revisionId,stage,decision,comment?}`; stage planning/final/review, decision approved/success/changes/cancelled. |
| `actions.feedback` | `{elementId,revisionId,moveId?,decision,feedback}`; точное сообщение владельца, decision changes/cancelled; источник поставляет плагин. |
| `actions.cancel` | `{moveId,attemptId,revisionId,reason}`; reason expired/cancelled/declined. |

Files ответ — `{artifactId,filename,mimeType,sizeBytes,sha256,localPath,markdown}`. Markdown publisher сохраняется без изменения. Telegram распознаёт только настроенный resultRoot/UUID путь, повторно вызывает fetch и отправляет проверенные bytes нативным API.

RPC строка до 65536 байт проверяется до parse; oversized или неполная строка закрывает канал. Ответ до 1 MiB; превышение закрывает канал без усечения. Запросы идут последовательно с обратным давлением stdin/stdout. Разрыв/timeout не отменяет уже возможный эффект. Standard errors: -32700/-32600/-32601/-32602; owner failures — -32000 с безопасным `{code}`. Повтор после unknown применяется только по контракту владельца.

## Постановка game-core

После claim существующей agent Операции `plan`/`start` Hermes вызывает `elements_planning_packet`. Пакет содержит только выбранные реальные входы, фактический уровень и версионированные правила. Сначала Hermes классифицирует обычное корневое поручение как `task`, `goal` или `quest`. Если начальный черновик создан с временным `task`, но пакет обосновывает иной уровень, Hermes вызывает `elements_element_reclassify` до фиксации критериев. Эта команда доступна только безопасному начальному корневому черновику. Независимый проверяющий фиксирует критерии через `elements_planning_bind` до кандидата; напарник составляет предметный план по пакету и передаёт `elements_planning_build`. Тот же проверяющий проверяет кандидат; `elements_planning_apply` принимает его SHA256 и проверку. Owner API атомарно сохраняет новую ревизию, Ходы, ресурс постановки и завершение исходной попытки. Повтор того же применения возвращает те же ID. Квесты и Цели планируются со своими уровнями. Повтор раскрывается `elements_planning_expand_repeat` по фактическому ресурсу; неподдерживаемые дети и отложенные части останавливаются.

Все четыре инструмента наследуют user_id только из owner-bound runtime. Модель не подтверждает постановку за Игрока: Human Экшен проходит через session-bound web или доверенный Telegram. Фонового исполнителя эта интеграция не запускает; Hermes повторяет протокол по следующему явному поручению.


Telegram использует одну кнопку «Принять». Замечания и отмена поступают обычным
сообщением через brai_telegram_submit_feedback. Модель не задаёт текст и источник
решения. Отмена сохраняет выполненное и атомарно отменяет невыполненную ветку.
Практические Human Actions используют brai_telegram_submit_result только с точными
moveId/revisionId; текст и provenance берутся из текущего реального сообщения.
У одного итогового выхода отчёт может сохраниться отдельно до следующего явного
решения владельца, после чего завершается тот же Action. Несколько выходов требуют
JSON-сопоставления по точным названиям и отдельного решения. Кнопка не создаёт
свидетельств практической работы.
Параметр feedback у elements_element_activate запрещён обычному MCP модели;
его передаёт только private порт. Подробности — в telegram/CONTRACT.md.

## Ограниченное чтение пакета постановки

`elements_planning_packet_read({attempt_id,file_name?,offset?,limit?})` без file_name возвращает manifest с `file_sha256` каждого точного UTF-8 файла. Aggregate `inputs_sha256` сохраняет прежний смысл. Имя выбирается только среди ключей текущего owner `elements_planning_packet`, не является путём файловой системы. Offset считает Unicode code points; limit 1–12000, next_offset=null означает конец. Каждый slice содержит тот же полный хеш, source revision и manifest. Читатель не выполняет код, не пишет файлы, не фиксирует baseline и не подтверждает план. Существующие owner/attempt/revision проверки выполняет upstream packet. Проверяющий читает весь пакет и записывает per-file map в baseline.inputs; bind/build/apply и проверка квитанции остаются штатными.

# Нативный Telegram плагин Brai

Компонент `brai-telegram` подключается к штатному gateway Hermes через публичный plugin API закреплённой версии `517b5e10febd619ce30bb22580e29b160266eb43`. Каталог копируется целиком в `HERMES_HOME/plugins/brai-telegram`. Плагин не запускает polling, не заменяет Telegram adapter и сохраняет остальные инструменты Hermes.

## Конфигурация и границы

Защищённое окружение процесса задаёт следующие параметры:

| Переменная | Значение |
| --- | --- |
| `BRAI_TELEGRAM_OWNER_ID` | Обязательный положительный decimal Telegram **user ID** владельца. Не chat ID и не Brai owner. |
| `TELEGRAM_ALLOWED_USERS` | Необязательный список положительных Telegram user ID через запятую, до 20 уникальных ID без пробелов. Дополнительные участники допустимы только для группового route. Участники получают общий доступ к агенту, данным Brai и human решениям владельца в заданном чате; это не отдельные Brai аккаунты. Без значения доступ имеет только владелец. |
| `BRAI_TELEGRAM_CHAT_ID` | Необязательный signed decimal ID единственного рабочего чата. Отрицательный — группа/supergroup; положительный допустим только равный owner. Без значения используется прежний личный чат owner. |
| `BRAI_TELEGRAM_STATE_DIR` | Абсолютный профильный каталог с последним сегментом `brai-telegram`. Содержит private SQLite подтверждений. |
| `BRAI_HERMES_TRUSTED_ENTRY` | Абсолютный путь к `services/hermes/trusted.mjs`. |
| `BRAI_HERMES_NODE_EXECUTABLE` | Абсолютный путь к доверенному Node; окружение экземпляра задаёт `/usr/local/bin/node`. |
| `BRAI_TELEGRAM_RESULT_ROOT` | Точный абсолютный **файловый** `resultRoot` publisher, без завершающего `/`, кроме корня файловой системы. Это не HTTP URL. |
| `BRAI_HERMES_CONFIG` | Наследуемый защищённый JSON config private порта; формат принадлежит [Hermes tools](../CONTRACT.md). |

Состояние принадлежит плагину; Graph и Artifacts принадлежат своим сервисам. Связи: native ingress → owner/route проверка → publisher RPC → exact Markdown; model output → descriptor → fetch RPC → native MEDIA upload; model tool → human prepare → native кнопки → owner callback → read/complete или cancel. Точка сборки — `register(ctx)`, native bot и loop предоставляет factory `(app, adapter)`.

Factory ставит один штатный PTB `TypeHandler(Update, guard)` в группе `-100`, раньше native command/media/callback/inline handlers. Guard допускает только точные chat ID и `effective_user.id` владельца либо явно разрешённого участника; anonymous `sender_chat`, Business и bot identities запрещены. Отказ через `ApplicationHandlerStop` происходит до download, команды, inline ответа и обработки кнопки; ответ чужому отправителю не отправляется. Для группы допустимы group/supergroup/forum, для owner DM — private/dm. Forum topic не является отдельным разрешением: маршрут охватывает заданный чат целиком. Нативный ответ сохраняет исходный thread; human кнопки и уведомления адресованы рабочему чату.

Runtime дополнительно задаёт native `TELEGRAM_ALLOWED_CHATS=chatId`, `TELEGRAM_GROUP_ALLOWED_USERS` и `TELEGRAM_ALLOWED_USERS` со списком владельца и явно назначенных участников; `TELEGRAM_HOME_CHANNEL` при необходимости содержит route. `TELEGRAM_GROUP_ALLOWED_CHATS` и YAML `group_allowed_chats` не используются: в закреплённом Hermes они дают доступ всем участникам. Отрицательные chat ID запрещены в `TELEGRAM_GROUP_ALLOWED_USERS`: Hermes сохраняет legacy chat grant. Нет wildcard, allow-all, guest/observe или bot grants; adapter `allow_from/group_allow_from`, если заданы, содержат только владельца и назначенных участников. Один chat ID без обязательного user owner не активирует плагин. Секреты и пользовательские значения живут только в защищённом runtime, не в исходниках.

Сам Hermes считается доверенным ядром. Защита callback обеспечивает обычный маршрут MCP/Telegram. Она не изолирует private CLI от произвольного кода, запущенного native terminal тем же Unix пользователем с тем же окружением. В интегрированном плане game-core атомарно сверяет текущую revision и снимок claim для всех решений; planning stage также проверяется для legacy Action. У legacy final/review остаются предварительные проверки private порта, общего атомарного CAS для них нет.

## Файлы

`pre_gateway_dispatch` выполняется до штатной авторизации и повторяет owner/route проверку. События других платформ проходят без изменений. Telegram допускается только для `source.user_id` владельца или назначенного участника, точного рабочего `source.chat_id` и соответствующего типа чата, без bot identity, anonymous sender или Business connection. Другие Telegram события получают `skip`.

До десяти уже загруженных native вложений публикуются последовательно через `files.publish`. `requestId=tg:<chatId>:<messageId>:<zero-based-index>` сохраняется при повторной доставке. Publisher проверяет разрешённый read root, owner, ready и SHA-256; его предел — 2 GiB. Точный возвращённый Markdown добавляется к тексту через `rewrite`. Сбой публикации не удаляет уже скачанные native вложения: hook возвращает `rewrite` с исходным текстом, подтверждёнными descriptors и отметкой, что сохранение всех файлов в Brai не подтверждено. `media_urls` и `media_types` остаются у native gateway; отдельное сообщение с просьбой повторить отправку не посылается. Нарушение лимита или неверный message ID по-прежнему дают `skip` до публикации. В журнал попадают только безопасные коды и число файлов, без путей и содержимого. Успешно опубликованные до ошибки файлы не удаляются; повтор использует прежние ключи.

`transform_llm_output` работает только для Telegram. Неизменённый ответ возвращает `None`: native Hermes трактует любую строку как переписанный итог. Это сохраняет финализацию потокового ответа без повторной отправки. Распознаются publisher descriptors `[label](<resultRoot/UUID/filename>)` и `![label](<...>)`, включая экранированные скобки, Unicode и пробелы. UUID должен быть каноническим lowercase. Посторонние URL и пути не вызывают fetch. Каждый artifactId восстанавливается через `files.fetch` один раз. Проверяются идентичность, DTO metadata, точный путь `resultRoot/artifactId/filename`, канонический realpath без symlink и обычный файл. Только после этого descriptor заменяется на quoted `MEDIA:"<localPath>"` для штатной отправки. Ogg/Opus добавляет штатный `[[audio_as_voice]]`. Число вложений — до десяти, общий deadline преобразования — 20 секунд, ниже стандартного 30-секундного hook timeout Hermes. Ошибки остаются видимыми как «Файл не отправлен».

Отдельная строка `MEDIA:/absolute/path` или `MEDIA:"/absolute/path"` также проходит через publisher. Уже опубликованный resultRoot/UUID путь восстанавливается через fetch; рабочий файл публикуется с ключом owner/chat/session/turn/path. Read roots publisher остаются обязательными. В кодовых примерах директивы не исполняются. При ошибке исходный путь заменяется сообщением «Файл не отправлен»; публикация не повторяется автоматически. Общие пределы количества и времени те же.

Native MEDIA parser поддерживает пробелы, Unicode и скобки в quoted path. Пути с double quote, backtick, backslash, control characters или `MEDIA:` отклоняются с видимой ошибкой; плагин не копирует файл и не изменяет descriptor произвольно. Преобразование подготавливает native upload; оно не утверждает, что Telegram уже принял байты. Фактический результат отправки принадлежит gateway.

`transform_tool_result` обрабатывает только успешный JSON `image_generate` в текущем Telegram session context с точными owner/chat/type. Штатный hook получает `tool_name`, `args`, `result`, `session_id`, `tool_call_id`, `turn_id`, `api_request_id`; platform/chat/user читаются через native `gateway.session_context.get_session_env`, не из аргументов модели. Допускается только обычный файл без symlink непосредственно в активном `HERMES_HOME/cache/generated/images`, с расширением PNG/JPEG/WebP/GIF. Пустая session/tool-call identity, чужой контекст или путь закрывают успешный результат явной ошибкой без нового вызова генератора.

Один hook вызывает `files.publish` один раз с `requestId=tg-image:SHA256([owner,chat,sessionId,toolCallId])`. Повтор доставки той же identity использует прежний publisher key; неоднозначная ошибка не вызывает автоматический повтор. Проверяются exact descriptor и publisher DTO/канонический файл той же проверкой, что для исходящих артефактов. Успешный JSON сохраняет provider/model/prompt и прочие metadata, заменяет `image` и имеющиеся native path aliases на опубликованный `localPath`, добавляет точные `artifactId` и `markdown`. Native autoappend получает опубликованную копию; Markdown поддерживает обычную quoted MEDIA отправку. Literal `MEDIA:` внутри metadata кодируется JSON Unicode escape, чтобы native scanner не принял текст prompt за вложение; JSON-содержимое metadata сохраняется. При ошибке возвращается `success:false,image:null,error_type:artifact_publication_failed` без исходного cache path. Другие tools, неуспех image_generate и другие платформы не преобразуются. Успешное вычисление не означает успешную публикацию или upload.

Runtime должен разрешать publisher читать узкий `cache/generated/images`, а native `gateway.media_delivery_allow_dirs` — каталог `results` с опубликованными копиями. Publisher read roots сами по себе не разрешают native delivery из `/var/lib`. Public Bot API допускает входящие документы до 20 MiB и исходящие файлы до 50 MB; publisher 2 GiB не расширяет Telegram limits. Native фото может сжаться; документ отправляется отдельным native методом. Проверка upload, STT/vision и кнопок в живом чате остаётся отдельной DEV-приёмкой.

## Подтверждения

Инструмент показа — `brai_telegram_request_confirmation({moveId,revisionId,stage?})`; stage по умолчанию `planning`, также доступны `final`, `review` и `clarification`. Он не принимает решение, owner или attemptId. Для интегрированного плана этап определяется реальным `fields.planning.decision`, а не аргументом модели: confirm → planning, final → final. Private DTO `confirmationStage` возвращает этот этап; отсутствие поля сохраняет caller stage для legacy Action. Null обозначает практическую работу без кнопки; её фактический результат принимается отдельным `brai_telegram_submit_result({moveId,revisionId})`. Точный публичный API Hermes: `ctx.register_tool(..., handler(args, **kwargs), is_async=True)`. Factory захватывает native loop; вызов из worker loop передаётся через `run_coroutine_threadsafe`, все bot операции выполняются на loop приложения.

Перед `actions.prepare` транзакция SQLite сохраняет случайный opaque token, owner, chatId, move/revision/stage без срока действия. Этот token служит стабильным idempotencyKey prepare. Допускается одна незавершённая запись на move и не более 100 незавершённых записей на профиль. Decision-only confirm/final показываются с одной кнопкой; clarification и практическая работа — без кнопки. Практическое действие может содержать несколько выходов, но фактическое сообщение сопоставляется с каждым выходом явно. Claim создаёт human attempt перед показом задачи; attemptId и канонический stage сохраняются до native отправки. Перед отправкой дополнительно читаются актуальные move status, attemptId, revisionId, human/running. Сообщение показывает задачу, доступные target title/description и понятный русский этап. Технические ID остаются в private state и внутреннем контексте продолжения. В SQLite закрепляется фактический messageId.

Scoped `CallbackQueryHandler(pattern="^brai:")` не перехватывает остальные кнопки Hermes. Callback data не превышает 64 байт. Допускаются только owner, точный исходный chatId/threadId/messageId и сохранённый token. Token атомарно поглощается один раз **до** внешнего эффекта. Подмена, повтор, чужой чат или пользователь не подтверждают действие. `planning/review` допускают только approved; `final` — только success. Private bridge выводит положительный stage из реального integrated decision. Старая revision/attempt не завершается. Прежние кнопки changes/cancelled просят написать решение сообщением и не погашают токен. Технический cleanup обращается только к прежней текущей human/running attempt; новую попытку не отменяет. Изменившаяся revision допускает освобождение прежней attempt.

Поглощение и успешное завершение сохраняются отдельно. Ошибка/timeout complete не повторяет approval и не выдаётся за успех. Кнопки снимаются; пользователь видит неопределённый исход и необходимость проверить Action. Cleanup читает текущую точную attempt и при необходимости отменяет её, после чего возможен новый запрос кнопок. Сбой native отправки также отменяет связанную attempt.

Доставленные pending сохраняются после перезапуска без таймера. Consumed-but-unresolved и незавершённые отправки восстанавливаются отдельно через `actions.cancel(reason=cancelled)`. Прежняя SQLite схема мигрирует chatId в owner DM. При смене route/owner старые tokens немедленно погашаются и очищаются без approval; сообщения с тем же messageId в новом чате их не подтверждают. Cleanup уведомляет сохранённый исходный чат, не переносит старую кнопку или её контекст в новый. Reservation без сохранённого attemptId восстанавливается **тем же** prepare key исключительно для отмены, без повторного approval и без новых кнопок. Private порт гарантирует восстановление прежней running attempt этого ключа, в том числе после смены revision; чужой ключ не может присвоить claimed move. Это закрывает crash между claim и записью attemptId. Crash после успешного complete определяется чтением; уже завершённая/заменённая attempt не отменяется, сообщение остаётся нейтральным.

Если cleanup не подтверждён, native task повторяет проверку через 60 секунд. Каждый повтор сначала читает состояние; complete никогда не повторяется. При недоступном владельце невозможно гарантировать немедленное освобождение attempt: token уже неактивен, статус остаётся неизвестным до успешного чтения/cleanup. `ctx.on_unload` снимает только собственные handlers и tasks, SQLite остаётся для следующего запуска.

## Автоматическое продолжение после кнопки

До показа кнопки модель должна получить реальные Element/Action IDs из существующих game-core create/structure tools и вызвать `elements_request_human_action`. Confirmation принимает возвращённые `moveId/revisionId`; UUID-заглушки и выдуманные IDs запрещены. Плагин не создаёт сущности вместо модели.

`request_confirmation` снимает task-local `HERMES_SESSION_KEY`, `HERMES_SESSION_ID`, thread и owner/route через публичный `gateway.session_context.get_session_env` до перехода на loop бота. Публичный `pre_gateway_dispatch` передаёт `session_store`; плагин сохраняет только этот read-only порт и проверяет `lookup_by_session_key`/origin. Отсутствующая, заменённая или чужая session закрывает запрос до claim. Кнопка и уведомления отправляются в исходный thread. SQLite хранит tokens, exact owner/session agent attempts и один приватный отложенный practical report на owner/move для раздельных сообщений результата и решения. Legacy кнопка без session context не может продолжить работу, но её прежняя попытка по-прежнему очищается.

После единственного известного успешного `actions.complete` проверяется точный succeeded attemptId. В той же token row сохраняется E/M/R/A/stage/decision. Один атомарный `reserve_resume` ставит `attempted` **до** публичного `ctx.inject_message(content, session_key=originalKey)`. Повтор callback или reserve не вызывает второй inject. `approved/success` передаёт модели записанный результат и требование прочитать game-core, продолжить следующий разрешённый шаг исходного запроса и не повторять завершённые действия. `changes` автоматически возвращает беседу к обсуждению и доработке, запрещая выполнять подтверждаемый этап. `cancelled`, stale/source mismatch и неоднозначный complete не вызывают inject. Отмена только освобождает exact human attempt и уведомляет владельца.

Runtime grant: `plugins.entries.brai-telegram.allow_gateway_injection: true` (тип boolean). Плагин использует публичную сигнатуру pin `inject_message(content, role="user", *, session_key=None, origin=None)` только с сохранённым `session_key`; origin/new-session fallback отсутствует. Native самостоятельно восстанавливает реальный source, повторно проверяет текущую авторизацию и создаёт internal event с `allow_gateway_control=False`. Это служебное событие, без fake owner Update и без gateway-команд из текста. При busy native ставит его отдельным FIFO ходом, не steer/interrupt и не объединяет с человеческим сообщением. Модельный вызов выполняет обычный существующий runtime Hermes.

`True` означает только scheduled, не durable admission, завершение хода или выполнение задачи. False/missing host/grant и исключение видны владельцу; автоматического retry нет. Наблюдательный публичный `post_llm_call` отмечает точную исходную session и текст как `observed`; это не подтверждение бизнес-успеха и не неподделываемая граница против доверенного Hermes core. При restart состояния completing/confirmed/attempted/submitted становятся unknown: плагин сообщает неопределённость и не повторяет complete/inject. Native самостоятельно владеет recovery уже начатого хода и отправки ответа. Между reserve и исполнением возможна остановка без продолжения; неопределённость видна, универсальная exactly-once гарантия не обещается.

Перед inject ещё раз проверяются исходные session id и owner/group/thread. Native закрепляет session id при dispatch и отклоняет последующую замену, в том числе пока событие стоит в busy FIFO. Публичный API не принимает expected_session_id исходной кнопки: узкая гонка `/new` между нашим read-check и native lookup остаётся ограничением pin. Internal events обходят `pre_gateway_dispatch/post_gateway_admission`; публичный `pre_llm_call` добавляет context и не является deny guard. Плагин не закрывает этот разрыв private monkeypatch или изменением vendor.

## Подтверждение без веб-интерфейса

Telegram показывает сохранённые название, ожидаемый результат и Ходы текущей ревизии с исполнителями. На итоговой приёмке он показывает содержание только выбранных реальных входов решения. Текст `confirmationText` собирается private портом из game-core, а не из пересказа модели. Отсутствующий результат не получает кнопки слепой приёмки.

После полного текста идёт одна кнопка «Принять». Замечания и отмена передаются обычным сообщением. Длинный текст разбивается без обрезки; одноразовый callback привязан к последнему сообщению с кнопками. Подтверждение и его доверенные проверки не меняются.

## Private RPC и проверки

Схемы операций принадлежат [trusted.openrpc.json](../trusted.openrpc.json). Один вызов запускает отдельный private процесс: одна UTF-8 JSON-RPC 2.0 строка → один ответ с тем же строковым id → выход. До двух процессов одновременно; semaphore ожидание входит в 15-секундный deadline. Запрос до 65536 байт, stdout до 1 MiB. Проверяются версия, id, взаимоисключение result/error и object result. stderr и сырые ошибки не передаются владельцу или модели. Из owner error data передаётся только точный allowlisted код `HUMAN_OUTPUT_REQUIRED`, преобразуемый в локальное понятное сообщение; остальные ошибки скрыты. Timeout завершает всю собственную process group, включая publisher child; уже возможный удалённый эффект считается неизвестным. Автоматического повтора публикации/complete нет; повтор доставки publish применяет стабильный requestId, recovery prepare — прежний idempotencyKey.

Локальная проверка: `python3 -m unittest discover -s services/hermes/telegram/tests -v`. Зависимости не устанавливаются, живой бот не используется. Stubs проверяют native API и thread/loop переходы; SQLite и stdio child processes реальные. При наличии read-only `tmp/hermes-pinned-telegram` отдельные тесты сверяют API и точный MEDIA parser закреплённого исходника. Полный Telegram/Artifacts/game-core сценарий требует отдельной DEV-приёмки с доступным ботом.


## Продолжение native сессии

Запрос кнопок принимает служебный `session_id` из kwargs публичного dispatcher.
На повторном ходе cached agent native очищает ContextVar ID и не создаёт agent
заново; этот случай не должен блокировать кнопки. При наличии двух ID они должны
совпадать. В любом случае проверяются exact persisted SessionStore entry, owner,
chat и topic. ID внутри аргументов модели запрещён; пустая или другая сессия
не создаёт попытку и не отправляет сообщение. Ошибка запроса возвращает только
allowlisted `code` и понятный текст, без raw исключения или секретов.

Для forum General канонический topic `1` сохраняется в привязке сессии.
В `sendMessage` он не передаётся, как в native adapter: Telegram отклоняет
`message_thread_id=1`. Callback того же привязанного сообщения может не
содержать topic; это допустимо только для ожидаемого General. Другой topic,
чат, отправитель или message ID не погашает токен.

## Одно сообщение и бессрочное решение

Инструмент сам отправляет сохранённый план или результат с кнопками. Модель не
пересказывает его отдельно. Только после успешной доставки точный входящий
public MessageEvent отмечается reply_expected=false; Hermes завершает его
штатным NO_REPLY без второго сообщения. Другой входящий запрос и ошибка
отправки сохраняют обычное ожидание ответа. Core и streaming не заменяются.

В private SQLite удаляется прежний expires; истёкшие и уже завершённые решения
не возобновляются. Доставленная активная кнопка сохраняется после перезапуска
и не отменяется со временем. Повторный запрос актуального плана редактирует
ту же карточку и сохраняет attempt. При нажатии заново сверяются revision,
attempt и human/running, исходная сессия и отправитель. Решение одноразовое.
Техническая уборка действует только при незавершённой отправке/обработке,
а не во время ожидания решения человека.


## Текстовые замечания и отмена

`brai_telegram_submit_feedback({elementId,revisionId,moveId?,decision})` доступен
только в реальном Telegram turn владельца. Для changes нужен текущий decision-only
Экшен. Модель выбирает смысл changes/cancelled; исходный текст, chat/topic/message
и стабильный ID поставляет плагин из точного входящего события. Аргумент comment,
положительное решение или сообщение другой сессии не принимаются. Вопрос сам по
себе не является замечанием или отменой; неоднозначный объект требует уточнения.

Практический результат отправляется только через `brai_telegram_submit_result` с
точными `moveId` и `revisionId`; модель не задаёт content/source. Один выход
получает текст текущего сообщения. Для последнего practical Action отчёт может
сохраниться в приватном durable stash, пока отдельное сообщение явно не скажет
«принимаю» или «нужно доработать»; затем завершается тот же Action, а обе
версии источника сообщения сохраняются в provenance. Несколько выходов требуют JSON с
точными названиями контрактов и отдельным decision `success` или `changes`.
Устаревший Action не принимает результат; кнопка не подтверждает работу.

Private `actions.feedback` сохраняет замечания через human complete. На итоговой
приёмке появляются Операция доработки и новый Экшен. При замечаниях к постановке
старое невыполненное продолжение отменяется; новая Операция готовит новую ревизию
тем же принятым сборщиком, после чего требуется новый Экшен подтверждения.
Текущий DEV поддерживает этот полный цикл для отдельной последовательной Задачи.

Отмена проходит через owner API с проверкой revision в той же транзакции. Исходное
сообщение сохраняется ресурсом с происхождением. Невыполненные Ходы и Элементы
всей выбранной ветки получают cancelled; running attempts завершаются с CANCELLED.
Выполненные Ходы, завершённые Элементы и их результаты сохраняются. Повтор того
же сообщения идемпотентен. Старая кнопка после решения больше не запускает работу.

После успешного текстового решения старые клавиатуры снимаются; текущий native
turn сам продолжает разрешённую доработку или сообщает об отмене. Дополнительного
inject для него нет. Старые кнопки changes/cancelled отклоняются до погашения
токена; технический actions.cancel остаётся только для уборки незавершённой доставки.

Общий групповой профиль сохраняет прежний Telegram owner как namespace SQLite, publisher и Brai owner binding. Любой разрешённый участник может принять общую кнопку; проверка exact chat/message/thread/session, актуальной ревизии и одноразовости сохраняется. Все входные guard, session lifecycle, native tool context, публикация изображений и callback используют один список доступа. Отзыв участника запрещает его новые события и продолжение сессий с его origin. Private secret intake остаётся доступен только владельцу.

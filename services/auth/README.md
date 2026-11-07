# Авторизация Brai

Сервис владеет пользователями, OTP и сессиями в отдельной PostgreSQL БД. Неизменённый официальный Better Auth 1.7.6 выполняет регистрацию, проверку и отзыв. Adapter вызывает его HTTP-handler в памяти; открытого HTTP-порта нет. Web обращается через NATS Services `brai_auth`, версия `2.0.0`, queue `brai_auth`; доступны PING, INFO и STATS.

## Контракт

Машинные DTO: [schemas/messages.schema.json](schemas/messages.schema.json). Subjects описаны в [AsyncAPI](asyncapi.yaml).

| Subject | DTO | Эффект |
| --- | --- | --- |
| `brai.auth.v1.send-code` | SendCodeRequest | Письмо sign-in; пользователя не создаёт |
| `brai.auth.v1.verify-code` | VerifyCodeRequest | Проверка кода; регистрация или вход |
| `brai.auth.v1.session` | SessionRequest | GET текущей сессии; `body: null` при отсутствии |
| `brai.auth.v1.sign-out` | SignOutRequest | Отзыв сессии и удаление cookie |
| `brai.auth.v1.sso-issue` | SsoIssueRequest | Одноразовый билет для разрешённого превью |
| `brai.auth.v1.sso-redeem` | SsoRedeemRequest | Погашение билета и установка существующей сессии |

Запрос `{headers, body}` не принимает URL или дополнительные поля. Заголовки: cookie, origin, user-agent, x-forwarded-for, sec-fetch-site. Для мутаций Origin обязателен; исходное значение и Sec-Fetch-Site сохраняются, штатные Origin/CSRF проверки действуют. X-Forwarded-For допускается только от доверенного reverse proxy; web не копирует его из произвольного клиентского ввода. Размер пакета не более 32768 байт; одновременно не более 16 операций на экземпляр.

Ответ `{status, body, setCookies}` сохраняет HTTP-status и JSON Better Auth, включая штатные ошибки 400/401/403/429. Каждый Set-Cookie передаётся отдельной строкой; web передаёт их браузеру без объединения. Session/verify ответы могут содержать токен Better Auth: web использует только нужную идентичность и срок, токен не возвращает клиенту в JSON. Cookie HttpOnly, SameSite=Lax; HTTPS включает Secure. Кэш cookie выключен, каждый session lookup проверяет БД и немедленно учитывает отзыв. `/get-session` исключён из общего ограничения частоты запросов, чтобы лимит входа не блокировал повторную проверку сессии. Остальные ограничения, включая лимит OTP, сохраняются.

Ошибки adapter передаются стандартными заголовками Nats-Service-Error и Nats-Service-Error-Code: 400 INVALID_ARGUMENT, 503 AUTH_BUSY или AUTH_UNAVAILABLE. Payload ошибок не содержит входные данные. Запросы и ответы не попадают в JetStream и журналы; ACL допускают только доверенный web. Таймаут клиента 10 секунд. Отправку и проверку кода автоматически не повторять: после неопределённого verify сначала запросить session; при отсутствии сессии пользователь запрашивает новый код. После неопределённого send пользователь решает, повторять ли запрос с учётом лимита. Session можно повторить; sign-out идемпотентен, повтор после timeout подтверждает отзыв.

Код — строка из шести цифр, включая ведущие нули. Срок 300 секунд, максимум 3 неверных попытки; повторная отправка вращает код. Штатный лимит Email OTP — 3 запроса за 60 секунд. OTP хранится как hash. Сессия — 15552000 секунд с момента входа, disableSessionRefresh=true, активность срок не продлевает.

## Идентичности Telegram (v2)

`AUTH_IDENTITY_MODE=telegram` отключает Email OTP; по умолчанию действует `email`. До переключения нужны миграция, настройка владельца и отдельные ACL NATS. Синтетический email `@identity.brai.invalid` не определяет права. В этом режиме `v1.session` возвращает `user: {id,name,role,status,telegramId,profileId}` и внутренние `session: {id,userId,expiresAt}`; неактивный пользователь получает null. Токен сессии не возвращается.

| Subject `brai.auth.v2.` | Запрос | Ответ |
| --- | --- | --- |
| `telegram-resolve` | `{telegramId}` | `{user}` или null |
| `telegram-code-issue` | `{telegramId,requestId}` | `{code,expiresAt,origin}` |
| `identity-provision` | `{requestId,telegramId,name?,role,userId?,profileId?,status}` | `{user}` |
| `profile-ready` | `{userId,profileId}` | `{user}` или null |
| `invite-redeem` | `{telegramId,code,name?}` | `{user}` или null |
| `login-code-redeem` | `{headers,body:{code}}` | `{status,body,setCookies}` |

Первые пять subjects доступны только доверенному Telegram ingress через ACL, не браузеру и не web. Auth не отправляет сообщения в Telegram. Код — 12 случайных символов Crockford32; регистр и дефисы игнорируются. Срок — 120 секунд; новый код отменяет прежний. В БД хранится HMAC. Выдача ограничена тремя запросами за 60 секунд на пользователя; проверка ограничена по клиенту и глобально, без блокировки владельца подбираемого кода. Погашение одноразово и создаёт новую сессию через официальное расширение Better Auth. Origin и CSRF проверяются, JSON не содержит токен. `requestId` выдачи предназначен для корреляции; после неопределённого ответа новый запрос создаёт новый код.

Provision идемпотентен по `requestId` и точным параметрам; конфликт повтора отклоняется. Telegram ID и profile ID уникальны. Доверенный вызов не может создать первого администратора. `profile-ready` активирует пользователя с совпадающей привязкой, кроме блокированного. После первой административной lifecycle-операции этот путь больше не активирует provisioning: такая учётная запись активируется только подтверждением worker. Приглашение случайно, действительно 24 часа и хранится как HMAC; повторное погашение тем же отправителем возвращает созданного пользователя.

Web операции принимают `{headers,body}` и возвращают `{status,body,setCookies}`; нужны активная admin-сессия и разрешённый Origin. `users-list` возвращает `{users}`, `users-get` с `{userId}` — `{user}`. `role-set` принимает `{userId,role}`, `status-set` — `{userId,status,requestId?}`, `sessions-revoke` — `{userId}`. Последнего активного администратора нельзя заблокировать или понизить: 409 `{code:"LAST_ADMIN"}`. `invite-create` и `invite-list` с пустым body возвращают `{invite}` и `{invites}`; секрет `invite.code` виден только при создании. `invite-revoke` принимает `{inviteId}`. `admin-audit` принимает `{userId,action}`, где action — `memory.list`, `memory.read`, `chats.list`, `chats.read`, `artifacts.list`, `artifacts.read` либо `personal.read`, и возвращает `{auditId}`. Аудит хранит автора из сессии, цель и действие без содержимого и секретов; runtime не может изменять или удалять записи.

Первого владельца создаёт оператор после миграции командой `npm run bootstrap-owner --workspace=@brai/auth`. Через окружение передаются owner `AUTH_DATABASE_URL`, `AUTH_OWNER_ROLE` и `AUTH_BOOTSTRAP_FILE`. Последний указывает на принадлежащий процессу обычный JSON-файл с правами не шире 0600: `{telegramId,name,userId?,profileId?}`. С profileId владелец active, иначе provisioning до `profile-ready`. Повторная настройка запрещена; первый сетевой посетитель не становится владельцем. Данные пользователя не помещают в Git.

После настройки владельца оператор может привязать существующих пользователей командой `npm run import-identities --workspace=@brai/auth`, указав owner `AUTH_DATABASE_URL`, `AUTH_OWNER_ROLE` и `AUTH_IMPORT_FILE`. Файл с теми же требованиями защиты содержит массив `{userId,telegramId,profileId,role,status}`; `profileId` может быть null только для неактивной записи. Импорт выполняется одной транзакцией, повтор идентичных привязок безопасен, конфликт отменяет весь импорт.

## Запуск и обновление

Операторский `revoke-legacy` выполняется только при подтверждённом maintenance и закрытом входе. В окружении задаются owner `AUTH_DATABASE_URL`, `AUTH_OWNER_ROLE`, runtime `AUTH_APP_ROLE` и стабильный `AUTH_REVOKE_REQUEST_ID`. Одна транзакция блокирует таблицы Better Auth, переносит прежние session и verification в owner-only схему `auth_identity_owner`, удаляет исходные строки и сохраняет счётчики. Повтор того же ID не удаляет новые записи. Вывод содержит только счётчики, время и признак повтора, без токенов; runtime и PUBLIC не имеют доступа к схеме и таблицам.

Восстановление тех же строк возможно только до открытия входа с `AUTH_CUTOVER_ACTION=restore`, `AUTH_ROLLBACK_PREOPEN=1` и тем же ID; внешняя операторская проверка обязана подтвердить закрытый вход. Транзакция отказывает, если после отзыва появились новые session или verification. Повторное восстановление и отзыв уже восстановленной операции отклоняются. Снимок содержит секретные токены и подлежит защищённому хранению; автоматическое восстановление после открытия запрещено.

Входы: AUTH_DATABASE_URL, AUTH_SECRET (не менее 32 символов), AUTH_ORIGIN (публичный origin без path), AUTH_IDENTITY_MODE; в режиме email также обязательны AUTH_EMAIL_FROM и RESEND_API_KEY. NATS_SERVERS (через запятую) либо NATS_URL, NATS_USER/NATS_PASSWORD либо NATS_CREDS_FILE, при TLS NATS_CA_FILE. AUTH_TRUSTED_ORIGINS необязателен и добавляет доверенные origin через запятую к AUTH_ORIGIN. Каждый адрес должен быть полным http/https origin без пути, учётных данных и wildcard. Origin и CSRF по-прежнему проверяет Better Auth. Нет встроенных адресов экземпляра.

БД и роли создаёт администратор. `npm run migrate --workspace=@brai/auth` использует owner URL и штатный `getMigrations(auth.options)`; AUTH_OWNER_ROLE обязан совпасть с владельцем БД и current_user; отдельная непривилегированная AUTH_APP_ROLE без членства в других ролях получает DML-права только в собственной БД. Runtime получает app URL без DDL-прав. Миграция запускается отдельно; старт не меняет схему. При обновлении официального пакета закрепить версию, пересоздать план миграций и повторить проверки на изолированном стенде, затем применить миграцию. Патчи и форк запрещены.

`npm test --workspace=@brai/auth` проверяет transport и письмо. `tests/integration/compose.yml` создаёт tmpfs PostgreSQL на 15459; `npm run test:integration --workspace=@brai/auth` проверяет официальный движок, cookie, сроки, Origin, отзыв, OTP, лимиты и SQL-права. Все данные синтетические. Resend callback ожидает ответ провайдера; положительный результат означает принятие письма, доставка в ящик не обещается. Проверка домена и реальной доставки выполняется при развёртывании.

## Одноразовый вход в превью

SSO выключен без пары AUTH_SSO_HUB_ORIGIN и AUTH_SSO_PREVIEW_ORIGINS. Hub равен AUTH_ORIGIN; оба значения и каждый origin превью — точные HTTPS origin без пути и wildcard. Превью также входят в AUTH_TRUSTED_ORIGINS. Issue принимает cookie активной сессии hub и `{targetOrigin,challenge}`; ответ содержит `{ticket}`. Redeem принимает `{ticket,verifier,targetOrigin}` от соответствующего origin и возвращает `{success:true}` и host-only cookie той же сессии. Challenge — base64url без padding от SHA-256 UTF-8 строки verifier; verifier — base64url без padding от 32 случайных байт. Оба имеют 43 символа. Билет зашифрован, действует не более 60 секунд и используется один раз. Ошибки не возвращают секреты или cookie. Автоматически не повторять issue и redeem; после неопределённого redeem проверить session. Отзыв исходной сессии действует также для превью.

## Очередь пользовательских окружений

Web-команды используют оболочку `{headers,body}`, действующую admin-сессию и разрешённый Origin; ответ `{status,body,setCookies}`. DTO принадлежат JSON Schema.

| Subject `brai.auth.v2.` | body | body ответа |
| --- | --- | --- |
| `users-add` | `{requestId,telegramId}` | `{user,operation}` |
| `users-revoke` | `{requestId,userId}` | `{user,operation}` |
| `users-operation-get` | `{requestId}` | `{operation,user?}`, operation null для неизвестного ID |

Новый пользователь получает роль user, UUID userId и profileId, статус provisioning. Восстановление blocked сохраняет IDs, роль, имя и данные. Для active создание возвращает ту же учётную запись и завершённую операцию без подготовки. Отзыв сразу ставит blocked и удаляет сессии и коды входа в одной транзакции с аудитом. Последнего активного admin нельзя отозвать, понизить или перевести в provisioning: 409 LAST_ADMIN.

`status-set` active/blocked проходит ту же очередь prepare/stop. provisioning также ставит prepare, но успешная подготовка сохраняет provisioning. Для надёжного повтора клиент передаёт requestId; старые клиенты без него получают новый ID на каждый вызов. `users-list` и `users-get` возвращают `user.lifecycle: {id,requestId,kind,state,errorCode}|null`. Отдельная operation содержит также userId и целочисленное generation. Состояния: pending, running, succeeded, failed, cancelled. LeaseToken в web-ответы не входит.

RequestId уникален глобально. Повтор с тем же автором и параметрами возвращает прежнюю операцию, даже после более нового отзыва; другие параметры дают 409 REQUEST_CONFLICT. Старый запрос не создаёт новое поколение. Новое действие увеличивает поколение пользователя и отменяет его pending/running операции. Ошибка worker фиксирует failed; автоматического повтора failed нет, нужна новая команда администратора с новым requestId.

Только доверенный lifecycle worker через отдельные NATS ACL вызывает:

| Subject `brai.auth.v2.` | Запрос | Ответ |
| --- | --- | --- |
| `lifecycle-claim` | `{workerId}` | `{operation:null\|{id,requestId,userId,generation,kind,state,errorCode,leaseToken,user}}` |
| `lifecycle-renew` | `{operationId,leaseToken}` | `{accepted}` |
| `lifecycle-complete` | `{operationId,leaseToken,success,errorCode?}` | `{accepted,operation}` |

kind — prepare либо stop. user содержит id,name,role,status,telegramId,profileId. Глобально выдаётся одна аренда на 45 секунд; worker продлевает её каждые 10 секунд. При потере аренды worker прекращает собственную работу. До её завершения или истечения следующая работа не выдаётся, включая отменённую операцию. Истечение позволяет повторить незавершённую работу с новым leaseToken. Эффекты worker обязаны быть идемпотентны; сеть не гарантирует однократное выполнение. Только актуальная running prepare с действующей арендой активирует provisioning после успеха; blocked не активируется. Устаревший или неверный lease получает accepted:false. stop сохраняет blocked. Подтверждение отменённой работы своим ещё действующим token освобождает аренду и возвращает accepted:false.

errorCode — безопасная константа `[A-Z][A-Z0-9_]{0,63}`; вывод внешних команд, пути и секреты не передаются. Таймаут запроса 10 секунд. После неопределённой web-мутации опросить users-operation-get с прежним requestId или повторить те же параметры. После неопределённого claim подождать срок аренды; renew и complete допускают повтор, после принятого complete повтор получает accepted:false и текущее состояние. Внутренние subjects недоступны web-процессу.

Данные очереди принадлежат Auth. Миграция добавляет поколение с начальным 0 без замены существующих IDs и таблицу brai_user_operation с комментариями. Обычный migrate предоставляет runtime DML на новую public-таблицу, сохраняя ограничения аудита и owner-only схемы.

Каждая Telegram-сессия хранит brai_generation, совпадающее с текущим поколением доступа. После погашения кода сессия создаётся официальным Better Auth, затем Auth атомарно подтверждает то же active-поколение; старый код при гонке с revoke/restore не получает действительную сессию. Проверки текущей сессии и admin-действия сверяют поколение при каждом обращении. Миграция даёт существующим идентичностям и сессиям поколение 0. Добавление уже активного пользователя сохраняет существующие действующие сессии, переносит только совпадающее прежнее поколение и не восстанавливает устаревшие сессии.

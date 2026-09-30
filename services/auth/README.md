# Авторизация Brai

Сервис владеет пользователями, OTP и сессиями в отдельной PostgreSQL БД. Неизменённый официальный Better Auth 1.7.6 выполняет регистрацию, проверку и отзыв. Adapter вызывает его HTTP-handler в памяти; открытого HTTP-порта нет. Web обращается через NATS Services `brai_auth`, версия `1.0.0`, queue `brai_auth`; доступны PING, INFO и STATS.

## Контракт

Машинные DTO: [schemas/messages.schema.json](schemas/messages.schema.json). Subjects описаны в [AsyncAPI](asyncapi.yaml).

| Subject | DTO | Эффект |
| --- | --- | --- |
| `brai.auth.v1.send-code` | SendCodeRequest | Письмо sign-in; пользователя не создаёт |
| `brai.auth.v1.verify-code` | VerifyCodeRequest | Проверка кода; регистрация или вход |
| `brai.auth.v1.session` | SessionRequest | GET текущей сессии; `body: null` при отсутствии |
| `brai.auth.v1.sign-out` | SignOutRequest | Отзыв сессии и удаление cookie |

Запрос `{headers, body}` не принимает URL или дополнительные поля. Заголовки: cookie, origin, user-agent, x-forwarded-for, sec-fetch-site. Для мутаций Origin обязателен; исходное значение и Sec-Fetch-Site сохраняются, штатные Origin/CSRF проверки действуют. X-Forwarded-For допускается только от доверенного reverse proxy; web не копирует его из произвольного клиентского ввода. Размер пакета не более 32768 байт; одновременно не более 16 операций на экземпляр.

Ответ `{status, body, setCookies}` сохраняет HTTP-status и JSON Better Auth, включая штатные ошибки 400/401/403/429. Каждый Set-Cookie передаётся отдельной строкой; web передаёт их браузеру без объединения. Session/verify ответы могут содержать токен Better Auth: web использует только нужную идентичность и срок, токен не возвращает клиенту в JSON. Cookie HttpOnly, SameSite=Lax; HTTPS включает Secure. Кэш cookie выключен, каждый session lookup проверяет БД и немедленно учитывает отзыв.

Ошибки adapter передаются стандартными заголовками Nats-Service-Error и Nats-Service-Error-Code: 400 INVALID_ARGUMENT, 503 AUTH_BUSY или AUTH_UNAVAILABLE. Payload ошибок не содержит входные данные. Запросы и ответы не попадают в JetStream и журналы; ACL допускают только доверенный web. Таймаут клиента 10 секунд. Отправку и проверку кода автоматически не повторять: после неопределённого verify сначала запросить session; при отсутствии сессии пользователь запрашивает новый код. После неопределённого send пользователь решает, повторять ли запрос с учётом лимита. Session можно повторить; sign-out идемпотентен, повтор после timeout подтверждает отзыв.

Код — строка из шести цифр, включая ведущие нули. Срок 300 секунд, максимум 3 неверных попытки; повторная отправка вращает код. Штатный лимит Email OTP — 3 запроса за 60 секунд. OTP хранится как hash. Сессия — 15552000 секунд с момента входа, disableSessionRefresh=true, активность срок не продлевает.

## Запуск и обновление

Входы: AUTH_DATABASE_URL, AUTH_SECRET (не менее 32 символов), AUTH_ORIGIN (публичный origin без path), AUTH_EMAIL_FROM, RESEND_API_KEY; NATS_SERVERS (через запятую) либо NATS_URL, NATS_USER/NATS_PASSWORD либо NATS_CREDS_FILE, при TLS NATS_CA_FILE. Нет встроенных адресов экземпляра.

БД и роли создаёт администратор. `npm run migrate --workspace=@brai/auth` использует owner URL и штатный `getMigrations(auth.options)`; AUTH_OWNER_ROLE обязан совпасть с владельцем БД и current_user; отдельная непривилегированная AUTH_APP_ROLE без членства в других ролях получает DML-права только в собственной БД. Runtime получает app URL без DDL-прав. Миграция запускается отдельно; старт не меняет схему. При обновлении официального пакета закрепить версию, пересоздать план миграций и повторить проверки на изолированном стенде, затем применить миграцию. Патчи и форк запрещены.

`npm test --workspace=@brai/auth` проверяет transport и письмо. `tests/integration/compose.yml` создаёт tmpfs PostgreSQL на 15459; `npm run test:integration --workspace=@brai/auth` проверяет официальный движок, cookie, сроки, Origin, отзыв, OTP, лимиты и SQL-права. Все данные синтетические. Resend callback ожидает ответ провайдера; положительный результат означает принятие письма, доставка в ящик не обещается. Проверка домена и реальной доставки выполняется при развёртывании.

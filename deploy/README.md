# Production образы Brai

`compose.production.yml` собирает web, auth и timer из корня репозитория и запускает их в раздельных контейнерах. Сборка требует закреплённые Node.js и npm из корневого `package.json`. Внешние сети NATS, базы данных и reverse proxy создаёт инфраструктура до запуска стека.

Web подключается к сети NATS и к сети reverse proxy. Auth и timer подключаются к NATS и закрытой сети базы данных. Внешний прокси должен направлять запросы к `web:3000`. Compose публикует web только на loopback хоста. Auth и timer не публикуют порты.

Перед запуском подготовьте шесть отдельных защищённых env-файла:

- `web.env`: `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX=_INBOX.brai_web`, `WEB_ORIGIN`;
- `timer.env`: `DATABASE_URL` прикладной роли, `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX=_INBOX.brai_timer`;
- `timer-migration.env`: `DATABASE_URL` владельца БД, `TIMER_OWNER_ROLE`, `TIMER_APP_ROLE`;
- `auth.env`: `AUTH_DATABASE_URL` собственной прикладной роли, `AUTH_SECRET` (не менее 32 символов, сохраняйте при перезапуске), `AUTH_ORIGIN`, `AUTH_EMAIL_FROM`, отдельные `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`;
- `auth-migration.env`: `AUTH_DATABASE_URL` собственного владельца БД, `AUTH_SECRET`, `AUTH_ORIGIN`, `AUTH_EMAIL_FROM`, `AUTH_OWNER_ROLE`, `AUTH_APP_ROLE`;
- `resend.env`: `RESEND_API_KEY` существующего ключа Resend. Файл подключается непосредственно только к auth runtime.

Создайте auth БД и две отдельные минимальные login роли без административных флагов и членства. Ограничьте auth роли собственной БД, timer роли собственной БД; web не получает SQL входов. Владелец auth применяет штатные миграции Better Auth и выдаёт runtime только DML права.

Передайте compose абсолютные пути к этим файлам через `WEB_ENV_FILE`, `TIMER_ENV_FILE` и `TIMER_MIGRATION_ENV_FILE`, `AUTH_ENV_FILE`, `AUTH_MIGRATION_ENV_FILE`, `RESEND_ENV_FILE`. Передайте имена созданных сетей через `BRAI_FRONTEND_NETWORK`, `BRAI_NATS_NETWORK` и `BRAI_DATABASE_NETWORK`. Не помещайте пароли в файлы интерполяции Compose или Git.

Сначала соберите образы и примените миграцию отдельным одноразовым контейнером:

```sh
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml build
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml --profile migration run --rm --no-deps auth-migrate
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml --profile migration run --rm --no-deps timer-migrate
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml up -d
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml up -d --no-deps --wait web
```

Миграторы получают только собственные owner env-файлы и завершаются после `node dist/migrate.js`. Runtime не применяет DDL. Web запускается независимо от backend и проверяет готовность страницы через HTTP. Auth проверяет собственную БД и NATS; timer проверяет PostgreSQL и JetStream без записи данных. Запросы и события таймера требуют действующую сессию. Один экземпляр web владеет durable consumer `web_events`.

При выпуске сначала обновите auth и timer и дождитесь их готовности, затем обновите web. Если web получает запросы через доверенный proxy, задайте `WEB_TRUST_PROXY=true` только при закрытом прямом публичном доступе к web; proxy должен удалять подставленные клиентом forwarding headers.

Переход с анонимного v1 несовместим. Остановите прежние web и timer, очистите только `timer.state`, `timer.commands`, `timer.intervals` (сохраните `timer.migrations`), удалите только старые `BRAI_TIMER_COMMANDS` и `BRAI_TIMER_EVENTS` штатным JetStream admin API. Зафиксируйте завершение этой одноразовой операции отдельно; повторный выпуск не очищает личные данные. Затем примените миграции, включите v2 ACL и запускайте новые сервисы. Новые streams — `BRAI_TIMER_COMMANDS_V2`, `BRAI_TIMER_EVENTS_V2`; старые subjects ACL запрещает. Не импортируйте старый клиентский outbox в аккаунт.

PostgreSQL и NATS хранят данные в устойчивых томах конфигурации `dependencies/`. Production compose подключается к их сетям и не создаёт собственные тома данных. Останавливайте приложения командой `docker compose ... stop`; для удаления стека используйте `down` без `-v`.

## Supabase MCP

`supabase-mcp` входит в Compose-проект `brai` как отдельная служба с профилем `supabase-mcp`. Обычный запуск web, auth и timer её не запускает. Служба подключается к закрытой сети PostgreSQL и к отдельной bridge-сети MCP. Инфраструктура заранее создаёт обе внешние сети; имя второй задаёт `BRAI_MCP_NETWORK` (по умолчанию `brai_mcp`). Внутри MCP-сети адрес службы — `supabase-mcp:3001/mcp`.

Compose собирает образ из `services/supabase-mcp/Dockerfile` и даёт ему тег `BRAI_SUPABASE_MCP_IMAGE` (по умолчанию `brai-supabase-mcp:production`). Если используется готовый образ, передайте его тег этой переменной. Конфигурацию и пароль Compose подключает из внешних read-only файлов: `BRAI_SUPABASE_MCP_CONFIG_FILE` и `BRAI_SUPABASE_MCP_PASSWORD_FILE`. Значения по умолчанию нужны только для проверки общего Compose и не являются конфигурацией рабочего экземпляра.

JSON-файл конфигурации должен задавать `host: "0.0.0.0"`, `port: 3001`, экземпляры PostgreSQL и `passwordFile: "/run/secrets/postgres_password"`. Добавьте в `allowedHosts` внутренний адрес `supabase-mcp:3001` и фактические loopback Host значения клиента. Loopback-порт хоста задаёт `BRAI_SUPABASE_MCP_HOST_PORT` (по умолчанию `3001`); конфигурация должна разрешать этот порт. Адреса БД, TLS и остальные параметры принадлежат внешнему config-файлу. Не помещайте пароль в JSON: отдельный файл содержит байты пароля и монтируется только для чтения.

Соберите и запустите службу отдельно от основного набора:

```sh
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml --profile supabase-mcp build supabase-mcp
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml --profile supabase-mcp up -d --no-deps --wait supabase-mcp
```

Compose публикует MCP только на `127.0.0.1`. Host-агент обращается к адресу `http://127.0.0.1:<BRAI_SUPABASE_MCP_HOST_PORT>/mcp`; контейнеры в сети MCP используют `http://supabase-mcp:3001/mcp`. Порт `BRAI_SUPABASE_MCP_HOST_PORT` должен входить в `allowedHosts`.

## Проверка production образов

Изолированный `compose.production-test.yml` собирает те же Dockerfiles. Он запускает PostgreSQL и NATS с открытыми тестовыми учётными данными и данными в `tmpfs`; база недоступна через опубликованный порт, NATS отделён от неё сетью. Web доступен только на `127.0.0.1:13000`.

```sh
docker compose -f deploy/compose.production-test.yml up -d --build --wait
curl --fail http://127.0.0.1:13000/
# Без сессии /api/timer и /api/timer/events должны вернуть 401.
docker compose -f deploy/compose.production-test.yml down -v --remove-orphans
```

Стенд не подключается к внешним production сетям и не монтирует каталоги production данных. Удалите его после проверки через последнюю команду.

## Host agent

### Сборка переносимого артефакта

Выполняйте сборку из чистого checkout продукта. Нужны точная Git-ревизия, установленный Node.js `24.21.0` и npm `11.19.0`. Сборщик проверяет ревизию, закреплённые версии, очищает временные npm-конфиги, устанавливает workspace-зависимости, собирает agent, оставляет production-зависимости и проверяет ссылки внутри артефакта. Он не запускает собранный сервис.

```sh
node deploy/scripts/build-agent-artifact.mjs \
  --source /absolute/path/to/brai-checkout \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --output /absolute/path/to/new-agent-artifact
```

`--source` должен быть корнем Git checkout, `--revision` — полный lowercase commit hash из 40 символов, а родительский каталог `--output` должен существовать. Путь результата должен быть новым и находиться вне source checkout. Сборщик не перезаписывает существующий результат.

Артефакт содержит `services/agent/dist`, публичные контракты и схемы, manifest с source revision/toolchain/production dependency graph и production `node_modules`. Manifest перечисляет entrypoints `services/agent/dist/main.js` и `services/agent/dist/health.js`. Внутренние workspace-ссылки на исключённые пакеты удаляются; все оставшиеся symlink должны разрешаться внутри артефакта.

### Запуск и остановка

Подготовьте внешний JSON config с правами, ограниченными владельцем процесса. Контракт конфигурации описан в [`services/agent/README.md`](../services/agent/README.md). Укажите абсолютный путь через `BRAI_AGENT_CONFIG`; конфиг содержит явные Codex socket URL, NATS endpoint и учётные данные, а также список проектов. `allowedModels` можно опустить. Не храните конфиг и секреты в артефакте.

Запустите entrypoint дочерним процессом оболочки, чтобы сохранить его PID:

```sh
BRAI_AGENT_CONFIG=/absolute/path/to/agent-config.json \
  node /absolute/path/to/agent-artifact/services/agent/dist/main.js &
agent_pid=$!
BRAI_AGENT_CONFIG=/absolute/path/to/agent-config.json \
  node /absolute/path/to/agent-artifact/services/agent/dist/health.js
kill -TERM "$agent_pid"
wait "$agent_pid"
```

Health требует успешного status endpoint с `ready: true`; ответ NATS PING сам по себе не подтверждает готовность. `kill` и `wait` относятся только к PID, запущенному этой оболочкой. Не используйте широкие команды остановки процессов.

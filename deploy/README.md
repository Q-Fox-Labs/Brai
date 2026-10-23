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

Изолированный `compose.production-test.yml` — общий startup smoke, а не browser-auth end-to-end стенд. Перед запуском нужны prepared contexts для текущих web/artifacts и заранее принятые auth/timer image tags. Значения `BRAI_WEB_RUNTIME_CONTEXT`, `BRAI_ARTIFACTS_RUNTIME_CONTEXT`, `BRAI_SOURCE_REVISION`, `BRAI_ARTIFACTS_IMAGE`, `BRAI_AUTH_IMAGE` и `BRAI_TIMER_IMAGE` передаются через отдельный compose env-файл. Для file Caddy задайте свободные `BRAI_ARTIFACTS_TEST_SUBNET` и адрес шлюза `BRAI_ARTIFACTS_PRIVATE_HOST_IP`; listener привязывается к этому адресу, который одинаково доступен host и контейнерам. Test PostgreSQL и NATS используют фиктивные данные в `tmpfs`, не публикуют БД и не подключаются к production сетям. Web доступен только на `127.0.0.1:13000`. Это общий startup smoke; он не проверяет полный browser auth/raw upload flow.

```sh
# Явные одноразовые шаги только для свежего test volume и schema.
docker compose --env-file /path/to/release-test.compose.env -f deploy/compose.production-test.yml --profile artifacts-initialize run --rm --build --no-deps artifacts-volume-init
docker compose --env-file /path/to/release-test.compose.env -f deploy/compose.production-test.yml --profile migration run --rm --build artifacts-migrate
# Runtime startup не выполняет и не ожидает initializer или DDL.
docker compose --env-file /path/to/release-test.compose.env -f deploy/compose.production-test.yml up -d --build --wait
curl --fail http://127.0.0.1:13000/
# Без сессии /api/timer и /api/timer/events должны вернуть 401.
docker compose --env-file /path/to/release-test.compose.env -f deploy/compose.production-test.yml down -v --remove-orphans
```

Для проверки edge attachment/auth и raw upload используйте отдельный isolated Caddy fixture: общий image smoke не создаёт browser session и не проверяет web-to-artifact authorization. Удалите временный стенд через последнюю команду после smoke.

## Host agent

Agent работает вне контейнера, рядом с готовым Codex app server. Универсальный продукт не требует admin или конкретного домена/сервера.

Для переносимого выпуска выполните `node deploy/scripts/build-agent-artifact.mjs --source /absolute/repository --revision <40-char-commit> --output /absolute/new-artifact`. Требуются закреплённые Node24.22.1/npm11.19.1. Builder использует только заданный Git commit и locked production dependencies. Артефакт содержит compiled agent, contracts, package и production node_modules; workspace исходники, тесты и admin не поставляются. Manifest v2 содержит точную sourceRevision и toolchain; npm lock остаётся владельцем dependency inventory.

Запуск: `BRAI_AGENT_CONFIG=/absolute/config.json node /absolute/artifact/services/agent/dist/main.js`. Health запускается тем же способом с `dist/health.js`. SIGINT/SIGTERM освобождает собственные подключения. Сам Codex app server не запускается и не перезапускается. Его endpoint, NATS credentials, проекты и модели задаются внешней защищённой конфигурацией.

## Artifact storage (optional)

Хранилище не входит в active-v2 stack по умолчанию. Для включения добавьте `-f deploy/compose.artifacts.yml` к командам Compose; базовый файл `compose.production.yml` остаётся пригоден для существующих экземпляров без новых artifact-переменных. `Caddyfile.agent-attachments` — повторно используемый Caddy named snippet для публичного edge. Подключите сам файл на global уровне Caddyfile через `import /path/Caddyfile.agent-attachments`, а внутри нужного HTTPS site block вызовите `import artifact-attachment`. `artifact-attachment` передаёт текущую Cookie и полный исходный URI/метод в web auth endpoint, стирает клиентские spoofable artifact headers, переносит только доверенные `Content-Type` и `Content-Disposition` успешного ответа авторизации и проксирует байты на закрытый file Caddy. Для сырого upload подключите `import artifact-upload` в том же site block и задайте `BRAI_ARTIFACTS_UPLOAD_UPSTREAM=artifacts:3004` на edge. Snippet принимает только `/upload/{token}` формата `[A-Za-z0-9_-]{16,512}` и метод PUT, удаляет Cookie/Authorization и передаёт тело напрямую контроллеру; Next не проксирует байты. Публичный `/files` маршрут не публикуется. `Caddyfile.artifacts-files` обслуживает только UUID из `files/` и не подключается к PostgreSQL, NATS или web; единственный дополнительный URL `/health` отвечает 204 и используется только private readiness check.

Перед первым запуском инфраструктура создаёт dedicated external Docker volume с именем `BRAI_ARTIFACTS_DATA_VOLUME` и external bridge network `BRAI_ARTIFACTS_PRIVATE_NETWORK`. Укажите `BRAI_ARTIFACTS_PRIVATE_HOST_IP` — один частный адрес gateway, достижимый host-agent и контейнерами; внутренний Caddy порт по умолчанию `9080`. `ARTIFACTS_INTERNAL_BASE_URL` в `artifacts.env` должен указывать на `http://<этот-частный-IP>:9080`; это закрытый адрес хранения, не адрес браузерной загрузки. При включении browser attachments задайте одинаковый `ARTIFACTS_UPLOAD_BASE_URL` в отдельных `web.env` и `artifacts.env`: это public Brai root origin без пути (например, `https://brai.example`). Не объединяйте файлы и не передавайте web credentials сервису artifacts. Браузер отправляет сырой PUT на same-origin `/upload/{token}` через публичный edge; edge передаёт байты напрямую controller `artifacts:3004`, без body proxy через Next. `ARTIFACTS_HTTP_HOST` внутри контейнера задан в `0.0.0.0`; наружу порт `3004` не публикуется. Metadata prepare/finalize остаются Next API routes; web и artifacts обмениваются metadata через NATS.

Отдельный volume initializer — одноразовая операция только при первом создании пустого тома. Он создаёт root и `files/` с UID:GID `1000:1000`, режимом `0750`, а `tmp/` с режимом `0700`; runtime пишет файлы `0640`, временные файлы — `0600`. Повторно запускать initializer на существующем/восстановленном томе нельзя: восстановление проверяет прежние права и содержимое. Caddy работает с UID:GID `1000:1000`, получает только `files/` read-only из того же volume. Временные и готовые файлы остаются на одной файловой системе для atomic hard-link publication.

Для первого пустого тома после сборки artifact image выполните initializer явно, затем отдельно подготовьте БД/роли и примените owner-миграцию. Пример для уже собранных image tags и созданных external network/volume:

```sh
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml -f deploy/compose.artifacts.yml --profile artifacts-initialize run --rm --no-build --no-deps artifacts-volume-init
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml -f deploy/compose.artifacts.yml --profile migration run --rm --no-build --no-deps artifacts-migrate
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml -f deploy/compose.artifacts.yml up -d --no-deps artifacts artifacts-files
```

`artifacts.env` задаёт отдельный runtime-role `ARTIFACTS_DATABASE_URL`, выделенный NATS service identity через `NATS_URL` и credentials, `ARTIFACTS_UPLOAD_BASE_URL`, `ARTIFACTS_INTERNAL_BASE_URL`; web получает тот же public `ARTIFACTS_UPLOAD_BASE_URL` через свой отдельный `web.env`. Compose устанавливает `ARTIFACTS_DATA_DIR=/var/lib/brai-artifacts`. Отдельный `artifacts-migration.env` содержит owner connection и имена `ARTIFACTS_OWNER_ROLE`/`ARTIFACTS_APP_ROLE`; владелец и приложение должны использовать разные минимальные роли. Runtime и Caddy не выполняют DDL. Настройки Caddy UID/GID по умолчанию `1000:1000`, при необходимости их задают `BRAI_ARTIFACTS_CADDY_UID` и `BRAI_ARTIFACTS_CADDY_GID`, совпадающими с владельцем файлов.

Для MCP включите только профиль `artifacts-mcp` после запуска основного хранилища: он использует NATS, не подключается к БД или volume и по умолчанию публикует `3005` только на loopback. При bind внутри частной MCP-сети задайте оба allowlist (`ARTIFACTS_MCP_ALLOWED_HOSTS` и `ARTIFACTS_MCP_ALLOWED_ORIGINS`) явно. Public HTTP attachment endpoint допускает GET/HEAD после browser-session auth и только image/png, image/jpeg и image/webp показываются inline; остальные типы скачиваются как attachment с `nosniff` и `no-store`.

### Offline prepared runtime

Обычные Dockerfiles остаются для чистых внешних consumers и используют `npm ci`. Для выпуска из подготовленного runtime без package install сначала соберите web штатным локальным Next wrapper из чистого checkout точного source commit (`CI=1 BRAI_WEB_STANDALONE_OUTPUT=0 npm run build --workspace=@brai/web`; эта команда использует локальный Webpack launcher), затем materialize точные установленные production closures:

```sh
REV=<40-char-commit>
node deploy/scripts/materialize-runtime.mjs --source "$PWD" --workspace @brai/web --revision "$REV" --output /absolute/release/web-runtime
node deploy/scripts/materialize-runtime.mjs --source "$PWD" --workspace @brai/artifacts --revision "$REV" --output /absolute/release/artifacts-runtime
node deploy/scripts/materialize-runtime.mjs --source "$PWD" --workspace @brai/timer --revision "$REV" --output /absolute/release/timer-runtime
node deploy/scripts/build-agent-artifact.mjs --source "$PWD" --revision "$REV" --output /absolute/release/agent-artifact --prepared-dependencies
```

Materializer ничего не устанавливает и не собирает; он требует точное совпадение Git revision, чистое дерево и готовые `.next`/`dist`, сверяет каждый установленный пакет с точной версией lock entry, копирует symlink targets в самодостаточную closure, сохраняя расположение locked dependencies как в корневом `node_modules`, так и в `node_modules` объявленных workspaces и записывает newline-terminated manifest. Для prepared web/artifacts используйте оба Compose overlay: `compose.artifacts.yml` и `compose.prepared.yml`, передав абсолютные `BRAI_WEB_RUNTIME_CONTEXT`, `BRAI_ARTIFACTS_RUNTIME_CONTEXT`, `BRAI_SOURCE_REVISION`; prepared Dockerfiles делают только `COPY`. В `compose.production-test.yml` изменённые web/artifact images собираются из этих runtime contexts, а auth/timer получают заранее принятые образы через `BRAI_AUTH_IMAGE` и `BRAI_TIMER_IMAGE`; test Compose не объявляет неподдерживаемые prepared-контексты для auth/timer. Финальные release bundles/images принимаются только после web local acceptance и привязки к commit, чей hash равен `sourceRevision` manifest/image label.

Prepared timer также использует `services/timer/Dockerfile.prepared`: упаковка выполняет только COPY готовых `dist`, `schemas`, `migrations` и точной runtime closure. Отдельная owner-команда миграций остаётся обязательной; startup таймера не меняет схему.

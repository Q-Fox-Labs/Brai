# Сборка и запуск service_history

`deploy/compose.history.yml` запускает историю в отдельном Compose-проекте `brai-history`. Образ содержит только готовый runtime сервиса, его JSON-схемы, SQL-миграции и установленное транзитивное production-закрытие зависимостей. PostgreSQL и NATS остаются внешними сервисами и сохраняют свои данные независимо от контейнера истории.

## Подготовить образ

Сначала соберите TypeScript-сервис с закреплёнными Node.js 24.21.0 и npm 11.19.0 и установленными зависимостями корневого lockfile:

```sh
npm run build --workspace=@brai/history
node services/history/scripts/package-runtime.mjs
```

Помощник упаковки формирует `tmp/history-runtime/`, проверяет наличие `dist/main.js`, `dist/migrate.js`, `dist/health.js`, схем, миграций и каждого пакета рабочей среды из lockfile. Он копирует только транзитивные рабочие зависимости с сохранением вложенных версий и разыменованием ссылок. Он не устанавливает пакеты и не обращается к сети. Артефакт служит контекстом Docker-сборки и не входит в Git.

Передайте Compose через отдельный защищённый файл интерполяции имена существующих внешних сетей и пути к runtime env-файлу, миграционному env-файлу и файлу ключа. Используются переменные `BRAI_NATS_NETWORK`, `BRAI_DATABASE_NETWORK`, `HISTORY_ENV_FILE`, `HISTORY_MIGRATION_ENV_FILE`, `BRAI_HISTORY_CURSOR_KEY_FILE`, а также необязательные `BRAI_HISTORY_IMAGE` и `BRAI_HISTORY_MCP_HOST_PORT`. В защищённом runtime env-файле задаются `HISTORY_APP_DATABASE_URL`, `HISTORY_WEB_DATABASE_URL`, `NATS_URL` (список через запятую), `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX=_INBOX.brai_history` и параметры MCP `HISTORY_MCP_ALLOWED_HOSTS`, `HISTORY_MCP_ALLOWED_ORIGINS`, `HISTORY_MCP_MAX_SESSIONS`, `HISTORY_MCP_SESSION_IDLE_MS`. Compose задаёт внутренний bind `0.0.0.0:3006` и путь ключа `/run/secrets/history_cursor_hmac_key`.

Отдельный migration env-файл получает только `HISTORY_OWNER_DATABASE_URL`, `HISTORY_OWNER_ROLE`, `HISTORY_APP_ROLE` и `HISTORY_WEB_ROLE`. База, её владелец и три разные роли должны быть созданы оператором заранее. Владелец запускается только через одноразовую службу `history-migrate`; runtime-контейнер использует app и web URL без DDL-прав. Не передавайте owner URL процессу `history` и не помещайте значения секретов или содержимое env-файлов в Git.

Ключ курсора задаётся через `HISTORY_CURSOR_HMAC_KEY_FILE`. Compose монтирует его read-only как `/run/secrets/history_cursor_hmac_key` в контейнер с UID/GID `1000:1000`. Файл на хосте должен быть доступен этому UID и иметь режим `0400`; его содержимое и стабильное значение сохраняются оператором между выпусками, иначе старые курсоры перестанут проверяться.

Внутренний MCP доступен через `/mcp` на loopback-порту хоста `BRAI_HISTORY_MCP_HOST_PORT` (по умолчанию `3006`). Порт не публикуется на внешнем интерфейсе. В `HISTORY_MCP_ALLOWED_HOSTS` и `HISTORY_MCP_ALLOWED_ORIGINS` задавайте только точные Host/Origin значения ожидаемого локального клиента. Максимум 64 одновременно открытых сессии, простой сессии истекает через 300000 мс.

## Выпуск и обновление

Команды выполняются из корня репозитория. В защищённом файле Compose заданы пути/env-переменные экземпляра; он не должен содержать пароли, если их уже хранят отдельные защищённые env-файлы:

```sh
docker compose --env-file ./instance.compose.env -f deploy/compose.history.yml build history
docker compose --env-file ./instance.compose.env -f deploy/compose.history.yml --profile migration run --rm --no-deps history-migrate
docker compose --env-file ./instance.compose.env -f deploy/compose.history.yml up -d --no-deps --wait history
```

Миграция запускается отдельно до runtime и завершается до запуска приложения. Она атомарно создаёт собственные таблицы, seed и grants; повтор безопасен и не пересоздаёт исходный журнал аудита. После запуска Compose показывает readiness по успешной проверке PostgreSQL и NATS. NATS Service discovery PING отдельно не заменяет healthcheck.

При запуске из заранее восстановленного image не требуется Docker build-контекст или исходный код:

```sh
docker compose --env-file ./instance.compose.env -f deploy/compose.history.yml up -d --no-build --pull never history
```

Откат выполняйте заменой `BRAI_HISTORY_IMAGE` на сохранённый совместимый образ и повторным запуском Compose с `--no-build --pull never`. Не удаляйте и не очищайте отдельную базу истории при откате. Остановить только приложение можно командой `docker compose ... stop`; удалить Compose-проект — `docker compose ... down` без `-v`. PostgreSQL и NATS не принадлежат этому Compose-проекту.

После успешной сборки удалите временный `tmp/history-runtime/`, если он больше не нужен. Следующая сборка создаёт его заново из текущего `dist` и lockfile.

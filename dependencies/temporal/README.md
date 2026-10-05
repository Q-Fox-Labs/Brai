# Temporal

Контейнерная зависимость для выполнения долговечных workflow: официальный Temporal Server `1.31.0` и отдельный PostgreSQL `16.15`. TypeScript SDK установлен в npm-зависимости проекта. Определение использует [официальный образ сервера](https://github.com/temporalio/docker-builds/blob/main/docker-readme/server.md) и PostgreSQL для основной истории и visibility.

## Конфигурация

Передайте параметры экземпляра вне Git:

```dotenv
TEMPORAL_COMPOSE_PROJECT=brai-temporal
BRAI_NATS_NETWORK=brai_nats_private
TEMPORAL_DATABASE_NETWORK=brai_temporal_database
TEMPORAL_DATABASE_VOLUME=brai_temporal_postgres
TEMPORAL_DATABASE_ENV_FILE=/absolute/secrets/temporal_postgres.env
TEMPORAL_HOST_PORT=7233
```

Защищённый файл `TEMPORAL_DATABASE_ENV_FILE` должен задавать `POSTGRES_PASSWORD`, `POSTGRES_PWD` и `SQL_PASSWORD` с одним случайным значением. Не сохраняйте его в Git. Создайте обычную сеть микросервисов, отдельную внутреннюю (`--internal`) сеть БД и постоянный volume. PostgreSQL не публикует порты и доступен только Temporal и инструменту подготовки схем.

## Первая установка

Только для нового экземпляра с пустым volume:

```sh
docker compose --env-file /absolute/temporal.env -f dependencies/temporal/compose.yml pull
docker compose --env-file /absolute/temporal.env -f dependencies/temporal/compose.yml up -d --wait postgresql
docker compose --env-file /absolute/temporal.env -f dependencies/temporal/compose.yml --profile setup run --rm --no-deps schema
docker compose --env-file /absolute/temporal.env -f dependencies/temporal/compose.yml up -d --wait
docker run --rm --network brai_nats_private temporalio/admin-tools:1.31.0 \
  temporal --address temporal:7233 operator namespace create --namespace brai --retention 168h
```

Схемы подготавливаются отдельно по [порядку self-hosted Temporal](https://docs.temporal.io/self-hosted-guide/deployment). При восстановлении сначала верните volume с данными и прежний защищённый файл, затем запускайте только `up -d --wait`. Не повторяйте первоначальную инициализацию вместо возврата резервной копии.

## Доступ микросервисов

Контейнеры в сети `BRAI_NATS_NETWORK` подключаются к `temporal:7233`, namespace — `brai`. Для процессов на хосте доступен `127.0.0.1:7233`. В TypeScript передайте адрес в `Connection.connect({ address: 'temporal:7233' })` либо `NativeConnection.connect` для worker; namespace задайте явно в клиенте и worker. Одна установка SDK не подключает сервисы автоматически.

Сервер доверяет внутренней сети микросервисов; gRPC не опубликован на внешних интерфейсах. Пользовательский код workflow и workers развёртывается отдельно.

Остановка `docker compose ... stop` сохраняет данные. Не удаляйте volume. При обновлении закреплённой версии сервера сначала сделайте резервную копию обеих БД и отдельно примените необходимые миграции соответствующим `admin-tools`; обычный автозапуск не обновляет схемы.

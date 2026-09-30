# Production образы Brai

`compose.production.yml` собирает web и timer из корня репозитория и запускает их в раздельных контейнерах. Сборка требует закреплённые Node.js и npm из корневого `package.json`. Внешние сети NATS, базы данных и reverse proxy создаёт инфраструктура до запуска стека.

Web подключается к сети NATS и к сети reverse proxy. Timer подключается к NATS и закрытой сети базы данных. Внешний прокси должен направлять запросы к `web:3000`. Compose публикует web только на loopback хоста. Timer не публикует порт.

Перед запуском подготовьте три отдельные защищённые env-файла:

- `web.env`: `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX=_INBOX.brai_web`, `WEB_ORIGIN`;
- `timer.env`: `DATABASE_URL` прикладной роли, `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX=_INBOX.brai_timer`;
- `timer-migration.env`: `DATABASE_URL` владельца БД, `TIMER_OWNER_ROLE`, `TIMER_APP_ROLE`.

Передайте compose абсолютные пути к этим файлам через `WEB_ENV_FILE`, `TIMER_ENV_FILE` и `TIMER_MIGRATION_ENV_FILE`. Передайте имена созданных сетей через `BRAI_FRONTEND_NETWORK`, `BRAI_NATS_NETWORK` и `BRAI_DATABASE_NETWORK`. Не помещайте пароли в файлы интерполяции Compose или Git.

Сначала соберите образы и примените миграцию отдельным одноразовым контейнером:

```sh
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml build
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml --profile migration run --rm timer-migrate
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml up -d
docker compose --env-file /path/to/instance.compose.env -f deploy/compose.production.yml up -d --no-deps --wait web
```

Migration container получает только owner env-файл и завершается после `node dist/migrate.js`. Web и timer получают отдельные runtime env-файлы. Web запускается без ожидания timer и проверяет готовность самой страницы через HTTP; локальные START/STOP доступны без backend. Timer отдельно проверяет PostgreSQL и JetStream без записи данных. Готовность общего API проверяется отдельно после восстановления backend. Один экземпляр web владеет durable consumer `web_events`.

При выпуске нового контракта сначала обновите timer и подтвердите его готовность через `docker compose ... up -d --no-deps --wait timer`, затем обновите web через `docker compose ... up -d --no-deps --wait web`. Это исключает передачу новых команд прежнему владельцу.

PostgreSQL и NATS хранят данные в устойчивых томах конфигурации `dependencies/`. Production compose подключается к их сетям и не создаёт собственные тома данных. Останавливайте приложения командой `docker compose ... stop`; для удаления стека используйте `down` без `-v`.

## Проверка production образов

Изолированный `compose.production-test.yml` собирает те же Dockerfiles. Он запускает PostgreSQL и NATS с открытыми тестовыми учётными данными и данными в `tmpfs`; база недоступна через опубликованный порт, NATS отделён от неё сетью. Web доступен только на `127.0.0.1:13000`.

```sh
docker compose -f deploy/compose.production-test.yml up -d --build --wait
curl --fail http://127.0.0.1:13000/api/timer
docker compose -f deploy/compose.production-test.yml down -v --remove-orphans
```

Стенд не подключается к внешним production сетям и не монтирует каталоги production данных. Удалите его после проверки через последнюю команду.

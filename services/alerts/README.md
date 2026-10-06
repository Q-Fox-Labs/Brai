# Сервис уведомлений

`@brai/alerts` хранит личные и общие уведомления в собственной PostgreSQL-БД, принимает долговечные события через JetStream и обслуживает доверенный web через NATS Services. Открытие списка не отмечает записи прочитанными. Общая запись хранится один раз; прочтение каждого пользователя — отдельно.

Поведение и ошибки: [CONTRACT.md](CONTRACT.md). Запуск и права: [DEPLOYMENT.md](DEPLOYMENT.md). Owner-схемы: [schemas](schemas/messages.schema.json), [validators](contracts/index.mjs), [AsyncAPI](asyncapi.yaml). Требуется Node 24, существующие locked зависимости `pg`, `nats`, `ajv`, `ajv-formats`. Сервис не зависит от admin.

Из корня workspace:

```sh
npm run build:alerts
npm run typecheck:alerts
npm run test:alerts
npm run test:integration:alerts
node services/alerts/scripts/package-runtime.mjs
```

Интеграции требуют явно заданный disposable loopback стенд `brai_alerts_test`: `ALERTS_TEST_OWNER_DATABASE_URL`, `ALERTS_TEST_APP_DATABASE_URL`, `ALERTS_TEST_WEB_DATABASE_URL`, соответствующие `ALERTS_TEST_{OWNER,APP,WEB}_ROLE` и `ALERTS_TEST_NATS_URL`. Для брокера тестовые identities `alerts`, `web`, `publisher`, `fixture`; сервисные credentials могут задаваться `ALERTS_TEST_NATS_USER`, `ALERTS_TEST_NATS_PASSWORD`. Публичные production адреса и другие имена БД тесты запрещают. Без явных параметров интеграционные сценарии пропускаются; такой запуск не подтверждает интеграцию. Тесты очищают только disposable данные и создают временный stream полного буфера.

Проверки охватывают replay/conflict, RLS/SQL grants, микросекундный курсор, важность и настоящий цвет категории, snapshot `read_all`, остановленный consumer, отказ БД, crash после COMMIT до ACK, malformed TERM, Service error headers, бюджет страницы и `DiscardNew`. Отдельная проверка полного буфера использует уменьшенный лимит временного stream; runtime отдельно сверяет production значение 256 MiB.

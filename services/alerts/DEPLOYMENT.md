# Подготовка и запуск alerts

Этот документ задаёт переносимые входы и порядок выпуска. Адреса, credentials, контейнеры и инфраструктуру конкретного экземпляра задаёт оператор. Сборка не запускает production. Приложение не требует admin или его файлов.

## PostgreSQL

1. Создайте отдельную БД и роли owner/app/web. Owner владеет БД; app и web различаются, не имеют SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS, членства в других ролях и собственных таблиц в alerts/public.
2. Соберите сервис: `npm run build:alerts`.
3. Только для отдельного migration process передайте `ALERTS_OWNER_DATABASE_URL`, `ALERTS_OWNER_ROLE`, `ALERTS_APP_ROLE`, `ALERTS_WEB_ROLE`; выполните `npm run migrate:alerts`.
4. Миграция атомарно создаёт таблицы, seed, комментарии, RLS и grants; повтор безопасен и сохраняет ручные названия/цвета. Конфликт стабильных ID/code/category исправьте явным решением владельца до выпуска.
5. Не передавайте owner URL runtime или web. App и web получают только свои URL. Runtime не делает DDL.

## NATS

Оператор создаёт stream `BRAI_ALERTS_INGEST_V1` для единственного subject `brai.alerts.v1.ingest`: file, workqueue, `max_age=0`, `max_bytes=268435456`, `max_msg_size=65536`, discard new. Не задавайте дополнительные пределы числа сообщений, отдельного subject или consumer expiry: они могут вызвать преждевременное вытеснение либо остановку. Replicas выбирается оператором для доступного кластера.

Создайте durable `alerts_ingest` с explicit ACK, deliver all, filter ingest, `ack_wait=30000000000` наносекунд, `max_deliver=-1`, `max_ack_pending=8`, без push `deliver_subject`. Runtime проверяет config и использует bounded pull. Управление broker-ресурсами не входит в его ACL.

Сервисная NATS identity должна иметь:

- Publish `brai.alerts.v1.changed`, ACK для собственного stream/consumer, consumer pull NEXT, stream/consumer INFO, account INFO для SDK, service discovery replies и разрешённые request inbox replies.
- Subscribe свой `NATS_INBOX_PREFIX.>`, пять Service endpoint subjects с queue `service_alerts`, канонические `$SRV.PING|INFO|STATS` subjects своего сервиса и экземпляра.
- Без CREATE/UPDATE/DELETE stream/consumer, без чужих broker API, без чужих endpoints и subject-источников.

Web identity может publish только query/command alerts и свои прочие согласованные endpoints, subscribe изменениями alerts и своим inbox. Она отвечает за проверку сессии и использует только её ID. Publisher identity может publish только ingest и subscribe собственный inbox для PubAck; она не получает query/command/changed. ACL необходимо проверять с реальными broker identities, а не только разбором конфигурации.

## Runtime и поставка

Передайте `ALERTS_APP_DATABASE_URL`, `ALERTS_WEB_DATABASE_URL`, `ALERTS_CURSOR_HMAC_KEY_FILE` (файл не короче 32 байт), `NATS_URL` (один адрес или список через запятую), `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX` (выделенный `_INBOX.<identity>`). Ключ курсоров должен сохраняться при восстановлении и смене образа; его замена инвалидирует прежние курсоры. Значения секретов не выводятся.

`node dist/main.js` запускает ingestion и Services API. SIGTERM прекращает приём, закрывает pull, завершает активные SQL, затем закрывает NATS и пулы. `node dist/health.js` проверяет схемы PostgreSQL и exact JetStream config, не потребляя сообщений. Owner migrations запускаются отдельно как `node dist/migrate.js`.

`node services/alerts/scripts/package-runtime.mjs --output tmp/alerts-runtime` собирает готовый переносимый Docker-контекст из `dist`, owner contracts/schemas, migrations, package metadata и существующих locked production dependencies. Команда не устанавливает пакеты и не обращается к сети. Все три точки входа, версии зависимостей и ESM imports проверяются из артефакта. Dockerfile только копирует готовую поставку и запускает Node под пользователем node; он не запускает npm или миграцию.

Web должен включить owner contract assets в свою серверную поставку для загрузки валидаторов. SSE передаёт только безопасный сигнал и требует восстановления summary/list каждые 15 секунд и после reconnect. Отключение consumer сохраняет события до лимита stream, а его заполнение возвращает producer ошибку PubAck и требует безопасного повторения.

## Явный запуск принятого выпуска

1. Зафиксируйте ревизию принятого исходника. Проверьте, что сервис, owner contracts и package lock соответствуют этой ревизии; чужие незакоммиченные изменения не включайте в поставку.
2. Соберите сервис существующими locked зависимостями и подготовьте отдельный контекст выпуска:

   ```sh
   npm run build:alerts
   node services/alerts/scripts/package-runtime.mjs --output tmp/alerts-production-runtime
   ```

3. Из готового контекста соберите и примите OCI image. Сохраните исходную ревизию и image ID; последующий запуск не должен пересобирать image или скачивать зависимости.
4. Отдельными операторскими шагами подготовьте БД и безопасные роли, примените NATS ACL и создайте проверенные stream/consumer. Восстановите защищённые runtime/migration inputs и стабильный cursor key.
5. Через отдельный migration process принятого image выполните owner migration. Owner input передаётся только ему; он отсутствует в runtime.
6. Передайте [compose.alerts.yml](../../deploy/compose.alerts.yml) принятый `BRAI_ALERTS_IMAGE`, защищённый `ALERTS_ENV_FILE`, `BRAI_ALERTS_CURSOR_KEY_FILE` и существующие `BRAI_DATABASE_NETWORK`/`BRAI_NATS_NETWORK`. Явно запустите только сервис alerts с `--no-build --pull never`.
7. Проверьте readiness, NATS Services, доступ только к личным и общим записям, независимое прочтение двух пользователей и восстановление web после пропущенного сигнала. Подключение существующих автоматических источников выполняйте отдельным шагом по их контрактам.

Создание инфраструктуры, миграция и запуск являются явными этапами выпуска. Сборка контекста не выполняет эти действия; восстановление постоянной конфигурации также не заменяет их.

## Резервное копирование и восстановление

Резервируйте собственную PostgreSQL-БД, JetStream file store, стабильный cursor key и явные входы runtime отдельными средствами оператора. Восстанавливайте БД и stream до запуска consumer; применяйте миграции явным шагом выпуска, не скрытым шагом runtime. Откат образа не удаляет notifications или read_marks. После восстановления сверяйте seed identity, SQL grants/RLS, JetStream config и `health`. Credentials роли owner остаются вне runtime.

При запуске принятого выпуска сохраняйте существующие уведомления, read marks, cursor key и неподтверждённый backlog. Откат выполняйте совместимым принятым image без удаления данных.

# Alerts: подготовка и изолированная приёмка

Production не запущен. `compose.alerts.yml` описывает будущий runtime из принятого image. Он не создаёт БД, роли, секреты или JetStream и не запускает миграцию автоматически. Runtime не публикует порт; браузер обращается только к авторизованным API и SSE web.

## Удаляемый стенд

Определение `compose.alerts-test.yml` создаёт собственный проект `brai-alerts-test`. PostgreSQL `17.6-alpine3.22` и NATS `2.15.0` должны быть установлены заранее; операции используют `--no-build --pull never`. Данные БД и JetStream находятся в tmpfs, отдельная Docker-сеть не подключена к production. Порты опубликованы только на loopback: PostgreSQL `25641`, NATS `24341`. Пароль `alerts-test` публичный и разрешён только в этом стенде.

Из `/srv/projects/admin/ansible`:

```sh
sudo -n /usr/bin/ansible-playbook -i inventory/hosts.yml playbooks/operations/preflight_brai_alerts_test.yml
sudo -n /usr/bin/ansible-playbook -i inventory/hosts.yml playbooks/operations/prepare_brai_alerts_test.yml
sudo -n /usr/bin/ansible-playbook -i inventory/hosts.yml verify.yml -e recovery_verify_scope=brai_alerts_test
```

Переменные продуктовых интеграционных проверок:

| Переменная | Синтетическое значение |
| --- | --- |
| `ALERTS_TEST_OWNER_DATABASE_URL` | `postgresql://alerts_test_owner:alerts-test@127.0.0.1:25641/brai_alerts_test` |
| `ALERTS_TEST_APP_DATABASE_URL` | `postgresql://alerts_test_app:alerts-test@127.0.0.1:25641/brai_alerts_test` |
| `ALERTS_TEST_WEB_DATABASE_URL` | `postgresql://alerts_test_web:alerts-test@127.0.0.1:25641/brai_alerts_test` |
| `ALERTS_TEST_OWNER_ROLE` | `alerts_test_owner` |
| `ALERTS_TEST_APP_ROLE` | `alerts_test_app` |
| `ALERTS_TEST_WEB_ROLE` | `alerts_test_web` |
| `ALERTS_TEST_NATS_URL` | `nats://127.0.0.1:24341` |

NATS runtime использует `alerts`, web — `web`, отправитель — `publisher`, административная подготовка стенда — `fixture`. У всех пароль `alerts-test`. Inbox prefixes: `_INBOX.brai_alerts`, `_INBOX.brai_web`, `_INBOX.brai_alerts_publisher`, `_INBOX.brai_alerts_fixture`. Широкие права `fixture` принадлежат только одноразовому тестовому broker.

Для запуска runtime замените префикс `ALERTS_TEST_` на `ALERTS_` у трёх DB URL и имён ролей. Owner URL передаётся исключительно отдельной миграции. Web-процесс получает только NATS, а не DB URL. Подготовку прикладной схемы и конкретные сценарии проверяет продуктовый `services/alerts` test runner. Для браузерной приёмки нужен отдельный web на `127.0.0.1:13400` с проверяемыми синтетическими сессиями двух пользователей; этот стенд не заявляет приёмку настоящего Auth.

После приёмки остановите собственные тестовые процессы и удалите только этот стенд:

```sh
sudo -n /usr/bin/ansible-playbook -i inventory/hosts.yml playbooks/operations/remove_brai_alerts_test.yml
sudo -n /usr/bin/ansible-playbook -i inventory/hosts.yml verify.yml -e recovery_verify_scope=brai_alerts_test_removed
```

## JetStream и ACL

`deploy/alerts-jetstream.mjs` разрешает только provision/verify фиксированного loopback-стенда. Он не применяется к production. Stream `BRAI_ALERTS_INGEST_V1`: subject `brai.alerts.v1.ingest`, file, WorkQueue, DiscardNew, `max_bytes=268435456`, `max_age=0`, `max_msg_size=65536`, одна реплика. Consumer `alerts_ingest`: explicit ack, `ack_wait=30s`, deliver_all, фильтр входного subject, `max_ack_pending=8`, `max_deliver=-1`. Подтверждение выполняет runtime после commit. Переполненный stream отказывает новым публикациям; отправитель сохраняет сообщение до принятого PubAck.

Fixture ACL даёт runtime только stream/consumer INFO, pull NEXT и ACK для этих объектов, публикацию changed и пять API подписок. NATS Services разрешены PING/INFO/STATS общего, service и instance уровня. Web публикует только query.list/get/summary и command.read/read_all, читает changed и собственный inbox. Отправитель публикует только ingress и читает свой PubAck inbox. Перед production изменением существующий web ACL должен сохранить уже принятые права других функций; шаблон admin `nats-alerts-user.conf.j2` содержит только новую alerts identity и не заменяет действующую конфигурацию broker.

## Входы будущего восстановления

Admin хранит отключённый candidate в `roles/recovery_state/vars/brai_alerts_candidate.yml`. Его read-only scope — `brai_alerts_candidate`. Даже при передаче enabled=true проверка отказывает: активация требует отдельно порученной операции выпуска. Restore не создаёт объектную схему, роли, stream или секреты.

Будущая БД `brai_alerts` принадлежит `brai_alerts_owner`; runtime roles `brai_alerts_app` и `brai_alerts_web` различны, без повышенных полномочий и членства. Защищённые входы восстанавливаются отдельно: `.secrets/alerts_runtime.env` содержит app/web URLs и NATS connection, `.secrets/alerts_migration.env` — owner URL и имена трёх ролей, `.secrets/nats_alerts.env` — пароль новой broker identity, `.secrets/alerts_cursor_hmac_key` — стабильный ключ курсоров. Owner input отсутствует в runtime. Ключ монтируется UID/GID `1000:1000`, только для чтения; runtime input и broker credentials защищены `0600`, ключ `0400`. Значения не включают в inventory, Git или вывод проверок.

Перед отдельным разрешённым выпуском оператор фиксирует принятые исходную ревизию и OCI image ID; проверяет prepared runtime, SQL migration, ACL с реальным parser и клиентами; восстанавливает стабильный ключ; отдельно подготавливает БД/роли и stream/consumer; выполняет owner migration; затем запускает только alerts с `--no-build --pull never` и проверяет readiness, isolation двух пользователей, SSE и reconciliation. Готовые gated Ansible команды подготовки БД/ролей, неактивного additive NATS candidate и JetStream находятся в `/srv/projects/admin/ansible/playbooks/operations/BRAI_ALERTS.md`. Они требуют отдельного production поручения и восстановленных protected inputs; в текущей задаче они не выполнялись и не входят в Ansible restore.

## Резервная копия и откат

Admin поставляет конкретную отключённую операцию `ansible/playbooks/operations/backup_brai_alerts.yml` и read-only scope `brai_alerts_backup`. Она требует отдельного backup поручения и quiet interval; сохраняет собственный PG custom dump с owner/grants, role metadata, native JetStream snapshot с consumer, пять protected inputs и stable key в root-only run directory. Complete manifest, hashes и PostgreSQL TOC проверяются отдельно. Backup не запускается restore или расписанием; текущая задача production backup не выполняет. Точные команды и gates — в operator recipe admin.

Защищённая копия включает согласованный `pg_dump` базы, владельцев/права, runtime/migration/broker inputs и исходный ключ курсоров. JetStream file-store копируют согласованным снимком с приостановленной записью, сохраняя неподтверждённый ingress. Снимок DB и очереди сверяют по согласованной точке: повтор входа допустим благодаря `(service_id,id)`, удаление непринятых сообщений недопустимо.

При откате выбирают прежний совместимый принятый image и запускают только runtime без build/pull; БД, read marks, ключ и backlog сохраняют. `down -v` допустим только для тестового tmpfs-стенда. Восстановление данных и секретов выполняют отдельной Ansible-операцией, затем product migration и read-only проверки; пустая БД не заменяет резервную копию.

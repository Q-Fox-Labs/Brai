# Alerts: постоянный сервис и изолированная приёмка

`compose.alerts.yml` запускает постоянный runtime из принятого готового image. Он не создаёт БД, роли, секреты или JetStream и не запускает миграцию автоматически. Runtime не публикует порт; браузер обращается к авторизованным API и SSE web на `/alerts`. Порядок выпуска и обязательные отдельные проверки описаны в `/srv/projects/admin/ansible/playbooks/operations/BRAI_ALERTS.md`.

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

## Постоянный запуск и восстановление

БД `brai_alerts` принадлежит `brai_alerts_owner`; рабочие роли `brai_alerts_app` и `brai_alerts_web` различны, без повышенных полномочий и членства. `.secrets/alerts_runtime.env` содержит app/web URLs и NATS connection, `.secrets/alerts_migration.env` — только owner migration URL и имена ролей, `.secrets/nats_alerts.env` — пароль собственной broker identity. Runtime не получает owner input. Стабильный `.secrets/alerts_cursor_hmac_key` монтируется UID/GID1000 `0400` только для чтения. Все env inputs защищены root:root `0600`.

Первичная операция Ansible создаёт отсутствующие собственные параметры один раз. Защищённый набор в `/etc/brai/alerts-initial-inputs/` позволяет продолжить прерванное копирование с теми же паролями и ключом; конфликт или незавершённый набор требуют восстановления оператором. Существующие параметры не заменяются. Пути регистрируются в защищённом INDEX admin без значений секретов.

`/etc/brai/alerts.env` хранит принятый image ID и пути готовых входов. `/etc/ansible/brai-alerts-recovery-inputs.yml` содержит единственный флаг `brai_alerts_enabled`; отсутствие сохраняет выключенное состояние. При восстановлении возвращают прежние входы, образ, данные БД, очередь, конфигурацию NATS и метаданные выпуска. `recovery_state` устанавливает `brai-alerts.service`, связывает его с запуском Docker и запускает готовый образ с `--no-build --no-deps --pull never`. В этой ветке нет SQL, миграций, сборки, установки пакетов или генерации секретов. `restart: unless-stopped` и включённый unit обеспечивают постоянный запуск после перезапуска Docker или сервера.

NATS использует `/etc/brai/nats-alerts.compose.yml` последним слоем существующей конфигурации Compose. Принятый `/etc/brai/alerts-candidate/nats.conf` сохраняет прежних пользователей и права, добавляя учётную запись alerts, пять точных subjects веб-API и подписку на changed. Перед активацией сверяют контрольную сумму исходной конфигурации, образ, unit, сеть, том данных и все действующие значения `NATS_*` в итоговой конфигурации Compose. Значения не выводят; после активации проверяют их сохранение. Операция поддерживает откат и перезапускает только NATS на прежнем томе.

Миграцию владельца выполняют отдельно из принятого образа. Runtime только проверяет готовые stream и consumer. Docker собирает подготовленные контексты без `RUN`, установки пакетов или загрузки образов; исходники сверяются с принятой ревизией Git. Веб-приложение выпускают отдельно после повторной проверки его текущего образа. Защищённый необязательный `brai_web_source_revision` позволяет сохранить версии artifacts и Агента, обновив только веб-образ и его манифест.

## Резервная копия и откат

Admin поставляет ручную операцию `ansible/playbooks/operations/backup_brai_alerts.yml` и проверку только чтением `brai_alerts_backup`. Перед копированием отдельно приостанавливают отправителей и alerts. Операция сохраняет собственный PostgreSQL custom dump с владельцами и правами, метаданные ролей, native snapshot JetStream с consumer, пять защищённых входов, включая стабильный ключ, метаданные образа и конфигурацию NATS. Каталог доступен только root; полнота набора, контрольные суммы и PostgreSQL TOC проверяются отдельно. Резервное копирование не запускается при восстановлении или по новому расписанию. Первоначальную копию делают после миграции и подготовки JetStream, до первого запуска потребителя; отправители ещё не подключены. Копии не удаляются автоматически. Команды и условия запуска описаны в эксплуатационном руководстве admin.

Защищённая копия включает согласованный `pg_dump` базы, владельцев/права, runtime/migration/broker inputs и исходный ключ курсоров. JetStream file-store копируют согласованным снимком с приостановленной записью, сохраняя неподтверждённый ingress. Снимок DB и очереди сверяют по согласованной точке: повтор входа допустим благодаря `(service_id,id)`, удаление непринятых сообщений недопустимо.

При откате выбирают прежний совместимый принятый image и запускают только runtime без build/pull; БД, read marks, ключ и backlog сохраняют. `down -v` допустим только для тестового tmpfs-стенда. Восстановление данных и секретов выполняют отдельной Ansible-операцией, затем product migration и read-only проверки; пустая БД не заменяет резервную копию.

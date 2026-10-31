# Поставка Приёма

Компонент не переключает Telegram и не создаёт Каналы, Контакты, Входящие,
Понимание или память. Их адреса конфигурируются явно. Для автономной приёмки
используются только изолированные тестовые соседи.

## Программы и права

Опубликованный OCI образ содержит main, worker, migrate и broker provision.
main и worker читают один runtime config; owner SQL credentials и NATS admin
options доступны только отдельным setup-профилям. Программы не выполняют
автоматические миграции, provisioning, установку пакетов или скачивание моделей.

Compose project имеет собственное имя окружения, приватную сеть без HTTP портов
и ограничения CPU/RAM. 256 MiB API и 512 MiB worker — начальные настраиваемые
лимиты контейнеров, не измеренный минимум и не память на workflow.
Worker ограничен 4 Activity, 8 Workflow Tasks, 32 cached workflows.
Все ссылки на конфигурацию находятся вне Git; payload не задаёт transport endpoints.

Owner migrate применяет 001.sql и 002.sql в одной транзакции. Перед запуском
исправленных main/worker требуется таблица intake_control_events; ready проверяет
её доступность. Миграция расширяет собственную схему без удаления старых пакетов.
Успешные результаты тестовых соседей должны соответствовать MaterialResult/MemoryResult
в обновлённой owner JSON Schema; старый пустой result не считается подтверждением.

Оператор сначала создаёт отдельную PostgreSQL БД с owner и ограниченной runtime
ролью, готовит NATS identities/ACL и Temporal namespace. Потом запускает migrate,
provision и обе программы из одного принятого образа. Provision создаёт только
отсутствующие ресурсы; несовместимая существующая конфигурация даёт отказ.
API identity получает read-only JS INFO/stream INFO/consumer INFO, NEXT/ACK своего
consumer, запросы разрешённых соседей, dispatch publish и служебные reply inbox.
У неё нет stream create/delete/purge или consumer management.

Подготовленный общий рецепт находится в Admin client/roles/brai_intake. Он не
подключён к текущей клиентской композиции или DEV автоматически. Запуск требует
принятого immutable image и явных защищённых inputs; пользовательская приёмка
и действующий порядок Codeworks/Ansible остаются обязательными.

## Проверки

Автономные проверки: component CLI build/check intake. Интеграционный запуск —
Admin playbooks/operations/prepare_brai_intake_test.yml, затем отдельный verify.yml
с recovery_verify_scope=brai_intake_test и test_brai_intake.yml.
Везде указывается intake_test_source — точное Codeworks worktree.
Новые тесты используют только loopback fixture и namespace intake_test.
Реальные Artifacts/History запускаются как отдельные процессы на собственных
пустых тестовых БД; работающие владельцы не останавливаются.

Для owners API tests сначала собрать существующие components artifacts/history
в том же дереве. Benchmark сравнивает один и тот же PostgreSQL INSERT через
JetStream и отдельный контрольный Temporal workflow, с прогревом и 20 измерениями.
Это диагностика накладных расходов, а не нагрузочная приёмка всего Telegram-пути.
RSS относится к тестовому клиенту/worker, не серверу и не одному workflow.
Синтетические inputs подготавливаются Ansible с читаемыми контейнером режимами;
права исходников рабочего дерева не меняются.

## Каналы v1

Общий disposable стенд дополнен отдельной БД/ролями Каналов и ограниченными NATS
identities. prepare/test/remove_brai_channels_test.yml и scope brai_channels_test
используют собственную тестовую композицию без перенастройки рабочих служб.
Поставка Приёма содержит только common.schema.json владельца Каналов.
Runtime Каналов в образ Приёма не входит. Развёртывать Приём отдельно от
согласованного полного Telegram-комплекта по-прежнему запрещено.

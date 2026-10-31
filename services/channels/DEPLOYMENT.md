# Поставка Каналов

Компонент channels поставляет main, migrate, схемы, профиль telegram/1 и SQL.
Зависимость контракта — две схемы владельца Истории. Приём получает только
common.schema.json Каналов без их исполняемого кода.

## Параметры и права

CHANNELS_CONFIG указывает на JSON с databaseUrl, natsUrl, natsOptionsFile,
cursorKeyFile и callers. Каждый caller задаёт ownerIds, operations, sourceIds,
replySourceIds и connectionIds: null либо список разрешённых UUID.
Subject операции: brai.channels.v1.OP.CALLER; status — общий.
NATS ACL запрещает чужие caller subjects; payload не удостоверяет caller.
Приём получает resolve, доставка — delivery.check; управление имеет отдельную identity.

Runtime получает только собственные credentials. credentialsRef — непрозрачная
ссылка исполнителю доставки, не Telegram token. HMAC-ключ курсоров содержит
минимум 32 случайных байта и сохраняется между перезапусками. Его замена аннулирует
старые курсоры. Параметры и ключи хранятся вне Git.

Миграция читает CHANNELS_OWNER_DATABASE_URL и CHANNELS_RUNTIME_ROLE.
Owner — отдельный владелец выделенной БД. Runtime не входит в owner-роль,
не имеет superuser, bypassrls, createdb, createrole или replication.
Повтор миграции сохраняет ручное имя профиля и останавливается при конфликте
семантики. Исторические строки не обновляются и не очищаются.

## Операторский запуск

Общая роль Admin ansible/client/roles/brai_channels требует принятый образ с digest,
защищённые inputs и подготовленные сеть, БД и NATS ACL. Она не включена в действующую
клиентскую композицию и этим этапом не применяется. Оба установочных входа Admin
сохраняют состав принятого PROD.

Compose запускает одну программу без внешних портов; migrate — отдельный setup
профиль. Owner credentials не монтируются в runtime.
Начальные лимиты 256 MiB/1 CPU — ограничение контейнера, не измеренный минимум.
Пул PostgreSQL до 4, активных операций до 8, deadline 5 секунд с остатком на SQL,
вход до 64 KiB, ответ до 128 KiB. Максимальная нагрузка этим не установлена.

## Изолированная приёмка через Ansible

Все команды получают intake_test_source — точное UUID worktree:
1. playbooks/operations/prepare_brai_channels_test.yml.
2. verify.yml с recovery_verify_scope=brai_channels_test.
3. playbooks/operations/test_brai_intake.yml — прежние 9 интеграционных проверок.
4. playbooks/operations/test_brai_channels.yml — фактические Каналы и общая цепочка.
5. Повторный verify; remove_brai_channels_test.yml.
6. Отдельный verify.yml с recovery_verify_scope=brai_intake_removed.

Стенд принадлежит project brai-intake-test, использует loopback порты 25643/24343,
свои пустые БД и namespace intake_test. Рабочие службы и Telegram не меняются.
Сервер Temporal разделяется; тесты завершают только собственные workflow IDs.

Component CLI build/check/package channels intake проверяет сборку и поставку.
Интеграционные проверки запускаются отдельно через Ansible; их пропуск без
INTAKE_TEST_DISPOSABLE не подтверждает приёмку.

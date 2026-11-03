# Каналы

Самостоятельный сервис подключений, адресов каналов и исторических правил Brai.
Первый профиль — telegram/1: бот, чат и явная тема либо null.

[Контракт v1](CONTRACT.md), [AsyncAPI](asyncapi.yaml),
[общие DTO Draft-07](schemas/common.schema.json),
[14 операций](schemas/api.schema.json), [поставка](DEPLOYMENT.md).

Одна программа main соединяет прикладное ядро, чистый вычислитель правил,
PostgreSQL и NATS Services. Миграция — отдельная команда owner-роли.
Temporal, Telegram, собственная очередь и фоновые повторы внутри Каналов отсутствуют.
Повтор вызова выполняет существующий Temporal-сценарий Приёма.

Семь таблиц схемы channels: sys_channel_types, channel_connections,
channel_connection_versions, channels, channel_versions, channel_resolutions,
channel_operation_receipts. Правила входят в полную версию канала.
Runtime не может менять исторические записи и удалять данные.

Квитанция подтверждает COMMIT Каналов. Сохранённый historyEvent передаёт Истории
внешний долговечный координатор; полный административный координатор в этап не входит.

Реализовано в невыпущенной области вместе с адаптером Приёма. Тестовая цепочка
использует настоящие PostgreSQL, NATS, Temporal и API Истории; Контакты, Входящие,
Понимание, память, Hermes jobs и доставка остаются тестовыми.
Рабочий Telegram сохраняет прежний путь. Установка и выпуск не выполнены.

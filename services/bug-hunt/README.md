# Bug Hunt

Отдельный сервис регистрации наблюдений о сбоях. PostgreSQL хранит обращения,
карточки, первоначальные квитанции и аудит ручного разбора. MCP и NATS Services
вызывают одно предметное ядро. Web предоставляет список и карточку.

[Контракт v1](CONTRACT.md), [систематизация v2](SYSTEMATIZATION.md), [машинные DTO](schemas/messages.schema.json),
[операторские входы и восстановление](DEPLOYMENT.md).

Подключённый агент постоянно получает только строку-подсказку.
bug_hunt_help({}) читает правила и пример из публичного
[agent-guide.json](contracts/agent-guide.json), без регистрации и обращения к БД.
Схемы полей остальных инструментов опубликованы отдельно.

## Сборка и запуск

С готовыми зависимостями из корня: `npm run build:bug-hunt`,
`npm run test:bug-hunt`. Отдельная проверка типов: `npm run typecheck:bug-hunt`.
Миграции запускаются отдельно командой `npm run migrate:bug-hunt` с owner URL,
`BUG_HUNT_OWNER_ROLE` и `BUG_HUNT_APP_ROLE`.
Runtime получает только app URL через защищённый JSON
`BRAI_BUG_HUNT_CONFIG`; запуск: `npm start --workspace=@brai/bug-hunt`.
Готовность: `npm run health:bug-hunt`.

Поля конфигурации: databaseURL, installationId, cursorKey (не менее 32 байт),
nats (servers, inboxPrefix и необходимые credentials), mcp (host, port,
allowedHosts, allowedOrigins, principalsFile, maxConnections до 32),
maxReports (до 1000000), reportsPerMinute (до 6000), maxDatabaseBytes
(порог приёма, минимум 16 МиБ) и artifactsEnabled. Все значения задаёт экземпляр.
Конфигурация и реестр principal — обычные закрытые файлы без symlink,
с владельцем root либо UID процесса и без группового или общего доступа.

Реестр Codex содержит массив {tokenSha256, ownerId, principalId, enabled}.
Credential не хранится в реестре в открытом виде. Стабильный principalId
сохраняется при ротации токена. Каждый HTTP-запрос заново читает реестр и Auth.

## Проверки

Unit-проверки не требуют инфраструктуры. Интеграционные проверки принимают
только явные loopback URL отдельной БД brai_bug_hunt_test и своего NATS.
Начальная схема fixture находится в tests/integration/init.sql.
Ни установленный DEV, ни пользовательские обращения не используются для тестов.

Наличие исходников или успешная сборка не означают подключение компонента
в текущей установке. Поиск, обратимые группы и фоновые предварительные метки
описаны в SYSTEMATIZATION.md. Worker по умолчанию выключен; intake v1 не ждёт
моделей. Сервис не расследует, не подтверждает и не исправляет баги.

## Систематизация

Миграции 002/003/004 добавляют собственные производные таблицы поверх схемы 1.
Оператор заранее готовит pgvector; runtime не выполняет DDL.
processing — необязательная защищённая конфигурация с флагами, dailyLimits,
intakeReserveBytes/maxDerivativeBytes и внешними очищенными проекциями.
Её проверка и точные значения принадлежат src/config.ts и контракту v2.
targetGeneration готовит embedding рядом с active, без повторного Jev/local.
Переключение требует отдельной operator-only activate-generation с CAS и полным
покрытием; status показывает оба поколения. Старые векторы и квитанции сохраняются.
Установка передаёт те же стабильные installationId и cursorKey.

Обычный test не обращается к моделям. Изолированные integration tests используют
отдельные PostgreSQL/NATS fixture; model-quality.mjs запускается только явно
с отдельным UUID и синтетическими текстами. Replay этого UUID не вызывает inference.

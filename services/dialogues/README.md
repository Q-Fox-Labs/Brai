# Dialogues

Независимый прямой MCP-сервис для публичных текстов и подготовленных агентом саммари. Владение данными — в PostgreSQL; внешний владелец привязывается конфигурацией MCP. Сам сервис не вызывает модели.

- [Контракт архивной и live-частей](CONTRACT.md).
- [Карточка компонента](../../docs/components/dialogues.md).
- [Компонент и границы DEV-поставки](component.json).

## Программы

Node.js 24; существующие зависимости pg и MCP SDK. Сборка: npm run build --workspace=@brai/dialogues; тесты: npm test --workspace=@brai/dialogues. PostgreSQL-проверки требуют отдельного disposable fixture и переменных DIALOGUES_TEST_OWNER_DATABASE_URL / DIALOGUES_TEST_DATABASE_URL; без них они явно пропускаются.

Runtime запускает dist/main.js. Обязательные inputs: DIALOGUES_DATABASE_URL, DIALOGUES_MCP_HOST, DIALOGUES_MCP_PORT, DIALOGUES_MCP_OWNER_ID, DIALOGUES_MCP_ALLOWED_HOSTS, DIALOGUES_MCP_ALLOWED_ORIGINS, DIALOGUES_MCP_TOKEN_FILE. Пароль владельца БД в runtime не передаётся.

Owner-миграцию dist/migrate.js запускают отдельно с DIALOGUES_OWNER_DATABASE_URL, DIALOGUES_OWNER_ROLE и DIALOGUES_APP_ROLE. Она создаёт только dialogues_live; прежнюю dialogues не меняет. Health: dist/health.js.

Stdio-proxy dist/stdio-proxy.js получает DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. Он восстанавливает устаревшую MCP-сессию чтения; неизвестное изменение автоматически не повторяет.

## Явный импорт

dist/import.js capture SOURCE THREAD START_ID формирует закрытый фиксированный снимок по точной границе в DIALOGUES_IMPORT_SNAPSHOT. Разрешённый корень снимков — /var/lib/brai-dev/dialogues-import/. Сохраняются только public response_item пользователь/assistant commentary/final_answer; скрытые рассуждения и результаты инструментов не переносятся.

dist/import.js import SNAPSHOT THREAD START_ID передаёт снимок через тот же MCP и дочитывает каждый оригинал для проверки. Подключение задаётся DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. Вывод содержит только ID, счётчики и хеши, без текстов. Это явная разовая операция, не перехват новых сообщений.

Наличие исходников не подтверждает установленный экземпляр. Установка и подключение проверяются по receipt и реальным вызовам MCP.

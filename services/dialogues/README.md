# Dialogues

Независимый прямой MCP-сервис для публичных текстов и подготовленных агентом саммари. Владение данными — в PostgreSQL; внешний владелец привязывается конфигурацией MCP. Фоновый worker v0.2 сворачивает беседы точной Luna через существующий Codex App Server.

- [Контракт архивной и live-частей](CONTRACT.md).
- [Карточка компонента](../../docs/components/dialogues.md).
- [Компонент и границы DEV-поставки](component.json).

## Программы

Node.js 24; зависимости pg, MCP SDK и ws. Сборка: npm run build --workspace=@brai/dialogues; тесты: npm test --workspace=@brai/dialogues. PostgreSQL-проверки требуют отдельного disposable fixture и переменных DIALOGUES_TEST_OWNER_DATABASE_URL / DIALOGUES_TEST_DATABASE_URL; без них они явно пропускаются.

Runtime запускает dist/main.js. В том же процессе работают scheduler и один worker; состав источников, очередь и публикация сохраняются в PostgreSQL. Обязательные inputs: DIALOGUES_DATABASE_URL, DIALOGUES_MCP_HOST, DIALOGUES_MCP_PORT, DIALOGUES_MCP_OWNER_ID, DIALOGUES_MCP_ALLOWED_HOSTS, DIALOGUES_MCP_ALLOWED_ORIGINS, DIALOGUES_MCP_TOKEN_FILE. Пароль владельца БД в runtime не передаётся. Для фоновой свёртки нужны DIALOGUES_SUMMARY_ENABLED=true, DIALOGUES_CODEX_SOCKET_URL и DIALOGUES_SUMMARY_CWD; отдельный daemon не создаётся. Запросы к Luna временные: служебные чаты не сохраняются в истории Codex, соединение закрывается после ответа. Готовый результат хранится в PostgreSQL; потерянный запрос повторяется из сохранённого фрагмента в пределах попыток очереди.

Owner-миграцию dist/migrate.js запускают отдельно с DIALOGUES_OWNER_DATABASE_URL, DIALOGUES_OWNER_ROLE и DIALOGUES_APP_ROLE. Она применяет 002_live.sql, 003_context_jobs.sql и 004_managed_turns.sql только к dialogues_live; прежнюю dialogues не меняет. Health: dist/health.js.

Stdio-proxy dist/stdio-proxy.js получает DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. При ответе listener 404 до вызова операции он восстанавливает сессию и один раз передаёт тот же запрос; неизвестный исход изменения автоматически не повторяет.

## Чтение контекста v0.2

Рабочий цикл: `dialogues_turn_input` с `context` при новом ходе или восстановлении → дочитать первую и остальные страницы → передать явный ACK с очередным изменением → при необходимости пакетные `dialogues_turn_update` → для многоэтапной работы полный `dialogues_turn_get` → `dialogues_turn_finish` → отправка того же текста. Короткий вопрос без дальнейшей работы можно завершить по исходной версии без отдельного `turn_get`; позднее дополнение обнаружит проверка версии. При обычном стире с сохранённым контекстом новый global pull не нужен. При `context_error` квитанция подтверждает запись ввода; контекст читают отдельно, не повторяя ввод. Все дополнения до закрытия остаются в одном ходе.

При старте необходимо сверить возможный пропущенный финальный статус с реальной историей клиента и при подтверждённом фактическом финале восстановить его через `dialogues_turn_repair`. Сохранённый черновик не доказывает публикацию. Полный порядок, страницы, ошибки и пределы доказательства описаны в [контракте](CONTRACT.md#управляемые-ходы). Последние 50 сообщений и выдача свёрток сохраняют прежние правила. Старые операции остаются для истории и импорта.

## Явный импорт

dist/import.js capture SOURCE THREAD START_ID формирует закрытый фиксированный снимок по точной границе в DIALOGUES_IMPORT_SNAPSHOT. Разрешённый корень снимков — /var/lib/brai-dev/dialogues-import/. Сохраняются только public response_item пользователь/assistant commentary/final_answer; скрытые рассуждения и результаты инструментов не переносятся.

dist/import.js import SNAPSHOT THREAD START_ID передаёт снимок через тот же MCP и дочитывает каждый оригинал для проверки. Подключение задаётся DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. Вывод содержит только ID, счётчики и хеши, без текстов. Это явная разовая операция, не перехват новых сообщений.

Наличие исходников не подтверждает установленный экземпляр. Установка и подключение проверяются по receipt и реальным вызовам MCP.

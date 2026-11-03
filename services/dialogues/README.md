# Dialogues

Независимый прямой MCP-сервис для публичных текстов и подготовленных агентом саммари. Владение данными — в PostgreSQL; внешний владелец привязывается конфигурацией MCP. Фоновый worker v0.2 сворачивает беседы точной Luna через существующий Codex App Server.

- [Контракт архивной и live-частей](CONTRACT.md).
- [Карточка компонента](../../docs/components/dialogues.md).
- [Компонент и границы DEV-поставки](component.json).

## Программы

Node.js 24; зависимости pg, MCP SDK и ws. Сборка: npm run build --workspace=@brai/dialogues; тесты: npm test --workspace=@brai/dialogues. PostgreSQL-проверки требуют отдельного disposable fixture и переменных DIALOGUES_TEST_OWNER_DATABASE_URL / DIALOGUES_TEST_DATABASE_URL; без них они явно пропускаются.

Runtime запускает dist/main.js. В том же процессе работают scheduler и один worker; состав источников, очередь и публикация сохраняются в PostgreSQL. Обязательные inputs: DIALOGUES_DATABASE_URL, DIALOGUES_MCP_HOST, DIALOGUES_MCP_PORT, DIALOGUES_MCP_OWNER_ID, DIALOGUES_MCP_ALLOWED_HOSTS, DIALOGUES_MCP_ALLOWED_ORIGINS, DIALOGUES_MCP_TOKEN_FILE. Пароль владельца БД в runtime не передаётся. Для фоновой свёртки нужны DIALOGUES_SUMMARY_ENABLED=true, DIALOGUES_CODEX_SOCKET_URL и DIALOGUES_SUMMARY_CWD; отдельный daemon не создаётся.

Owner-миграцию dist/migrate.js запускают отдельно с DIALOGUES_OWNER_DATABASE_URL, DIALOGUES_OWNER_ROLE и DIALOGUES_APP_ROLE. Она применяет 002_live.sql и 003_context_jobs.sql только к dialogues_live; прежнюю dialogues не меняет. Health: dist/health.js.

Stdio-proxy dist/stdio-proxy.js получает DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. Он восстанавливает устаревшую MCP-сессию чтения; неизвестное изменение автоматически не повторяет.

## Чтение контекста v0.2

Новый цикл: append реальных inputs → context_pull с новым request_id каждого хода → все continuation pages → context_ack → выполнение → append подготовленного final → отправка того же текста. Commentary и служебные model prompts/results не записываются. consumer_id стабилен; context_instance_id отдельный для чата и меняется при потере контекста либо используется reset. Последние 50 отдельных input/final выдаются полностью на каждом ходе. Bootstrap включает свёртки всех бесед; после ACK приходят только их обновления. Свёртки не имеют отдельного лимита размера. Большая свёртка приходит как header text_format=fragments и dialogue_summary_fragment/message_summary_fragment; после всех страниц агент собирает text по Unicode offsets и проверяет total_bytes/text_sha256. Только полный пакет подтверждается ACK. dialogues_message_get также читает точную версию message_summary/dialogue_summary по target и summary_version. Старые четыре MCP сохраняют совместимость для прежних данных; legacy context_get при неделимом крупном summary явно требует перейти на context_pull. Предел 64 КиБ относится к странице, 2 МиБ — к HTTP-запросу, 8 КиБ source — к metadata. Они не задают целевой размер свёртки.

## Явный импорт

dist/import.js capture SOURCE THREAD START_ID формирует закрытый фиксированный снимок по точной границе в DIALOGUES_IMPORT_SNAPSHOT. Разрешённый корень снимков — /var/lib/brai-dev/dialogues-import/. Сохраняются только public response_item пользователь/assistant commentary/final_answer; скрытые рассуждения и результаты инструментов не переносятся.

dist/import.js import SNAPSHOT THREAD START_ID передаёт снимок через тот же MCP и дочитывает каждый оригинал для проверки. Подключение задаётся DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. Вывод содержит только ID, счётчики и хеши, без текстов. Это явная разовая операция, не перехват новых сообщений.

Наличие исходников не подтверждает установленный экземпляр. Установка и подключение проверяются по receipt и реальным вызовам MCP.

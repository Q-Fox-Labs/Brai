# Dialogues

Независимый прямой MCP-сервис для публичных текстов и подготовленных агентом саммари. Владение данными — в PostgreSQL; внешний владелец привязывается конфигурацией MCP. Фоновый worker v0.2 сворачивает беседы точной Luna через существующий Codex App Server.

- [Контракт архивной и live-частей](CONTRACT.md).
- [Карточка компонента](../../docs/components/dialogues.md).
- [Компонент и границы DEV-поставки](component.json).

## Программы

Node.js 24; зависимости pg, MCP SDK и ws. Сборка: npm run build --workspace=@brai/dialogues; тесты: npm test --workspace=@brai/dialogues. PostgreSQL-проверки требуют отдельного disposable fixture и переменных DIALOGUES_TEST_OWNER_DATABASE_URL / DIALOGUES_TEST_DATABASE_URL; без них они явно пропускаются.

Runtime запускает dist/main.js. В том же процессе работают scheduler и один worker; состав источников, очередь и публикация сохраняются в PostgreSQL. Обязательные inputs: DIALOGUES_DATABASE_URL, DIALOGUES_MCP_HOST, DIALOGUES_MCP_PORT, DIALOGUES_MCP_OWNER_ID, DIALOGUES_MCP_ALLOWED_HOSTS, DIALOGUES_MCP_ALLOWED_ORIGINS, DIALOGUES_MCP_TOKEN_FILE. Пароль владельца БД в runtime не передаётся. Для фоновой свёртки нужны DIALOGUES_SUMMARY_ENABLED=true, DIALOGUES_CODEX_SOCKET_URL и DIALOGUES_SUMMARY_CWD; отдельный daemon не создаётся. Запросы к Luna временные: служебные чаты не сохраняются в истории Codex, соединение закрывается после ответа. Готовый результат хранится в PostgreSQL; потерянный запрос повторяется из сохранённого фрагмента в пределах попыток очереди.

Owner-миграцию dist/migrate.js запускают отдельно с DIALOGUES_OWNER_DATABASE_URL, DIALOGUES_OWNER_ROLE и DIALOGUES_APP_ROLE. Она применяет миграции 002–005 только к dialogues_live; прежнюю dialogues не меняет. Health: dist/health.js.

Stdio-proxy dist/stdio-proxy.js получает DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE. При ответе listener 404 до вызова операции он восстанавливает сессию и один раз передаёт тот же запрос; неизвестный исход изменения автоматически не повторяет.

## Обмен и контекст

Рабочий цикл: `dialogues_exchange` с action `input` сохраняет вход и возвращает первую страницу контекста; агент дочитывает страницы через action `page` и подтверждает их отдельным `dialogues_context_ack`. Через `update` он ведёт дополнительные результаты, через `finish` согласует финал до его отправки пользователю. При незавершённых результатах сервис возвращает отказ и обновления; успешный финал новых обновлений не выдаёт. `history` возвращает страницы саммари сообщений беседы, `read` — оригинал конкретного сообщения. Для текстов длиннее 100 Unicode-символов саммари обязательно.

Перед переключением существующей установки owner-миграция 005 и затем `dist/backfill.js` с app-подключением и настройками Luna подготавливают недостающие саммари. Задание возобновляется после сбоя и не изменяет оригиналы. Перед переключением отдельный режим fence обрабатывает хвост и удерживает записи до готовности нового MCP; при сбое или timeout блокировка освобождается. Runtime быстро отказывается стартовать при неподготовленной истории. Фактическая подготовка и переключение требуют отдельного управляемого выпуска. Подробности — в [контракте](CONTRACT.md#обмен-и-контекст).

## Явный импорт

dist/import.js capture SOURCE THREAD START_ID формирует закрытый фиксированный снимок по точной границе в DIALOGUES_IMPORT_SNAPSHOT. Разрешённый корень снимков — /var/lib/brai-dev/dialogues-import/. Сохраняются только public response_item пользователь/assistant commentary/final_answer; скрытые рассуждения и результаты инструментов не переносятся.

dist/import.js import SNAPSHOT THREAD START_ID передаёт снимок через тот же MCP и дочитывает каждый оригинал для проверки. Подключение задаётся DIALOGUES_MCP_URL и DIALOGUES_MCP_TOKEN_FILE; для новых длинных сообщений дополнительно нужны DIALOGUES_CODEX_SOCKET_URL и DIALOGUES_SUMMARY_CWD. Вывод содержит только ID, счётчики и хеши, без текстов. Это явная разовая операция, не перехват новых сообщений.

Наличие исходников не подтверждает установленный экземпляр. Установка и подключение проверяются по receipt и реальным вызовам MCP.

## Примеры и исправление отказов

Ниже — полный вызов `dialogues_exchange` для ввода. Неизвестное время можно
не передавать. Длинный оригинал требует отдельного `summary` в сообщении.

```json
{"action":"input","arguments":{"request_id":"request-1","dialogue":{"id":"chat-1","channel":"codex"},"messages":[{"id":"user-1","text":"Привет","source":{"kind":"codex"}}]},"context":{"consumer_id":"codex:chat-1","context_instance_id":"instance-1"}}
```

После чтения всех страниц подтвердите выдачу через `dialogues_context_ack`:

```json
{"request_id":"ack-1","consumer_id":"codex:chat-1","context_instance_id":"instance-1","delivery_id":"DELIVERY_FROM_CONTEXT"}
```

Для финала используйте `turn_id` и актуальную `version` из квитанции хода:

```json
{"action":"finish","arguments":{"request_id":"request-2","dialogue_id":"chat-1","turn_id":"TURN_FROM_INPUT","expected_version":"1","final":{"id":"final-1","text":"Готово"}},"context":{"consumer_id":"codex:chat-1","context_instance_id":"instance-1"}}
```

Роль и ID хода внутри сообщения не передавайте. Для `input` нужны `id` и
`channel`, а не архивное `external_id`; происхождение и вложения помещайте в
`source`. Эти же примеры доступны агенту в описании MCP-инструмента.

При `INVALID_ARGUMENT` с `applied:false` прочитайте `field`,
`expected` и `allowed`, исправьте запрос и сразу повторите с новым
`request_id`, сохранив ID сообщения и его текст. Например, для
`arguments.messages[0].role` удалите `role`.
При неизвестном исходе сначала проверьте состояние; при `context_error`
дочитайте контекст без повторной записи. Полные гарантии — в
[контракте отказов](CONTRACT.md#отказ-и-исправленный-повтор-mcp).

Отказы MCP поступают в stderr как JSON с `event=request_rejected`,
ID запроса, кодом, полем и длительностью. Содержимое переписки и credentials
в журнал не попадает. В контейнерной установке читайте журнал контейнера;
systemd-журнал обёртки отражает только запуск и остановку.

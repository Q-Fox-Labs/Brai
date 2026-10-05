# История Brai

@brai/history принимает неизменяемые события, предоставляет ограниченное пользовательское чтение и ведёт системные справочники категорий и типов.

- Полный контракт: [CONTRACT.md](CONTRACT.md).
- NATS API и DTO: [asyncapi.yaml](asyncapi.yaml).
- JSON Schema Draft-07: [schemas](schemas/).
- Сборка, запуск, выпуск и восстановление: [DEPLOYMENT.md](DEPLOYMENT.md).

Актуальные категории и типы хранятся в БД. Перед записью события агент получает их через history_categories_list и history_types_list, затем выбирает подходящий тип. Не копируйте начальные строки каталога в документацию; не требуется использовать каждый тип.

## Команды

Запускайте команды из корня репозитория после подготовки зависимостей проекта.

    npm run build --workspace=@brai/history
    npm test --workspace=@brai/history
    npm run typecheck --workspace=@brai/history
    npm start --workspace=@brai/history
    npm run migrate --workspace=@brai/history
    npm run health --workspace=@brai/history
    npm run test:integration --workspace=@brai/history

Start не выполняет миграцию. Сначала отдельно запустите migrate владельцем БД, затем start под рабочими ролями. Health проверяет оба подключения PostgreSQL и NATS.

## Конфигурация процесса

Runtime требует явные переменные окружения:

| Переменная | Назначение |
| --- | --- |
| HISTORY_APP_DATABASE_URL | Подключение рабочей роли приложения. |
| HISTORY_WEB_DATABASE_URL | Отдельное подключение роли web с RLS. |
| HISTORY_CURSOR_HMAC_KEY_FILE | Путь к файлу HMAC-ключа курсора; ключ не короче 32 байт. |
| NATS_URL | Один или несколько адресов NATS через запятую. |
| NATS_USER, NATS_PASSWORD | Учётные данные service_history. |
| NATS_INBOX_PREFIX | Разрешённый ACL префикс inbox, например _INBOX.brai_history. |
| HISTORY_MCP_HOST, HISTORY_MCP_PORT | Внутренний адрес и порт MCP. |
| HISTORY_MCP_ALLOWED_HOSTS | Явный список допустимых Host. |
| HISTORY_MCP_ALLOWED_ORIGINS | Явный список допустимых Origin. |
| HISTORY_MCP_MAX_SESSIONS | Положительный предел одновременных сессий MCP. |
| HISTORY_MCP_SESSION_IDLE_MS | Положительный срок простоя MCP-сессии в миллисекундах. |

Отдельная команда migrate требует HISTORY_OWNER_DATABASE_URL, HISTORY_OWNER_ROLE, HISTORY_APP_ROLE и HISTORY_WEB_ROLE. Все три роли должны различаться; владелец миграций должен владеть целевой БД. Не передавайте владельца миграций runtime-процессу.

Интеграционные проверки разрешены только на выделенном fixture brai_history_test. Задайте HISTORY_TEST_OWNER_URL, HISTORY_TEST_APP_URL и HISTORY_TEST_WEB_URL; все URL должны указывать на 127.0.0.1/brai_history_test. Тесты отказываются работать с другим хостом или БД. Проверка NATS пропускается без явно заданных SOURCE_NATS_URL, SOURCE_NATS_USER, SOURCE_NATS_PASSWORD и SOURCE_NATS_INBOX_PREFIX вместе с runtime-переменными. Используйте только выделенные loopback endpoints и синтетические учётные данные.

## Доступ к истории

Web после проверки BetterAuth-сессии передаёт user_id серверным запросом. Сервис фиксирует scope_type=user и scope_id=user_id, а веб-роль читает события через RLS. Внутренний MCP доступен агентам только в доверенной сети и использует отдельные разрешения. Его ресурсы: brai://history/CONTRACT.md и brai://history/schemas/common.schema.json. Успешный вызов возвращает owner DTO в structuredContent и пустой content. Ошибка возвращается с isError=true и единственным JSON-текстом в content, соответствующим owner DTO {code,message,retryable}; structuredContent для ошибки отсутствует. Ответный JSON-RPC envelope не больше 524 288 байт; предел 10 секунд включает чтение HTTP-запроса, ожидание очереди и выполнение ядра. Запросы к справочникам, события и собственный аудит выполняют общие прикладные операции сервиса.

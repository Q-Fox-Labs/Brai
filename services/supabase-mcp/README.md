# Supabase MCP

Независимый MCP-процесс предоставляет восемь инструментов PostgreSQL по одному адресу `/mcp`. Он использует официальный MCP SDK и прямые подключения PostgreSQL. Cloud API и папка `admin` не нужны.

SQL имеет все права настроенной серверной роли: CRUD, DDL, управление ролями и БД. Разделение прав и авторизация HTTP-клиентов в эту версию не входят. По умолчанию процесс слушает `127.0.0.1`; при другом bind настройте явные `allowedHosts` и защиту доступа на границе экземпляра. Host и Origin проверяются; эти проверки не заменяют авторизацию.

## Сборка и запуск

Из корня продукта:

```sh
npm ci --ignore-scripts
npm run build --workspace=@brai/supabase-mcp
SUPABASE_MCP_CONFIG=/absolute/path/mcp.json npm start --workspace=@brai/supabase-mcp
```

Путь можно передать первым аргументом `node services/supabase-mcp/dist/main.js /absolute/path/mcp.json`. Конфигурация и файлы паролей принадлежат экземпляру; их не хранят в Git. Пароль читает сам процесс, удаляя один завершающий перевод строки.

Пример конфигурации с условными адресами и путями:

```json
{
  "port": 3001,
  "defaultInstance": "local",
  "instances": [{
    "id": "local", "host": "127.0.0.1", "port": 5432,
    "user": "mcp_admin", "passwordFile": "/run/secrets/postgres_password",
    "bootstrapDatabase": "postgres", "tls": false
  }],
  "limits": { "connections": 8, "queue": 64, "deadlineMs": 30000,
    "rows": 1000, "bytes": 1048576, "sessions": 100, "sessionIdleMs": 300000 }
}
```

TLS задают объектом `{"rejectUnauthorized":true,"caFile":"/run/secrets/postgres_ca.pem"}`. `caFile` можно опустить для системных доверенных центров. Для одноразового стенда с PostgreSQL trust поле `passwordFile` можно опустить.

При контейнерном запуске задайте `"host":"0.0.0.0"` и точные HTTP Host, например `"allowedHosts":["localhost:3001"]`. Origin по умолчанию выводится из разрешённых Host с `http://`; для другого origin задайте `allowedOrigins` явно. Публикуйте порт согласно границе доступа экземпляра.

```sh
docker build -f services/supabase-mcp/Dockerfile -t brai-supabase-mcp .
docker run --rm -p 127.0.0.1:3001:3001 \
  -v /absolute/path/mcp.json:/run/mcp.json:ro \
  -v /absolute/path/postgres_password:/run/secrets/postgres_password:ro \
  -e SUPABASE_MCP_CONFIG=/run/mcp.json brai-supabase-mcp
```

## Инструменты и результаты

Точные входные и выходные схемы находятся в [src/contracts.ts](src/contracts.ts) и выдаются стандартным `tools/list`. Гарантии описаны в [CONTRACT.md](CONTRACT.md). Ответ содержит один JSON-объект в `structuredContent` и тот же JSON в текстовом блоке для клиентов MCP.

| Инструмент | Назначение |
| --- | --- |
| `list_instances` | Публичные идентификаторы настроенных экземпляров |
| `list_databases` | Живой каталог с keyset-пагинацией, фильтром имени и шаблонов |
| `list_schemas` | Все пользовательские схемы; system-схемы по явному запросу |
| `list_tables` | Таблицы, столбцы, первичные ключи и внешние связи |
| `list_extensions` | Доступные расширения и установленные версии |
| `execute_sql` | Исходный SQL без автоматического LIMIT и повторов |
| `list_migrations` | Версии и имена общего журнала Supabase без создания таблицы |
| `apply_migration` | Транзакционная миграция и запись версии в одном commit |

Все инструменты БД требуют строку `database`. Необязательный `instance` выбирает `defaultInstance`, когда его нет. Сервер проверяет БД в свежем `pg_database`; доступность соединения подтверждает только реальное подключение. Новый экземпляр требует конфигурации; новые БД, схемы и таблицы обнаруживаются без перезапуска или изменения схем инструментов.

`list_tables.verbosity` раскрывает детали последовательно: `names`, `columns`, `keys`, `relations`. `relations` включает предыдущие уровни. По умолчанию перечисляются все схемы, кроме `pg_*` и `information_schema`; `schemas` и `includeSystem` позволяют изменить отбор.

Ограничение результата не ограничивает изменения SQL. Например, `INSERT ... RETURNING` записывает все строки, хотя ответ содержит только первые строки. `rowCount` показывает результат команды; `truncated` означает пропуск строк, `omittedResults` — пропуск результатов отдельных SQL statements из-за предела сериализованного ответа. `limits.bytes` ограничивает JSON `data`, а не удвоенную MCP-обёртку с текстовой копией. Очень большой отдельный PostgreSQL field драйвер всё равно должен получить и разобрать; deadline и верхняя граница SQL ограничивают вызов, но это не жёсткий предел памяти PostgreSQL или драйвера.

Отмена MCP, закрытие HTTP-ответа, deadline и shutdown закрывают текущее соединение. Запись могла уже завершиться; `outcome:unknown` запрещает автоматический повтор. Клиент проверяет фактические данные или журнал миграций до решения о повторе. `SIGTERM` и `SIGINT` прекращают приём запросов и освобождают соединения.

## Проверки

```sh
npm test --workspace=@brai/supabase-mcp
docker compose -f services/supabase-mcp/test/compose.yml up --wait
TEST_PG_PORT_A=25431 TEST_PG_PORT_B=25432 \
  npm run test:integration --workspace=@brai/supabase-mcp
docker compose -f services/supabase-mcp/test/compose.yml down --volumes
```

Интеграционная проверка требует двух выделенных одноразовых PostgreSQL 17 на loopback, роль `postgres` с trust и чистые экземпляры. Она создаёт синтетические БД и роли, в том числе 300 БД для пагинации. После любого исхода выполните `down --volumes`; стенд содержит только синтетические данные. Тест не читает `.env` или рабочие секреты. PostgreSQL fixtures удаляет владелец стенда после любого исхода. Проверяется настоящий SDK MCP-клиент и HTTP; это само по себе не доказывает handshake конкретного бинарного клиента Codex.

Прямые зависимости закреплены точными версиями в package и lockfile. Перенесённые фрагменты SQL: [NOTICE](NOTICE), лицензия [LICENSE.supabase](LICENSE.supabase).

## Связанные материалы

- [CONTRACT.md](CONTRACT.md).

# Интеграции MemOS

## Эмбеддинги

`embedding/adapter.mjs` предоставляет MemOS HTTP интерфейс `POST /v1/embeddings` и передаёт текстовые запросы в `brai.local_ai.v1.invoke.embed`. Адаптер использует DEV NATS loopback на порту `4223`, закреплённую модель EmbeddingGemma 2 Q8, 768 измерений и назначение `symmetric`. Он сохраняет порядок пакета. Префикс назначения формирует LocalAI согласно своему профилю.

Процесс читает JSON-конфигурацию по пути `BRAI_HERMES_CONFIG`. Он использует эти поля верхнего уровня; остальные поля общей конфигурации Hermes не меняет:

```json
{
  "ownerId": "configured-owner-id",
  "nats": {
    "servers": ["nats://127.0.0.1:4223"],
    "user": "configured-user",
    "password": "configured-password",
    "inboxPrefix": "_INBOX.memos_embedding"
  },
  "embedding": {
    "model": {
      "modelId": "embeddinggemma-2-q8",
      "revision": "bfcd298762cc34d0357ece5ebdd31791a3a374d8",
      "profileId": "embeddinggemma2_llama_cpp"
    },
    "host": "127.0.0.1",
    "port": 19363,
    "timeoutMs": 120000
  }
}
```

`apiKey` нужен, если `host` доступен за пределами loopback. Укажите случайный ключ длиной не менее 32 символов; HTTP-запросы должны передавать `Authorization: Bearer <apiKey>`. Значение ключа не попадает в журнал. `BRAI_HERMES_OWNER_ID`, если задан, должен совпасть с `ownerId` в JSON. Секретные значения хранит оператор в защищённом файле, не в репозитории.

Запуск адаптера: `node services/hermes/memos/embedding/adapter.mjs`. Команда `node services/hermes/memos/embedding/adapter.mjs --health` проверяет уже запущенный HTTP endpoint через `GET /health`; она не отправляет текст и не вызывает модель. Проверки преобразования и ошибок запускаются командой `node services/hermes/memos/embedding/adapter.test.mjs` без NATS и модели.

## Codex bridge

`bridge/codex_bridge.py` поставляется вместе с закреплёнными Python-зависимостями из исходного комплекта. Переменная `MEMOS_CODEX_WORKER_DIR` задаёт рабочий каталог. `MEMOS_CODEX_EXECUTABLE` задаёт абсолютный путь к Codex, установленному владельцем сервиса.


## Потоковое чтение памяти

`patches/postgres-stream.patch` добавляет к закреплённому MemOS отдельный протокол чтения. Его применяет оператор после базовых PostgreSQL-исправлений. Прежние `export_graph` и `/product/get_memory`, включая их прежние особенности фильтрации и постраничности, сохраняют поведение. Наличие патча в исходниках или payload не подтверждает его применение в запущенном MemOS.

Клиент MemOS REST проверяет `GET /product/memory_capabilities`. Значение `data.memory_stream: 1` разрешает `POST /product/get_memory_stream`. При `404` или отсутствии версии клиент использует прежнее полное чтение без добавления скрытого лимита. Неизвестная версия, ошибка согласования или обрыв объявленного потока завершают чтение ошибкой; частичный результат не выдаётся как полная память и запрос автоматически не повторяется.

Запрос потока содержит `mem_cube_id`, `user_id` и необязательный `filter` с точными значениями metadata; `id` выбирает физическую запись, `info.*` — поля `metadata.info`. Куб и владелец обязательны и входят в SQL-условие до чтения. `created_at` и `updated_at` сравниваются с точным Python `isoformat()` SQL-колонок после чтения каждой строки; это сохраняет прежние правила timezone, долей секунды и `NULL`, без выгрузки всего набора в память. Все категории записей сохраняются; graph edges и embeddings не выгружаются. Клиент дополнительно проверяет владельца, куб и исходный фильтр, затем применяет прежние правила приватности.

Ответ — `application/x-ndjson`: заголовок `{"type":"header","version":1,"cube_id":"...","user_id":"..."}`, записи `{"type":"memory","memory":{...}}` и обязательный последний `{"type":"end","count":N}`. Порядок — `created_at DESC, id DESC`. Повтор ID, неверная область, несовпавшее количество, данные после конца или незавершённая строка означают ошибку всего чтения. Максимальная строка — 8 МиБ: чрезмерная запись вызывает явный отказ без усечения; это не ограничение числа воспоминаний.

Сервер использует PostgreSQL cursor с `fetchmany(1)` в одной read-only транзакции `REPEATABLE READ`. Одновременные изменения не создают пропуски между частями ответа. Завершение, исключение и отключение клиента закрывают cursor и откатывают транзакцию перед возвратом соединения. `statement_timeout` и `idle_in_transaction_session_timeout` равны 30 секундам. Клиент проверяет свой временной бюджет при чтении каждого сетевого блока; socket timeout ограничивает отдельное ожидание блока.

`extensions/plugins/memos-rest/business.py` использует тот же scoped client и сохраняет отдельный четырёхсекундный бюджет и проверку источника. Он не повторяет три полных выгрузки под видом HTTP-страниц.

Проверки транспорта находятся в `../extensions/plugins/memos-rest/tests/test_stream_transport.py`. Проверка реального PostgreSQL и HTTP — `tests/test_postgres_stream.py`; ей нужны явные `MEMOS_STREAM_TEST_DSN` только изолированной синтетической БД, `MEMOS_STREAM_SOURCE` с уже скомпонованным `src/memos` и `MEMOS_STREAM_CLIENT` с проверяемым `client.py`. Она проверяет полный набор записей, типы фильтров, границы владельца/куба, snapshot при изменениях, ограничение памяти сервера, HTTP-обрыв и освобождение транзакций. Без явного DSN интеграционная проверка пропускается; это не подтверждение работающего PostgreSQL.

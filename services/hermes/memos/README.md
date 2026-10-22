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

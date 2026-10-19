# Brai для Hermes

Node ESM программы соединяют нативный Hermes с действующими сервисами Brai. Пакеты уже входят в workspace; отдельная установка не нужна. Серверные адреса, секреты и каталоги задаёт конфигурация экземпляра. Программы не запускают основной Brai Agent.

## Запуск

Перед запуском должны быть собраны сервисы Agent и его publisher. Доступы Hermes к NATS и Transcription задаются отдельно от доступов отключаемого Agent.

```sh
BRAI_HERMES_CONFIG=/absolute/private/hermes.json \
BRAI_HERMES_OWNER_ID=canonical-owner \
node services/hermes/tools.mjs
```

В конфигурации Hermes этот процесс подключается как MCP stdio сервер. В stdout идёт только MCP. Обязательная защищённая конфигурация:

```json
{
  "ownerId": "canonical-owner",
  "nats": {
    "servers": ["nats://broker.internal:4222"],
    "user": "hermes",
    "password": "provided-by-runtime",
    "inboxPrefix": "_INBOX.brai_hermes"
  },
  "elements": {
    "url": "http://elements.internal:8080/mcp",
    "ownerId": "canonical-owner"
  },
  "history": { "url": "http://history.internal:8080/mcp" },
  "transcription": {
    "url": "http://transcription.internal:8080/mcp",
    "token": "provided-by-runtime"
  },
  "publisher": { "configPath": "/absolute/private/publisher.json" },
  "requestTimeoutMs": 12000,
  "longRequestTimeoutMs": 300000,
  "tts": {
    "model": {
      "modelId": "silero-tts-ru-v5_5",
      "revision": "50081637b602126ee06cb3bc8a744d25651d2da1",
      "profileId": "silero_pytorch"
    }
  }
}
```

`elements.ownerId` подтверждает привязку доверенного owner-bound endpoint. Он должен совпадать с владельцем конфигурации самого Elements и `BRAI_HERMES_OWNER_ID`. Transcription bearer должен быть заранее привязан владельцем сервиса к тому же owner. Модель не передаёт owner ни одному инструменту. Параметр `publisher.entrypoint` позволяет явно указать абсолютный путь к готовому `publisher-mcp.js`; по умолчанию используется соседний `services/agent/dist/publisher-mcp.js`.

Конфигурация publisher описана в [PUBLISHER.md](../agent/PUBLISHER.md). Его `resultRoot` должен совпадать с `BRAI_TELEGRAM_RESULT_ROOT`; `allowedReadRoots` включают только рабочие каталоги Hermes, которые можно публиковать. Не добавляйте секретные каталоги. Веса моделей и базы сервисов не относятся к результатам агента.

## Telegram и голос

Доверенный Telegram плагин запускает `node services/hermes/trusted.mjs` с теми же двумя переменными окружения. Он использует ограниченный JSON-RPC stdio, описанный в [CONTRACT.md](CONTRACT.md) и [trusted.openrpc.json](trusted.openrpc.json). Этот процесс нельзя регистрировать как инструмент модели.

`voice.mjs --input /absolute/text.txt --output /absolute/speech.ogg --voice eugene` подключает нативный tts Hermes к Local AI. Вход — UTF-8 файл с текстом до 900 Unicode code points; выбранная модель приходит из `tts.model`. Результат получает Artifacts ID и восстанавливается через publisher с проверкой owner/hash. Готовый OGG копируется в незанятый путь output. Timeout не вызывает автоматический новый синтез.

Постоянные задачи и решения хранятся в game-core/Elements. Встроенный todo Hermes служит временной рабочей заметкой.

## Проверки

```sh
npm test --workspace=@brai/hermes
```

Проверки подтверждают owner boundary, запрещённые human вызовы модели, неизвестный исход и отсутствие повторов, настоящий MCP SDK, JSON-RPC, stale callbacks и голосовой файловый мост. Живые ACL, настройки владельца MCP и доставка Telegram проверяются отдельно при приёмке экземпляра.

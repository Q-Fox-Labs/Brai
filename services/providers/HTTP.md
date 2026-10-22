# Ограниченный внутренний Chat Completions

Это собственный вход providers для встроенного `fetch` Node.js 24.22.1
(Undici 7.29.1). Он проверен на JSON, SSE и function tools. Он использует тот же
`createOperations` и PostgreSQL, что и NATS. Прямого proxy к LiteLLM нет.
Инструменты выполняет caller.

## Запуск и доступ

HTTP выключен без `PROVIDERS_HTTP_PORT`. В штатном `main` нужны PG и три
переменные из защищённого env_file: `PROVIDERS_HTTP_TOKEN` (32–256 символов),
`PROVIDERS_HTTP_OWNER_ID`, `PROVIDERS_HTTP_CONNECTION_ID` (1–64 букв/цифр/`_-`).
Один токен закреплён за одной доверенной identity. `PROVIDERS_HTTP_HOST` по
умолчанию `127.0.0.1`; другой адрес допустим только во внутренней сети с
контролируемым доступом. Публичный ingress требует отдельного TLS/auth решения.
`createChatHttp(operations, identities)` допускает до 16 таких identity.
Конфигурация и bearer не записываются в ответы или логи.

Каждый запрос требует `Authorization: Bearer <token>`. Токен проверяется до
чтения тела; сравнение использует `timingSafeEqual`. Owner и connection берутся
только из закреплённой identity. `X-Owner-Id` и другие заголовки scope не дают
полномочий. Поля owner/connection в JSON неизвестны и отклоняются.
Брокерные ACL NATS остаются отдельной границей доверенного service caller.

## POST /v1/chat/completions

Обязательные заголовки: `Content-Type: application/json`, `X-Request-Id` (UUID
операции) и `X-Brai-Deadline-At` (неизменяемый RFC3339 deadline).
Необязательный `Idempotency-Key` обязан равняться `X-Request-Id`.
В ответе `X-Request-Id` и `Location: /v1/operations/{UUID}` связывают HTTP с ledger.
Caller сохраняет ID и deadline **до** отправки. Точное повторение даёт прежнюю
операцию; другое содержимое с тем же owner/ID даёт 409. Новый запрос модели
никогда не возникает при GET или точном replay.

| Поле | Поддержка |
| --- | --- |
| `model` | Только `deepseek/deepseek-v3.2`, provider фиксирован `openrouter`; маршрут задаёт существующий каталог/ядро |
| `messages` | До 32 сообщений `system`/`user` с текстовым `content`; начальный ход требует хотя бы одно |
| `stream` | Boolean, по умолчанию false; обычный JSON либо SSE |
| `stream_options` | Только `{ "include_usage": true }`, только при stream=true |
| `tools` | До 8 function tools; та же схема, что в v1: плоские scalar properties, required и additionalProperties=false |
| `tool_choice` | `auto` (по умолчанию), `none`, `required` |
| `max_tokens` | Целое 1–2048; по умолчанию 1024 |
| `n` | Только 1, необязательно |
| tool messages | Только при continuation; `{role:"tool",tool_call_id,content}` перед новыми system/user сообщениями |

Машинная форма — `httpChatRequest` в [схеме владельца](schemas/v1.schema.json).
Неизвестные поля отклоняются. Не поддержаны assistant-history от caller,
multimodal content, attachments/artifactIds на этом входе, temperature/top_p,
stop, seed, response_format/JSON mode, logprobs, parallel_tool_calls,
max_completion_tokens, store, metadata, user и произвольные provider-параметры.
Нет Responses API, OAuth и обещания совместимости Codex или готовых SDK.

JSON success содержит `id` (исходный UUID), `object=chat.completion`, `created`,
`model`, один choice с полным assistant message, `finish_reason`, `usage` либо
null. `brai` содержит operationId, phase и `continuation:{operationId}`.
Tool arguments представлены JSON-строкой, ID сохраняются. Provider continuation
state остаётся в durable результате ядра; HTTP его не принимает и не заменяет.

SSE выдаёт `data: {...}\n\n`, `object=chat.completion.chunk`, один choice;
text deltas поступают во время вычисления. Полные tool calls выдаются после
проверки полного upstream turn. Финальный chunk содержит finish_reason и brai,
при include_usage затем идёт accounting chunk с choices=[], затем `[DONE]`.
При replay сервер строит завершённый поток из сохранённого результата;
повтор upstream и переигрывание token events ядра не происходят.
Частичные tool fragments исполнять нельзя. Caller ждёт валидный полный итог
или восстанавливает его GET перед исполнением tools.

## Продолжение tools

Caller исполняет каждый полученный tool с собственной проверкой полномочий.
Следующий POST использует **новый** UUID, новый deadline и заголовок
`X-Brai-Continuation: <UUID предыдущего успешного хода>`. В messages передаются
все tool results с исходными IDs ровно по одному; tools повторяются.
Можно добавить новые system/user messages после tool results. Подменённые,
повторные, лишние и недостающие IDs отклоняются до dispatch. Старый owner,
connection, model и provider должны совпадать. Ядро добавляет точный сохранённый
context/raw assistant, включая opaque provider fields; caller не пересылает state.

## Восстановление и пределы

`GET /v1/operations/{UUID}` с тем же bearer возвращает полный JSON success в
формате POST либо `{id,phase,errorCode,resultExpired}` для незавершённого или
неуспешного результата. Чужой owner неотличим от отсутствующего: 404.
Успешный истёкший результат даёт безопасную ошибку RESULT_EXPIRED; исходный
ID остаётся защищён tombstone. Сроки ядра: результат 24 часа, ключ 7 суток.

При разрыве/отсутствии `[DONE]` caller делает GET прежнего ID. Закрытие HTTP
не отменяет уже принятый compute. Pending читается позднее; unknown не разрешает
автоматически создавать новую операцию. Во время ожидания POST читает только
состояние, не вызывает модель повторно. Endpoint отмены на HTTP не предоставлен.

Ошибки имеют `{error:{code,message:code,outcome}}` без upstream body. 401 —
неверный bearer, 400 — неверный/неподдержанный вход или continuation, 404 — нет
owner-scoped записи, 409 — конфликт содержимого, 429 — заняты слоты, 503 —
безопасная ошибка выполнения/хранилища или неопределённость. После SSE headers
ошибка идёт отдельным error frame **без** `[DONE]`; caller читает GET.

Сервер ограничен 32 соединениями и 8 активными HTTP handlers без очереди;
model slots по-прежнему общие 2 без очереди. Body ≤64KiB, request timeout 10с,
headers 5с. Ожидание принятой операции ≤95с. SSE ≤1MiB суммарно и ≤32KiB
неподтверждённых bytes. Медленный получатель/переполнение закрывает соединение;
результат остаётся доступен GET. Никаких бесконечных буферов или retry model нет.

## Минимальный fetch

```js
const operationId = crypto.randomUUID();
const deadlineAt = new Date(Date.now() + 90000).toISOString();
// Сохранить operationId/deadlineAt; bearer приходит из защищённой конфигурации caller.
const response = await fetch(`${internalOrigin}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    'x-request-id': operationId,
    'x-brai-deadline-at': deadlineAt,
  },
  body: JSON.stringify({
    model: 'deepseek/deepseek-v3.2',
    messages: [{role: 'user', content: 'Hello'}],
    max_tokens: 64,
  }),
});
const result = await response.json();
```

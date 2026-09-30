# Веб-интерфейс таймера

Одна страница Next.js показывает общий таймер и историю. Шлюз HTTP/SSE находится в том же Node.js процессе. Веб-приложение не читает БД и внутренний код сервиса таймера.

## Запуск

Из корня: `npm ci`, `npm run build:web`, `npm run typecheck:web`, `npm run lint`, `npm run test:web`. Из `apps/web`: `npm start` или `npm run dev`. Версии Node.js/npm закреплены в корневом package.json.

За обратным TLS-прокси явно задать `WEB_ORIGIN` — канонический публичный HTTPS origin без пути. Проверка Origin использует его; для локального запуска без прокси допустим fallback protocol + Host. Forwarded заголовки самостоятельно не считаются доверенными.

Серверные переменные: `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_INBOX_PREFIX` (по умолчанию `_INBOX.brai_web`). Не задавать их через `NEXT_PUBLIC_*`. Приложение не читает файлы `.env` самостоятельно; оператор передаёт окружение. В браузере остаются только относительные HTTP URL. За TLS и доступ к общему таймеру отвечает оператор.

Один процесс Next.js владеет одним pull durable `web_events` потока `BRAI_TIMER_EVENTS`. Горизонтальное масштабирование с общей durable не поддерживается: события распределились бы между процессами. Рестарт процесса и потеря событий за срок хранения восстанавливаются через snapshot и command ledger. Браузер сохраняет pending команду целиком в sessionStorage.

## Контракт HTTP/SSE

Владелец HTTP/SSE — это приложение. Wire DTO и машинные схемы принадлежат [сервису таймера](../../services/timer/README.md), [commands](../../services/timer/schemas/commands.schema.json) и [messages](../../services/timer/schemas/messages.schema.json); сервер валидирует эти owner schemas напрямую. События не получают дополнительных бизнес-полей.

| Метод | Запрос | Успешный ответ |
| --- | --- | --- |
| POST `/api/timer/start` | StartCommand | 202 `{commandId,status:"queued"}` только после PubAck |
| POST `/api/timer/stop` | StopCommand | такой же 202 |
| GET `/api/timer` | нет | SnapshotResponse |
| GET `/api/timer/history?cursor=…&limit=50` | HistoryRequest; limit 1..100 | HistoryResponse |
| GET `/api/timer/commands/{commandId}` | CommandLookupRequest | CommandLookupResponse |
| GET `/api/timer/events` | нет | SSE `snapshot`/`change` |

POST принимает JSON не более 2048 bytes; неверный вход отклоняется до публикации. Дополнительные поля запрещены owner schema. Чужой Origin получает 403. Курсор передаётся сервису без собственного кодирования. Чтения не кешируются.

Ошибки: `{code,outcome}`. 400/413/415/403 означают отказ до публикации. 503 `PUBLISH_REJECTED` — явный отказ брокера, `outcome:"not-published"`; 502 `PUBLISH_UNKNOWN`, `outcome:"unknown"` — публикация могла сохраниться. Повтор всегда использует исходные body и commandId. `UNAVAILABLE` означает недоступность границы. Чтение результата с 404 `NOT_FOUND` означает только отсутствие завершённого ledger результата; команда может находиться в очереди. Окончательное отклонение команды приходит как RejectedEvent в ledger/SSE, а не как HTTP 202 error.

SSE подключает подписчика до snapshot и буферизует до 64 событий. `snapshot` data — SnapshotResponse, `change` data — StartedEvent, StoppedEvent или RejectedEvent. Повторы ограниченно устраняются по eventId; версия защищает состояние и после вытеснения ID. Старый результат разрешает pending по commandId независимо от версии. Пропуск версии закрывает поток; новая связь всегда начинает со свежего снимка. Раз в 15 секунд поток передаёт heartbeat без запроса к сервису. Очередь клиента ограничена 64 frames плюс один transport frame, подписчиков не более 128. Переполнение отключает клиента; history/ledger не теряются. ACK брокеру подтверждает bounded разветвление, не просмотр события браузером.

Браузер блокирует новые команды без свежего snapshot и при pending. Ledger проверяется раз в 2 секунды до результата без таймаута отмены; после NOT_FOUND повторяет прежний body/id при восстановленной связи, пока не получил HTTP 202. После PubAck только проверяет ledger, не заполняя очередь повторами. После reload исходная команда может быть повторена один раз до нового PubAck; эффект идемпотентен. Однозначный отказ первой публикации снимает pending; отказ повтора после unknown сохраняет ожидание исходной команды. Visibility/pageshow требуют resync. Часы вычисляются по serverTime + performance.now(), часы больше суток не обнуляются. История сохраняет ранее загруженные страницы при live updates и resync. Если свежие 50 записей не пересекаются со старой историей, загрузка следующих страниц начинается с нового owner cursor, чтобы заполнить промежуток после долгого отключения.

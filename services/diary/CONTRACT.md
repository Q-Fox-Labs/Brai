# Diary v1

Владелец: `services/diary`. Записи и задания находятся в собственной PostgreSQL;
байты аудио принадлежат Artifacts. Web — клиент, а не владелец дневника.
Сервис не читает БД соседей и не импортирует внутренности Hermes или Providers.

Машинные интерфейсы: [HTTP](contracts/http.openapi.json),
[MCP](contracts/mcp.json). Вход Web описан [у клиента](../../apps/web/app/diary/CONTRACT.md).

## Приём и представления

Аудио создаётся с requestId UUID, filename, audio MIME, recordedAt ISO/null и
timezone IANA. recordedAt означает известное время записи, а не mtime файла.
Владелец определяется только проверенной Auth-сессией либо защищённой MCP-привязкой.
Входные ownerId, profileId и выбор модели не принимаются.

До передачи байтов сохраняется намерение и возвращается entry. Artifacts prepare
повторяется с прежним ключом, owner и метаданными, source=diary, kind=original;
details связывает entryId и роль original. Один owner/requestId и одинаковый
нормализованный вход возвращают одну запись; иной вход даёт 409 IDEMPOTENCY_CONFLICT.
Полный PUT проверяет x-content-size, SHA-256 и состояние ready в Artifacts.
202 означает принятый оригинал, а не готовую расшифровку.

Потеря HTTP-ответа не отменяет принятый файл. Повтор ready-файла проверяет байты,
не заменяет оригинал и не запускает вторую запись. Браузер использует дозагрузку: GET /v1/upload/{id} читает подтверждённые offset,
totalBytes, chain, chunkBytes и ready; PATCH добавляет одну часть.
x-content-size задаёт весь размер, upload-offset и upload-chain — ожидаемый
префикс. Формат и хранение частей определяет [Artifacts](../artifacts/CONTRACT.md#дозагрузка).
Web не получает bearer URL. Конфликт позиции даёт 409 UPLOAD_CONFLICT: сначала
нужно перечитать состояние, затем отправить только недостающую часть.
Намерение без файла сохраняется awaiting_upload; failed original даёт
needs_attention/UPLOAD_INTERRUPTED. Подтверждённый полный повтор может снять
только эту ошибку загрузки. Удалённый оригинал даёт AUDIO_UNAVAILABLE.

## Обработка и завершение

Состояния: awaiting_upload → transcribing → correcting → ready.
needs_attention означает остановку для проверки; errorCode сообщает границу сбоя.
Промежуточное состояние и результат каждого успешного этапа сохраняются в БД.
Один worker выбирает готовые задания с advisory lock; незавершённая загрузка
не блокирует другие записи. Закрытие вкладки не отменяет задание.

Transcription вызывается по [контракту владельца](../transcription/CONTRACT.md):
`/internal/identity/transcription`, собственный opt-in bearer с identity:delegate,
проверенный личный principal с transcription:use и serviceDataScope из публичного
[контракта Auth](../auth/contracts/service-data-scope.mjs).
request.submit использует entry.id как clientIdempotencyKey;
requestedModel/deadlineAt=null. result.get читает прежний запрос.
rawText сохраняется до вызова редактора вместе с requestId и actualModel.
Неизвестный или потерянный результат не выдаётся за готовый текст.

Luna вызывается отдельной ephemeral thread, строго gpt-6-luna/medium, без fallback,
истории других записей, инструментов, MCP, файлов и сети. Prompt diary-v1
исправляет распознавание, пунктуацию и абзацы, сохраняя смысл и авторский голос.
Ответ содержит ровно correctedText, eventDate, dateStatus, dateEvidence.
Календарь и согласованность полей проверяются программно.
Для identified обязательны дата YYYY-MM-DD и непустое свидетельство.
При отсутствии или неоднозначности даты: eventDate=null, needs_clarification.
uploadedAt не используется как дата события; относительная дата требует recordedAt.
Результат хранит модель, promptVersion, время и точный rawResponse; rawText не заменяется.

До вызова Luna сохраняется lunaStartedAt. Любая ошибка LUNA_* и восстановление
после неизвестного исхода останавливают запись в needs_attention без автоматического
повторного вычисления. Это не обещает exactly-once у внешнего провайдера.
Чтение или повтор загрузки не запускают модель заново.
Временные ошибки зависимостей откладывают задание; терминальные ошибки ASR,
утрата результата, отзыв Auth и нарушение owner требуют проверки.

Текст агента сохраняется без модельного преобразования: точные пробелы/абзацы,
rawText=correctedText, source=text, state=ready. eventDate передаётся явно либо null;
dateStatus=provided либо needs_clarification. Смена существующего текста,
удаление записей, ручной retry модели и публичные ссылки не предоставляются.

## Доступ и границы

HTTP и MCP проверяют активный user/profile в Auth на каждом обращении.
Cookie-сессия дополнительно требует x-brai-user, совпадающий с текущим пользователем.
Это защита от устаревшей вкладки, а не способ выбрать owner.
Bearer привязан к одному user/profile конфигурацией оператора.
Browser-мутации требуют canonical Origin; любые переданные Origin должны совпадать.
Host проверяется allowlist. Ответы приватные и no-store.

App-роль БД ограничена RLS с transaction-local diary.owner_id. Отдельная worker-роль
не владеет БД/таблицей и имеет только нужные операции очереди; её credentials
не используются входным HTTP/MCP. Мигратор — третья отдельная роль, владелец БД.
Runtime-ролям запрещены расширенные права и membership других ролей.

Исходящие NATS-запросы используют контракты владельцев:
[Auth](../auth/README.md), [Artifacts](../artifacts/CONTRACT.md).
Новые NATS-команды и события не публикуются. Отдельные события History этой версией
не создаются: состояние записи и происхождение её представлений принадлежат Diary.

## Пределы и ошибки

JSON-вход до 2 МиБ; текст до 1 МиБ UTF-8; имя файла до 1024 байт,
название записи до 512 байт, evidence до 8192 байт. Аудио непустое, до заданного
maxAudioBytes (Web до 2 ГиБ); меньший предел Artifacts также обязателен.
Список содержит до 50 записей, offset неотрицательный safe integer.
Сортировка: дата события, иначе время создания, по убыванию, затем id.
Неизвестная дата при этом остаётся null.

Listener ограничивает до 8 обработчиков и 32 соединений; перегрузка даёт 429.
Передача файла потоковая; полный файл не буферизуется в Web/Diary.
Загрузка имеет лимит 30 минут. NATS-запрос — 10 секунд, Transcription HTTP —
20 секунд, Luna handshake/RPC — 15 секунд, turn — 180 секунд; при завершении
вызова закрывается socket и освобождается worker lock. Shutdown прекращает приём
новых заданий и ждёт завершения текущего шага; процесс может быть остановлен
оператором, сохранённое задание восстановится по правилам выше.

HTTP ошибки: 400 INVALID_ARGUMENT/INVALID_DATE/INCOMPLETE_FILE,
401 UNAUTHORIZED/ACCOUNT_CHANGED, 403 HOST/ORIGIN/USER_REVOKED,
404 NOT_FOUND, 409 IDEMPOTENCY_CONFLICT/CONTENT_CONFLICT/NOT_READY,
413 TOO_LARGE, 429 OVERLOADED, 502 BAD_REPLY,
503 UNAVAILABLE/DEPENDENCY_UNAVAILABLE/UPLOAD_UNCONFIRMED.
Точный errorCode задания может уточнять ошибку Transcription или Luna.
MCP ошибки инструмента возвращают isError и безопасный code без секретов;
ошибка доступа к endpoint отклоняет сам запрос.

Бэкап охватывает Diary DB и Artifacts. Гарантии файлов и их lifecycle задаёт
[Artifacts](../artifacts/CONTRACT.md); Diary не превращает загрузку в публичную ссылку.

# Контракт сервиса artifacts

Владелец контракта — services/artifacts. AsyncAPI и потребители ссылаются на единое дерево Draft-07 в schemas/messages.schema.json, доступное через contracts/index.mjs. Общие правила заданы спецификациями contract-authoring и service-messaging проекта.

## Граница

NATS Service называется brai_artifacts, версия контракта — v1; экземпляры объявляют name, version и instance ID и поддерживают стандартные PING, INFO и STATS. Команды и metadata идут по request-reply через queue group brai_artifacts. Успешная нагрузка — прямой DTO без JSON-RPC или общей оболочки. NATS-ошибка передаётся заголовками Nats-Service-Error и Nats-Service-Error-Code; первое содержит краткую причину, второе — HTTP status строкой. 400 INVALID_ARGUMENT, 404 NOT_FOUND, 409 CONFLICT, 413 PAYLOAD_TOO_LARGE или LIMIT_EXCEEDED, 429 OVERLOADED, 500 INTERNAL, 503 STORAGE_UNAVAILABLE или SHARING_NOT_CONFIGURED.

HTTP передаёт только байты файла. prepare возвращает bearer URL PUT /upload/{token}. При успехе PUT отвечает 201 Created с пустым телом и заголовками X-Artifact-Id, X-Artifact-State: ready, X-Artifact-Size (десятичное число байтов), X-Artifact-SHA256 и Location (значение internalUrl); так инициатор сразу получает ID, состояние, размер, hash и постоянный URL без передачи metadata JSON. Их единая схема — UploadResponseHeaders в schemas/messages.schema.json. Внутренняя выдача — GET/HEAD /files/{key}; готовы Range и условные запросы. key детерминированно выводится из UUID artifactId; имя файла не входит в путь. internalUrl существует только при статусе ready и равен internalBaseURL + /files/{key}. NATS доступен только доверенным внутренним сервисам; consumer сверяет ownerId с проверенной сессией до get/update/delete и не считает артефактный ID полномочием. Внешняя выдача — GET /share/{token} с проверкой отдельного разрешения; ссылка создаётся только link.create. GET/HEAD и ошибки HTTP не содержат metadata JSON; GET отдаёт байты, HEAD — пустое тело. Upload token и внешние URL не попадают в логи.

## DTO и операции

Artifact хранит UUID artifactId, ownerId, requestId, kind (original|copy), состояние (pending|ready|deleting|deleted|failed), редактируемые title, исходное filename, extension, mimeType, source, необязательные geotag, materialCreatedAt, details, вычисленные sizeBytes и sha256, createdAt, updatedAt, необязательный deletedAt, и при ready — internalUrl. До готовности размер и SHA-256 равны null. Готовое содержимое неизменно; новая версия создаёт новый ID.

| Subject | Запрос | Успешный ответ |
| --- | --- | --- |
| brai.artifacts.v1.prepare | {requestId,ownerId,kind,metadata} | {artifact,uploadUrl} |
| brai.artifacts.v1.get | {artifactId} | Artifact |
| brai.artifacts.v1.update | {requestId,artifactId,metadata} | Artifact |
| brai.artifacts.v1.list | {filter:{ownerId,kind?,status?,source?},sort,order,limit,offset} | {items,total,limit,offset,sort,order} |
| brai.artifacts.v1.stats | {ownerId} | {originalCount,copyCount,totalCount,originalBytes,copyBytes,totalBytes} |
| brai.artifacts.v1.delete | {requestId,artifactId} | Artifact со статусом deleted |
| brai.artifacts.v1.relation.add / .remove | {requestId,modelArtifactId,originalArtifactId} | {relation} |
| brai.artifacts.v1.relation.list | {artifactId} | {items} |
| brai.artifacts.v1.reference.reserve | {scope,clientUserMessageId,commandHash,attachments} | {created,reference} |
| brai.artifacts.v1.reference.get | {scope} | {reference} |
| brai.artifacts.v1.reference.confirm | {scope,clientUserMessageId,turnId,itemId} | {reference} |
| brai.artifacts.v1.reference.list | {scope,nativeItemIds} | {items} |
| brai.artifacts.v1.reference.update-state | {scope,state} | {reference} |
| brai.artifacts.v1.link.create | {requestId,artifactId,expiresAt?} | {link} |
| brai.artifacts.v1.link.revoke | {requestId,linkId} | {link} |

prepare.metadata требует title, исходное filename, extension, mimeType, source; геометка, UTC materialCreatedAt и произвольный объект details необязательны. Ограничения длины строк считаются в Unicode code points. Непредставимые в PostgreSQL NUL и непарные UTF-16 surrogates в строках и JSON ключах дают 400 INVALID_ARGUMENT; они не означают недоступность хранилища. update.metadata — непустой patch этих полей без ownerId, размера, hash, состояния или байтов. list всегда ограничен ownerId, сортируется стабильно по createdAt или sizeBytes с artifactId как tie-breaker; order — asc или desc. stats включает только ready; deleting исключён с начала удаления. Размер deleted записи сохраняется для истории.

Relation — уникальная пара model/copy → original. Повторное добавление не создаёт дубликат; удаление отсутствующей связи успешно. Обе записи должны принадлежать одному owner. Reference scope — {ownerId,projectId,threadId,operationId}. Attachment — упорядоченная пара {originalArtifactId,modelArtifactId}. Все ID должны принадлежать owner. commandHash — SHA-256 канонического native payload; clientUserMessageId сохраняет точное значение native-команды.

reference.reserve атомарен и возвращает created=true только первому исполнителю. Точный повтор scope, clientUserMessageId, hash и attachments возвращает сохранённую запись с created=false; другое содержимое для занятого ключа даёт 409 CONFLICT. Состояние pending или unknown после перезапуска не разрешает повторно отправить native-команду. Клиент сначала читает запись через get; новую operationId выбирает владелец команды. Состояния — pending, unknown, confirmed и not-sent. confirm привязывает точные scope и clientUserMessageId к turnId/itemId; повтор той же пары идемпотентен, другая привязка даёт конфликт. confirmed нельзя откатить. update-state может явно установить только unknown или not-sent; unknown автоматически не становится not-sent. list принимает owner/project/thread и точные nativeItemIds, чтобы искать references для страницы истории.

prepare и link.create используют устойчивый непрозрачный requestId длиной 1–256 символов. Точный повтор возвращает тот же результат; тот же ключ с другими параметрами даёт 409. update не обещает долговременную дедупликацию patch. delete и revoke безопасно повторять; удаление сохраняет запись. При потере NATS-ответа исход неизвестен: prepare/link.create повторяют с тем же ключом, для прочих сначала читают состояние или повторяют идемпотентную операцию. Core NATS не обеспечивает сохранение или однократность; JetStream не используется.

Жизненный цикл файла: pending → ready после полного потока, вычисления размера и SHA-256, публикации объекта и фиксации записи. Обрыв или отмена PUT не делает частичный объект доступным; запись остаётся pending либо переходит в failed, а временные байты очищаются по настроенному TTL. Остановка сервиса не отменяет уже сохранённый ready объект. До публикации готовый ключ недоступен. Во время deleting Caddy может ещё отдавать файл до удаления байтов: управляющий сервис сначала unlink-ит объект и лишь затем фиксирует deleted. После unlink GET/HEAD возвращают not found; ответ об успешном delete приходит только после unlink и записи deleted. Удаление проходит ready → deleting → deleted; успех означает, что байты физически удалены и запись сохранена. Связи остаются. Если PUT завершился неизвестно клиенту, повтор для уже ready неизменного объекта отвечает 409; клиент проверяет get по artifactId из prepare.

Если внешняя sharing-база не настроена, link.create возвращает 503 SHARING_NOT_CONFIGURED. Истёкшая или отозванная ссылка и ссылка на удалённый файл не выдаются. Обычная загрузка, чтение, list и MCP не создают внешнюю ссылку. limit и nativeItemIds ограничиваются настроенным пределом входного NATS payload и максимальным ответом сервиса; превышение даёт 413 PAYLOAD_TOO_LARGE. Сервис не закрепляет число сверх настроенной HTTP и NATS ёмкости.

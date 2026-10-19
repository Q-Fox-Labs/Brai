# Инструменты Hermes

Владелец этой границы — `services/hermes`. Программа `tools.mjs` предоставляет MCP stdio по официальному SDK. Её входные схемы берутся из MCP владельца или опубликованных JSON Schemas соседей. Собственных таблиц, очереди и универсального транспорта команд нет. Историю изменений сохраняют владельцы; мост не создаёт дублирующих History фактов.

## Связи и доверие

| Вход Hermes | Порт владельца | Ограничение |
| --- | --- | --- |
| `elements_*` | [game-core MCP](../elements/CONTRACT.md) | Owner-bound endpoint; human claim/complete/fail модели запрещены. |
| `publish_file`, `fetch_file` | [publisher MCP stdio](../agent/PUBLISHER.md) | Независим от основного Agent. Metadata NATS, байты HTTP, owner/ready/SHA-256 проверяются publisher. |
| `timer_*` | [Timer v2](../timer/README.md) | Команды JetStream; чтение NATS Services; userId добавляет мост. |
| `history_list`, `history_get` | [History scoped queries](../history/CONTRACT.md) | Только user scope текущего owner, без SQL/произвольного scope. |
| Три инструмента справочника History | Готовый History MCP | Только categories_list, types_list, type_get; административные инструменты скрыты. |
| `alerts_*` | [Alerts owner API](../alerts/CONTRACT.md) | list/get/summary/read/read_all; user_id добавляет мост. |
| `transcription_*` | [Transcription MCP](../transcription/CONTRACT.md) | Trusted bearer с фиксированным principal; обычные локальные расшифровки идут через coordinator. |
| `local_ai_*` | [Local AI owner API](../local-ai/CONTRACT.md) | Каталог, install/state/configure/load/unload/remove, embed, synthesize, cancel/status. OwnerId добавляет мост. |

Поток файла: Hermes working file → publisher snapshot → Artifacts prepare → HTTP bytes → подтверждение ready/hash → неизменяемая локальная копия → Telegram native upload. Входящий Telegram файл проходит тот же publish; последующие потребители получают Artifact ID. Модель не получает произвольный NATS/SQL инструмент, upload URL или право читать чужой артефакт.

Запуск требует защищённого JSON и отдельного доверенного `BRAI_HERMES_OWNER_ID`. Они должны совпадать. NATS identity Hermes имеет только необходимые subjects и свой inbox; старые связи сервисов не меняются. Credentials не включаются в ошибки. Конфигурация экземпляра отвечает за owner binding Elements endpoint и Transcription bearer. Подмена owner во входе отвергается.

## Выполнение и неизвестный исход

Обычный NATS timeout — 12 секунд, конфигурируемый до 60 секунд. Долгие Local AI/MCP вызовы — до `longRequestTimeoutMs`, по умолчанию 300 секунд и максимум 30 минут. Publisher сохраняет собственный deadline до 30 минут. Переданный `deadlineAt` Local AI не переписывается. До 8 MCP вызовов исполняются одновременно; очереди нет, девятый получает `OVERLOADED`. Publisher дополнительно ограничивает собственные операции до двух. JSON вход ограничен 65536 байтами, NATS ответ — 1 MiB; DTO владельца могут иметь более строгие ограничения. Остановка закрывает собственные MCP/NATS подключения и дочерний publisher.

Команда Timer возвращает `{commandId,status:"stored",outcome:"unknown",nextTool:"timer_command_get"}` после PubAck. Это подтверждает только хранение команды. Итог читается по прежнему commandId. PubAck timeout не означает отсутствие команды. `Nats-Msg-Id` не используется: изменённая команда с прежним ID должна получить owner conflict, а не быть скрыта транспортной дедупликацией.

При возможной отправке mutation и потерянном/просроченном ответе мост выдаёт `OUTCOME_UNKNOWN`. Автоматического повтора нет. Caller сохраняет исходные параметры и ключ: Timer — commandId, publisher — requestId, Elements claim — idempotency_key, revise — revision_id. Для create заранее задаются устойчивые UUID; после неизвестного исхода читается graph. Local AI invoke не имеет гарантии однократности; новый вызов означает новую вычислительную попытку. Transcription после submit сверяется через request.get/result.get, без повторного compute. Подтверждённые бизнес-ошибки сохраняют безопасный код владельца.

## Человеческие действия

Модель может создать Action и вызвать `elements_request_human_action({moveId})`. Ответ содержит moveId, revisionId, targetId, title и `nextTool:brai_telegram_request_confirmation`. Это чтение; оно не начинает и не подтверждает попытку.

Доверенный Telegram плагин проверяет личный чат владельца, сохраняет случайный одноразовый callback token и вызывает `actions.prepare` до показа кнопки. Pending запись связывает token с точными moveId, attemptId, revisionId и stage. На click плагин атомарно поглощает token, сверяет private owner и передаёт точные связанные поля в private `actions.complete`. Данные решения формирует callback, а не текст модели. Обычный MCP ограничивает executor_kind до agent; перед complete/fail дополнительно читает graph и отклоняет human Action.

Доверие private RPC основано на вызывающем runtime. Само отсутствие метода в MCP не изолирует private CLI от terminal инструмента, работающего тем же Unix пользователем и читающего ту же конфигурацию. Для такой угрозы развёртывание должно отдельно ограничить shell и доступ к human credentials; секрет в доступном модели окружении не создаёт эту границу.

Private `actions.complete` проверяет текущую попытку, human, running и revision. Game-core атомарно проверяет статус попытки и актуальную planning revision, задаёт `confirmed_by` владельцу и сохраняет результат. Для review/final проверка revision в мосте является предварительной: текущий owner API не даёт общего атомарного CAS. Это известная граница, а не обещание блокировки параллельного редактирования.

Отмена и TTL используют private `actions.cancel`: только та же текущая human/running попытка завершается через owner fail с `HUMAN_EXPIRED`, `HUMAN_CANCELLED` или `HUMAN_DECLINED`; Move снова planned. Новая revision не препятствует уборке старой попытки. Telegram плагин завершает истёкшие pending по native таймеру и сверяет их после перезапуска; повтор callback не создаёт новую попытку. Решения changes/cancelled через complete также завершают human attempt. Неизвестный исход сохраняется как unknown; он не выдаётся за отказ или успешное решение.

## Private stdio RPC

`trusted.mjs` использует JSON-RPC 2.0, UTF-8, один JSON документ на строку. Поддерживаются batch и notifications, строковый id рекомендуется. stdout содержит только ответы, stderr — безопасный код диагностики. Метод не принимает owner identity. Машинный контракт — [trusted.openrpc.json](trusted.openrpc.json).

| Метод | Вход |
| --- | --- |
| `files.publish` | `{path,requestId,title?}` по publisher контракту; requestId 1–256, файл до 2 GiB. |
| `files.fetch` | `{artifactId}`; возвращает проверенную копию владельца. |
| `actions.read` | `{moveId}`; текущие target/revision, move status, attemptId/status/executor, title/description, inputResourceIds. |
| `actions.prepare` | `{moveId,revisionId,idempotencyKey,inputResourceIds?}`; ключ 1–200; возвращает связанную human attempt и currentRevisionId. Если inputs не заданы, берёт текущие разрешённые owner API inputs. При claimed восстанавливает только точную текущую running попытку прежнего ключа, даже если revision уже сменилась; такой recovery используется для отмены после перезапуска. |
| `actions.complete` | `{moveId,attemptId,revisionId,stage,decision,comment?}`; stage planning/final/review, decision approved/success/changes/cancelled. |
| `actions.cancel` | `{moveId,attemptId,revisionId,reason}`; reason expired/cancelled/declined. |

Files ответ — `{artifactId,filename,mimeType,sizeBytes,sha256,localPath,markdown}`. Markdown publisher сохраняется без изменения. Telegram распознаёт только настроенный resultRoot/UUID путь, повторно вызывает fetch и отправляет проверенные bytes нативным API.

RPC строка до 65536 байт проверяется до parse; oversized или неполная строка закрывает канал. Ответ до 1 MiB; превышение закрывает канал без усечения. Запросы идут последовательно с обратным давлением stdin/stdout. Разрыв/timeout не отменяет уже возможный эффект. Standard errors: -32700/-32600/-32601/-32602; owner failures — -32000 с безопасным `{code}`. Повтор после unknown применяется только по контракту владельца.

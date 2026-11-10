# MemOS REST

Подключает штатный MemoryProvider к существующему MemOS; кубы не создаёт, deployment/БД/модели не меняет. Без routing_enabled старый JSON остаётся legacy. Живые настройки — HERMES_HOME/memos-rest.json, каталог — memos-catalog.json.

| Настройка/диагностика | Читать |
|---|---|
| Multi-cube, каталог, epoch/phase, writer/router/bridge | [Запись и маршрутизация](docs/routing.md) |
| Recall/tools, Telegram Business/приватность | [Чтение и доступ](docs/privacy.md) |
| Admin purge/handoff, границы, проверки/ограничения | [Администрирование](docs/admin.md) |

Неразрушительное обслуживание привязано к user_id и scope_profile живого профиля, а также полному набору managed cubes. Прежние purge/handoff остаются только default/root. Отдельный handoff-empty передаёт строго пустую frozen область в production без удаления и разблокировки массовой очистки. frozen/disabled/suspended/epoch и backend-права проверяй отдельно. Создание куба/конфигурация/HTTP 200 не доказывают реальную доставку, recall или очищение. Документация не разрешает очистку/разблокировку; действует MEMORY_POLICY.md. Секреты/переписку в комплект не копируй.

### Контракт checkpoint v1

Checkpoint сохраняет исходный разговор в `main` и подтверждается только после полного read-back. Он не участвует в извлечении фактов. Роль `user` не доказывает личность говорящего: новый provider передаёт `hermes_author_id=multiple_or_unknown`, такое же `hermes_source_author_id` и объект `hermes_checkpoint`:

```json
{
  "version": 1,
  "authors": [
    {"message_index": 0, "role": "user", "author_id": null},
    {"message_index": 1, "role": "assistant", "author_id": null}
  ],
  "origin": {"session_id": "source-session", "platform": "telegram"}
}
```

`authors` содержит ровно один элемент на каждое исходное сообщение `hermes_messages`, по порядку. Все `author_id` остаются `null`; исходные транспортные обёртки и `hermes_context` сохраняются как свидетельства, без новых полномочий. Версия должна быть целым числом `1`. Неизвестная версия или попытка задать подтверждённого автора дают отказ.

Доверенный Unix-шлюз фиксирует `hermes_owner_id` и `hermes_profile_id` из проверенного peer UID. В физической записи `hermes_author_id` остаётся owner scope существующего индекса; исходная атрибуция хранится отдельно в `hermes_source_author_id`. При чтении шлюз сначала проверяет owner/profile/home/epoch/physical cubes и только затем возвращает исходный author для совместимого read-back. Это правило действует только для checkpoint. Чужой owner/profile или конкретный чужой author отвергается. Legacy checkpoint с `multiple_or_unknown` или `unknown` получает v1 на этой границе; payload и event ID очереди сохраняются. Чтение прежних owner-scoped записей без новых полей остаётся совместимым.

Длинный архив доставляется по частям. `memory_parts` сохраняет только состояние доставки и подтверждённые IDs; тело части восстанавливается из исходного `body` при вызове. Прежние копии `memory_parts[].body` удаляются из служебного журнала без изменения источника и IDs. Read-back отдельной части ограничивается её `hermes_chunk_index`; перед квитанцией клиент по-прежнему читает полное событие и проверяет все ожидаемые IDs. Потерянный ответ восстанавливается по event ID и номеру части, без повторного добавления уже записанных данных.

### Ошибки и восстановление очереди

Временный отказ сохраняется в `pending` с задержкой повторной попытки. HTTP/API 4xx, кроме 408/409/425/429, считаются постоянными по структурированному коду; текст ошибки не используется для классификации. Постоянный отказ сохраняет полное событие, attempts, last_error и failed_at в закрытом каталоге `failed`, без автоматических повторов. `memos_status` показывает `pending`, `failed` и `verified_events` отдельно; failed не означает сохранённую память.

Независимые append-turn, business_message и checkpoint могут обойти неготовое или failed событие. Correction/delete и другие зависимые операции сохраняют барьер порядка, в том числе после постоянного отказа. Freeze, suspend, epoch, generation и session fencing продолжают проверяться перед записью. Failed не удаляется автоматически.

`Admin.repair_checkpoint_queue(scope, event_hashes, apply=False)` готовит проверку точной очереди без изменения её файлов. `scope` явно задаёт профиль, owner и все managed cubes; `event_hashes` отображает все pending event ID в SHA-256 исходных bytes. Требуется frozen профиль. Только явный `apply=True` сохраняет точные originals и manifest в `memos-rest/queue-repair-v1/<plan_id>/`, затем сбрасывает `next_attempt` и добавляет provenance. Текст, body, event ID, частичные подтверждения, attempts и epoch не меняются. Повтор того же manifest, включая продолжение после прерывания, не создаёт новую операцию. Изменение очереди или scope/epoch/hash даёт отказ.

После штатного resume writer восстанавливает имеющиеся части по event ID и проверяет каждое событие чтением. Приёмка требует квитанции всех исходных event ID, отсутствия pending/failed и отсутствия новых дубликатов при повторном проходе. Repair не возобновляет профиль и не выполняет доставку. Тест `identity/tests/test_memory_checkpoint_integration.py` проверяет этот переход на шести синтетических pending с двумя checkpoint и четырьмя turn, включая attempts=464, exact-byte backup, read-back и повтор без дублей. На настоящем профиле операцию автоматически не выполняют.


### Поиск по индексу

Multi-cube recall согласует `recall_index: 1` с MemOS и выполняет один поиск по всем выбранным кубам. PostgreSQL объединяет точные смысловые совпадения всех частей и текстовые совпадения полного разговора, возвращая один экземпляр логического источника. Модель проверяет только найденные кандидаты, факты и оригиналы за один проход. Старый backend сохраняет совместимый полный путь; неисправный объявленный индекс даёт явную ошибку. Оригиналы памяти не удаляются. Подробный контракт и операторская подготовка — [интеграции MemOS](../../../memos/README.md#индексный-recall).

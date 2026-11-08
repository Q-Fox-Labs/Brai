# Локальный REST API MemOS

## Личный Unix gateway

В `BRAI_IDENTITY_MODE=worker` helper читает root-owned конфигурацию `$HERMES_HOME/memos-rest.json`, сверяет её `user_id` с `BRAI_IDENTITY_USER_ID` и использует только `/run/brai-profile/memory.sock`. Авторитетная граница доступа — SO_PEERCRED и актуальный Auth на gateway; локальная сверка конфигурации дополняет её. Переопределение HTTP endpoint и чужого user запрещено. `--cube` означает логический куб; gateway проверяет его по каталогу профиля. Физические кубы и общие credentials не передаются.

Поиск использует `/product/recall_index`, проверенные scope/epoch/author и полноту ответа SDK; `--top-k` ограничивает показ с явными `returned_count` и `truncated`. `list/get` читают проверенный versioned stream; страницы формируются после полной проверки, без передачи неподдержанных page/include полей backend. `add/delete` проходят существующие owner-операции gateway; frozen-конфиг запрещает запись. Запись после неизвестного исхода не повторяется автоматически.

Личный `status` получает только scheduler status своего Auth user: GET `/product/scheduler/status`, необязательный `--task-id`. Чужой user и глобальные очереди запрещены; ответ ограничен 256 КиБ, превышение даёт явную ошибку без усечения. Это отдельная диагностика, не native `memos_status` с локальным outbox и health. Старый `/product/search` в личном gateway недоступен: поиск использует scoped recall index. `/product/feedback` поддержан для явных собственных IDs через обязательную backend-границу targets/home/epoch/author/visibility; общий HTTP endpoint не используется. Остальная REST-справка ниже относится к прежнему однопользовательскому транспорту и не расширяет API личного gateway.

Фактическая схема: ${MEMOS_API_URL}/openapi.json. Для нового payload перечитай её: публичные старые примеры могут содержать deprecated поля. Клиент scripts/memos_client.py покрывает только простой безопасный subset; не выдавай его defaults за defaults провайдера.

## Search — POST /product/search
Обязательные query/user_id; для контролируемой области всегда readable_cube_ids=[...].
- mode=fast|fine|mixture; top_k>=1; relativity>=0 (0 отключает порог).
- rerank; dedup=no|sim|mmr; filter с and/or/сравнениями.
- include_preference, search_tool_memory, include_skill_memory и отдельные *_top_k управляют дополнительными корзинами.
- search_memory_type выбирает категорию (All, WorkingMemory, LongTermMemory, UserMemory, OuterMemory, ToolSchemaMemory, ToolTrajectoryMemory, RawFileMemory, AllSummaryMemory, SkillMemory, PreferenceMemory по текущему description).
- session_id — мягкий сигнал ранжирования, НЕ hard privacy filter.
- reference_time полезен для временного запроса; neighbor_discovery для соседних chunks; internet_search по умолчанию false, не включать без нужды/согласованного доступа.

Пример ручного диагностического payload:
```json
{"user_id":"root","readable_cube_ids":["main"],"query":"актуальный факт","mode":"fast","top_k":5,"relativity":0,"rerank":false,"dedup":"no","include_preference":false,"search_tool_memory":false,"include_skill_memory":false,"internet_search":false,"chat_history":[]}
```
Это явно permissive recall для расследования; production threshold определяет провайдер. Результат: data.text_mem/pref_mem/tool_mem/skill_mem с группами по cube_id, список memories; act_mem/para_mem могут быть пустыми. Выделяй id/memory/metadata, дедуплицируй.

## Add — POST /product/add
Практически всегда задавай user_id, writable_cube_ids, messages, session_id, async_mode; текущий JSON Schema не помечает required, но это не разрешает бессодержательную/не scoped запись.
- messages допускает строку или role/content сообщения, в том числе поддерживаемые multipart/tool варианты; допустимую форму бери из схемы.
- async_mode=sync|async; серверный default async. mode=fast|fine применяется для sync; нельзя считать его универсальным переключателем async-обработки.
- info и custom_tags — provenance/проекты/авторы; task_id для корреляции задач.
- chat_history=[] явно исключает наследование внутренней истории; для extraction с контекстом передай нужную history, не пустую автоматически.
- is_upload_skill — специализированная загрузка пакета, не обычная запись любой инструкции. Не включай произвольно.
- Deprecated memory_content/mem_cube_id/doc_path/source не предпочитать новым полям.

```json
{"user_id":"root","writable_cube_ids":["main"],"session_id":"точная-сессия","async_mode":"sync","mode":"fast","messages":[{"role":"user","content":"Подтверждённый факт; источник ..."}],"chat_history":[],"info":{"source_type":"manual","speaker":"автор"}}
```
Пример — не команда записать это автоматически. code=200 требует read-back ID; async также task completion.

## Read/list — POST /product/get_memory
mem_cube_id обязателен; user_id; include_preference/include_tool_memory/include_skill_memory; filter; page начиная с 1, page_size. Без pagination возможен полный экспорт.
Scoped ID read: {"mem_cube_id":"main","user_id":"root","filter":{"id":"UUID"}}. В этой установке один ID может попадать в несколько корзин; не считать это разными записями.
GET /product/get_memory/{memory_id} и POST /product/get_memory_by_ids (массив ID) существуют, но без явной области куба; предпочтителен scoped read.
/product/get_all принимает user_id, memory_type=text_mem|act_mem|param_mem|para_mem, mem_cube_ids, optional search_query/search_type. /product/get_memory_dashboard имеет pagination; выбирай минимальную область, не полный экспорт в чат.

## Feedback — POST /product/feedback
В личном worker: `python scripts/memos_client.py feedback --id MEMORY_ID --text "Исправленный факт" --session SESSION`. Допускаются 1–32 уникальных ID из одного логического куба, только sync mode и corrected_answer=false; owner и область принудительно определяет Root. Нельзя менять frozen/suspended память, чужого автора/эпоху или business_private записи. Обычные canonical fast facts поддержаны; original native LLM judgement/semantic update сохраняются. HTTP 200 с пустым record означает отсутствие принятой коррекции, а не доказательство изменения.

Root проверяет все targets до модели, а затем перечитывает новые/изменённые/удалённые IDs. Backend возвращает 409 для недоступного target/недопустимой ветки, 429 при занятой очереди feedback, 503 для storage/deadline/readback/FEEDBACK_OUTCOME_UNKNOWN. Составные chunked facts (FEEDBACK_CHUNKED_FACT_UNSUPPORTED), внешние связи (FEEDBACK_EXTERNAL_EDGE_UNSUPPORTED), version/reorganization/rawfile и неизвестные bulk-порты отклоняются до изменения данных. При неизвестном исходе не повторяй запрос: сначала прочитай точные исходные/new IDs и тематический recall. Если текст стал многочастным, используй отдельную проверенную процедуру add/read-back/delete, не обходи отказ feedback.

Следующие расширенные поля относятся к прежнему однопользовательскому REST; личный gateway принимает только описанный выше closed envelope.

Обязательные user_id, history, feedback_content. Дополнительно writable_cube_ids, retrieved_memory_ids, session_id, task_id, async_mode=sync|async, corrected_answer, info, feedback_time. Для коррекции укажи точные ID и релевантный контекст; corrected_answer=false при чистом управлении памятью. Это LLM-операция, не детерминированная замена одного поля. Read-back старого/нового IDs и тематический recall обязательны; feedback ещё не испытан данным скиллом на локальных пользовательских записях.

## Delete / recovery
POST /product/delete_memory: writable_cube_ids, memory_ids; дополнительные широкие user_id/session_id/conversation_id/filter/file_ids существуют, но не применять для точечного удаления. auto_cleanup_working=false задавать явно в простом клиенте; связанную рабочую память удалять только в согласованной области.

POST /product/delete_memory_by_record_id и /product/recover_memory_by_record_id — internal по схеме; принимают mem_cube_id и record_id/delete_record_id (разные точные поля). Не придумывай ID записи операции и не обещай восстановление любого hard-delete.

## Кубы и чат
POST /product/create_cube требует cube_name/owner_id, допускает cube_id/cube_path. Не создавать без запроса: это изменение области памяти.
POST /product/register_cube в описании говорит, что полноценная регистрация требует будущей интеграции MOSCore. Успех validation не доказывает доступность куба. /product/exist_mem_cube_id ранее вернул 500 при main; это не основной health-check.
/product/chat/complete и /product/chat/stream — генерация ответа, могут добавлять диалог (add_message_on_answer); не использовать вместо read-only search. suggestions тоже не доказывает содержимое базы.

## Health и async наблюдение
GET /health → healthy/service=memos/version=1.0.1; это API version, не MemoryOS package version.
GET /product/scheduler/status?user_id=... [&task_id=...] → waiting/in_progress/completed/failed/cancelled.
GET /product/scheduler/task_queue_status?user_id=... → backlog metrics.
GET /product/scheduler/allstatus — более широкие данные; применять только при согласованной админ-диагностике.
POST /product/scheduler/wait?user_name=...&timeout_seconds=120, GET /product/scheduler/wait/stream → ожидание/SSE. user_name не следует угадывать из user_id.

Для HTTP-запросов через terminal используй urllib/request или штатный клиент, timeout и Content-Type application/json. Не запускай записывающие docs examples целиком и не повторяй POST автоматически после timeout. Различай HTTP success, code приложения, completed и реальный read-back.

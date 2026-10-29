## Recall / инструменты

Автоматический поиск MemOS ожидается до `prefetch_timeout_seconds` (по умолчанию 60 секунд, допустимо 1–300). Это бюджет ожидания, не ограничение количества результатов. Поставляемый `memory-recall.patch` передаёт этот бюджет native MemoryManager вместо его общего предела в 8 секунд. Истечение времени, незавершённый прежний поиск и ошибка сервиса дают явное уведомление «Память не прочитана» и статус ошибки для модели. Сырые исключения в уведомление не попадают. Позднее завершение не превращает ошибку текущего вопроса в успешное воспоминание; следующий вопрос может выполнить новый поиск.

Search по умолчанию рассматривает факты во всех разрешённых managed cubes. Явные `cubes` и `project` сужают область. Каждая строка локально проверяется по техническому user, cube membership, author, home scope, epoch **до передачи модели**; серверным фильтрам доверия нет. Копии объединяются по logical ID. BM25 упорядочивает весь набор, не отбрасывая кандидатов. Независимый смысловой отбор возвращает только свидетельства по вопросу, допускает нулевой результат и обязан указать дословную цитату из выбранного кандидата. Несовпадение индекса/цитаты является ошибкой чтения. Пакеты до 80 000 символов ограничивают один запрос проверяющему, а не число найденных записей. Одинаковый технический score backend не используется как доказательство релевантности.

`relevance_kind` различает прямое свидетельство и необходимый фон; `relevance_reason` объясняет выбор. Совместимое числовое поле `relevance` кодирует эти категории, а не вероятность сходства. Дата исходного события передаётся отдельно от даты новой копии после переноса. Кэш привязан к автору и live config/catalog и повторно проверяется перед выдачей. Архив не входит в обычную выдачу фактов; исходник доступен по ID.

- `memos_search(query, top_k?, project?, cubes?)` — semantic multi-cube recall.
- Явный поиск не имеет потолка 6/20: `top_k: 1000` допустим, без `top_k` возвращаются все релевантные разрешённые результаты. Порог релевантности и права автора сохраняются. Кандидаты выбираются до локальной фильтрации автора и дедупликации без фиксированного ограничения 20 на куб.
- Обычный поиск возвращает только извлечённые факты. `include_archive: true` явно включает исходную переписку, в том числе материал без полезных фактов и ещё не обработанные сообщения. `memos_read` продолжает читать исходники по ID.
- Автоматический поиск не имеет ограничения числа записей; устаревший `top_k` профиля не влияет на него. При отсутствии подходящих фактов или необходимости прежнего отчёта поиск включает исходный архив. Служебное уведомление явно разделяет «найдено N; передано M», в том числе при нуле. Ошибка не превращается в пустой успешный поиск.
- `context_chars: 0` (по умолчанию) включает бюджет по текущей модели: 5% её окна, не больше свободного места после оценки текущего запроса и резерва 10% окна под ответ. Native передаёт окно и свободное место в `on_turn_start`; оценка токенов использует штатный Hermes estimator. При неизвестном окне применяется явный резервный бюджет 4096 оценочных токенов. Положительный `context_chars` остаётся дополнительным явно заданным ограничением совместимости. Фиксированного значения 6000 по умолчанию нет.
- Факты и источники передаются целиком, если помещаются. Длинная выдержка явно помечается; полный источник читается `memos_read(include_transcript=true)`. Остальные записи остаются доступны поиску. Native не применяет к уже распределённому бюджету MemOS повторное скрытое усечение общего plugin spillover. Для прежнего отчёта или его пронумерованных разделов агент обязан прочитать источник.
- `top_k` — верхняя граница выдачи, не требование набрать указанное число.
  Его величина не расширяет явно заданную область: `all_cubes: true` включает
  все разрешённые кубы, отменяя явное сужение `cubes`.
  Перед просьбой повторить старые сведения агент должен поискать память,
  при необходимости расширить поиск и проверить исходную переписку.
  У хранилища нет лимита 6/20/1000 воспоминаний. Для поиска адаптер пропускает
  кубы без доступных результатов, а независимые факты объединяет по logical ID.
  Семантическое MMR-удаление похожих записей до проверки автора отключено:
  оно дорого для полного архива и может скрыть разные факты с похожим текстом.
- `memos_remember(content, project?, operation_id?, shared_infra?)` — durable архив+извлечение; stable operation ID предотвращает повтор, изменение payload с тем же ID отвергается.
- `memos_read(memory_id, include_transcript?)` — physical либо logical ID во всех разрешённых кубах.
- `memos_forget(memory_id)` — durable удаление всех копий логического факта; `pending` до проверенного удаления, повтор возвращает `deleted`.
- `memos_replace(memory_id, content, operation_id?)` — явная коррекция **одного** grounded факта, сохраняет logical ID и согласованно меняет memberships.
- `memos_status()` — live phase/epoch/frozen/generation и outbox/service status.

Native `on_memory_write` add/replace/remove поддерживается; разрушительные операции требуют точного `previous_content`. Shared infra требует одновременно разрешения каталога и явного `shared_infra: true`; доступ других авторов только read-only к infra-копии. Shared transcript содержит только grounded quote, не личный оригинал/контекст.

Автор callback относится к его входящему сообщению. Дополнительные сообщения
внутри хода сверяются с native transcript и журналом транспорта Telegram в той
же теме: по номеру сообщения либо однозначному точному совпадению текста.
Имя в тексте и создатель темы не подтверждают автора. Неподтверждённые фрагменты
не получают автора соседнего сообщения.

Закрытие сессии только дожидается очереди сохранённых ходов, без повторного
импорта истории. Checkpoint со смешанными авторами и архив с `unknown` сохраняют
исходную переписку, но не создают персональные факты. Исправление старого
авторства требует отдельной проверки источников.

Schemas/инструкция выбираются при создании provider/session и не меняются посреди сессии. Переход legacy→multi-cube в существующей сессии блокирует небезопасные старые инструменты до новой сессии.

## Telegram Business privacy boundary

`business.py` archives recipient-private observations through the existing guarded routed Outbox, not a second lifecycle writer. Scope includes profile, owner/account, Telegram connection, chat and recipient; metadata, actor/origin/status and source identity survive taxonomy copies. Generic routed `allowed()` and legacy Client search/read exclude `business_private`/business-scoped rows by default, including exact-ID reads, corrections and forgetting from other paths. Internal raw scoped get remains available to delivery verification and explicitly authorized administration.

Customer recall uses scope-qualified bounded listings, never broad root semantic retrieval: three 100-row pages per cube and a four-second overall budget. Every result must match user, cube/membership, profile, epoch, full recipient scope/session, actor/status and a current Telegram SQLite source revision/author/quote. Source quotes, not unchecked backend paraphrases, reach the drafting model. This protects against cross-owner/chat records, mismatched responses and stale edited/deleted sources, but deliberately does not promise exhaustive recall when the backend ignores filters.

The feature verification runner executes 57 Telegram tests plus 37 MemOS tests. Separate real synthetic probes verified six copies per run across `main`, `life_intellect` and (in one run) `user`, isolated recall, generic exact-ID denial, real host completion and exact-ID cleanup with read-back; Telegram sends were zero. Existing pending production jobs were not flushed by those probes. Source edits are not proof that already-created gateway provider objects have refreshed: activate both integrations only after independent review.


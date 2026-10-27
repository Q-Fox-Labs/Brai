## Recall / инструменты

Search выбирает initial spheres/project через LLM и при недостатке расширяет **только разрешённые managed cubes**. Каждая строка локально проверяется по техническому user, cube membership, author, home scope, epoch; серверным фильтрам доверия нет. Результаты дедуплицируются по logical ID. Кэш привязан к автору и live config/catalog и повторно проверяется перед выдачей. Classified originals исключены из обычного recall, исходник остаётся доступен по ID.

- `memos_search(query, top_k?, project?, cubes?)` — semantic multi-cube recall.
- `memos_remember(content, project?, operation_id?, shared_infra?)` — durable архив+извлечение; stable operation ID предотвращает повтор, изменение payload с тем же ID отвергается.
- `memos_read(memory_id, include_transcript?)` — physical либо logical ID во всех разрешённых кубах.
- `memos_forget(memory_id)` — durable удаление всех копий логического факта; `pending` до проверенного удаления, повтор возвращает `deleted`.
- `memos_replace(memory_id, content, operation_id?)` — явная коррекция **одного** grounded факта, сохраняет logical ID и согласованно меняет memberships.
- `memos_status()` — live phase/epoch/frozen/generation и outbox/service status.

Native `on_memory_write` add/replace/remove поддерживается; разрушительные операции требуют точного `previous_content`. Shared infra требует одновременно разрешения каталога и явного `shared_infra: true`; доступ других авторов только read-only к infra-копии. Shared transcript содержит только grounded quote, не личный оригинал/контекст.

Schemas/инструкция выбираются при создании provider/session и не меняются посреди сессии. Переход legacy→multi-cube в существующей сессии блокирует небезопасные старые инструменты до новой сессии.

## Telegram Business privacy boundary

`business.py` archives recipient-private observations through the existing guarded routed Outbox, not a second lifecycle writer. Scope includes profile, owner/account, Telegram connection, chat and recipient; metadata, actor/origin/status and source identity survive taxonomy copies. Generic routed `allowed()` and legacy Client search/read exclude `business_private`/business-scoped rows by default, including exact-ID reads, corrections and forgetting from other paths. Internal raw scoped get remains available to delivery verification and explicitly authorized administration.

Customer recall uses scope-qualified bounded listings, never broad root semantic retrieval: three 100-row pages per cube and a four-second overall budget. Every result must match user, cube/membership, profile, epoch, full recipient scope/session, actor/status and a current Telegram SQLite source revision/author/quote. Source quotes, not unchecked backend paraphrases, reach the drafting model. This protects against cross-owner/chat records, mismatched responses and stale edited/deleted sources, but deliberately does not promise exhaustive recall when the backend ignores filters.

The feature verification runner executes 57 Telegram tests plus 37 MemOS tests. Separate real synthetic probes verified six copies per run across `main`, `life_intellect` and (in one run) `user`, isolated recall, generic exact-ID denial, real host completion and exact-ID cleanup with read-back; Telegram sends were zero. Existing pending production jobs were not flushed by those probes. Source edits are not proof that already-created gateway provider objects have refreshed: activate both integrations only after independent review.


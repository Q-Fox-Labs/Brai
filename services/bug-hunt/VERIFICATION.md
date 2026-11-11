# Проверка наблюдений v3

Расследование сохраняет собственные snapshots, intents, evidence и неизменяемые
результаты. Исходные ответы v1/v2 и verification_status=unverified сохраняют
прежний смысл. Вывод v3 читается отдельно и не означает исправление программы.

## Допуск и вывод

Поступление report не вызывает модель. Планировщик допускает максимум пять
расследований раз в шесть часов. Первый tick — через шесть часов; после простоя
нет цикла догоняющих запусков. Ручной run-request выбирает свою case/group либо
bounded pending порцию и не переносит расписание. Пустая порция — no_work без
модели. Повтор request_id с тем же входом возвращает сохранённую квитанцию.

Admission закрепляет installation/owner, report/case IDs и hashes, revision и
состав группы, policy/config revision и executor. Новые участники группы не
наследуют прежний вывод. Для source нужен известный Git commit всех наблюдений
snapshot и разрешённый registry. Сходство и классификация v2 — подсказки.

Состояние выполнения отделено от defect_verdict. confirmed доказывает
расхождение с требованием в проверенной версии. refuted опровергает конкретное
предположение при проверенных условиях. not_reproduced сам по себе не означает
refuted. insufficient_evidence перечисляет недостающие сведения. Ошибка
инфраструктуры может завершить попытку без verdict.

## Исполнители и источники

Единственный verification.executor выбирает codex_app_server либо providers.
По умолчанию используется существующий авторизованный серверный Codex:
новые аккаунты, профили авторизации, login и копирование auth.json не нужны.
Запись native endpoint содержит только адрес, generation и qualification.
Нельзя переносить credentials или пользовательский HOME в runner/evidence.

Для своих native threads адаптер задаёт read-only, approvalPolicy=never,
отключает shell, patch, web, MCP, apps/plugins, skills, subagents и остальные
встроенные инструменты. Разрешены только переданные dynamic tools. До dispatch
обязательна квалификация установленного протокола и технических ограничений.
Проверяется эффективный sandbox ответа thread/start. Неизвестный native item
или запрос прерывает только свой turn.

Resolver выбирает последнюю стабильную canonical Sol численно из реального
каталога, обязательно с high. Preview, другая семья и снижение effort не
являются fallback. Модель и catalog revision закреплены для investigator и
reviewer; у них разные собственные threads и общий бюджет.
Providers использует публичный @brai/providers chat/get/cancel и caller-owned
continuation. Actual model сверяется с выбранной; unprepared profile закрыт.
Недоступность Codex не вызывает автоматического расхода Providers.

Отсутствующий verification выключает dispatch. Невалидный reload сохраняет
последнюю пригодную policy целиком. Начатая работа сохраняет executor/profile
revision. Текущие pause, owner status и внешнее разрешение проверяются перед
новым эффектом. В модель идёт техническая проекция разрешённого owner.

Общие tools: evidence_list/read, source_read, case_related,
reproduction_run/get. Reviewer не получает reproduction_run. Нет shell, URL
fetch, редактирования, Git/Codeworks или произвольного argv.
SourceReader читает разрешённые immutable Git blobs с commit/path/lines/full
blob hash. Секретные, скрытые пути и symlinks запрещены. Artifact bytes
автоматически не читаются: без разрешённых текстовых данных вывод ограничивает
область или воздерживается.

## Runner и проверка

Runner — отдельная программа с приватным Unix JSON-RPC. prepare,
start/get/cancel/collect/cleanup используют scope и execution_id.
Оператор принимает recipes; модель выбирает только spec_ref. Предусмотрены
DTO, regression и transport/lifecycle synthetic recipes. Generated scripts,
команды, mounts и URL из observation не исполняются.

Bwrap создаёт отдельные namespaces без сети. Read-only mounts содержат source,
harness, Node/dependencies и synthetic input; HOME и credentials отсутствуют.
Ограничены время, память Node, процессы, файлы, stdout/stderr и tmpfs.
Hashes harness, source_file и fixture сверяются до запуска; fixture обязана
ссылаться на тот же source_file. Oracle закреплён отдельно по requirement,
а не вычисляется проверяемой функцией.

Intent сохраняется до запуска, terminal receipt — после физического завершения
с outcome, assertions, commit, hashes, substituted boundaries и cleanup.
Таймаут start читается get того же ID. Неясный запуск после restart остаётся
unknown и не запускается заново. Tombstones сохраняются.

ResultValidator сверяет отдельный review/candidate hash, owner/installation,
hashes и availability evidence, provenance требования и source, сохранённый
receipt, независимый oracle и cleanup. confirmed/refuted без пакета не
публикуются. Статическое доказательство из текста LLM не поддержано.
Refuted требует также точного claim из принятого oracle.refutes_claim.
Ручной review хранится отдельно и имеет приоритет над поздним автоматом.

## Устойчивость и эксплуатация

PostgreSQL хранит admission/mutation receipts, snapshot, effects/checkpoints,
резервы бюджета, результаты и schedule. Runtime grants не дают менять или
удалять originals/evidence/results/ручной audit. Все связи scoped по owner и
installation. HMAC cursor связан с областью запроса.

Отдельный Temporal worker использует короткие Activities, durable ожидания и
ContinueAsNew. History содержит IDs и безопасные статусы. Session advisory lock
и fence исключают конкурирующую работу. Время durable ожидания не расходует
бюджет активной обработки. Ограничены вызовы модели, tools, runner, pending и
derivative storage; неизвестный расход не возвращается в бюджет.

Cancel блокирует новые действия и останавливает только свои native turns и
живые runner handles. Потеря thread/start или turn/start ACK не создаёт второй
start: проверяется сохранённое binding, иначе outcome_unknown. Потерянный
Providers reply восстанавливается get того же operationId. Pending native tool
после разрыва может потребовать операторской сверки: числовой request ID
не переносится на новое соединение.

Backup включает всю БД, protected config/cursor key, runner intents/receipts,
native bindings/state и согласованную Temporal history. Restore одной БД не
восстанавливает native state и историю Temporal. Их отсутствие не разрешает
слепой новый model/run start. Откат выключает admission/dispatch, сохраняет
таблицы и совместимый worker для незавершённых историй.

## Контракты и приёмка

NATS: asyncapi-v3.json; входы/model DTO: schemas/verification-v3.schema.json;
приватный runner: runner.openrpc.json. Public MCP/Hermes имеют run/get/list/
evidence. Web cancel/review требуют текущей сессии; review — reviewer.
Pause/status закрыты operator ACL.

Обычные проверки: test:bug-hunt, typecheck:web, Hermes identity tests.
Явные integration tests: verification-store.test.mjs (своя PostgreSQL fixture),
verification-temporal.mjs (своя очередь Temporal), verification-flow.mjs
(настоящие Codex investigator/reviewer и runner на synthetic данных).
native-live-qualification.mjs проверяет существующую авторизацию и отключение
встроенных tools на своём bounded thread. Нельзя направлять эти проверки на
рабочие обращения. Сборка и unit tests не заменяют сквозной model/runner flow.

## Проверенная native граница и токены

Исследовательский thread создаётся с environments=[]: native executor
отсутствует. В установленном протоколе patch/exec/view требуют этот executor
до чтения файла. Read-only и отключённые flags дополняют эту границу.
Configured MCP servers и plugin registrations выключены request-local;
перед turn/start обязательна полная scoped проверка: все runtimeStatus
своего thread должны быть disabled. Неизвестный статус или неполная страница
запрещают dispatch. Проверка привязана к server/schema generation, policy
no-environment-scoped-tools-v2 и конкретным qualified model IDs.
Существующий account/daemon используются без новых профилей и login.

Дифференциальная canary qualification проверяет native shell и patch-read:
negative без environments не получает bytes, positive с default environment
того же daemon/account читает тот же synthetic файл. Недоступный positive
делает тест непригодным; отсутствие bytes само по себе не считается успехом.

По уточнению владельца hard per-response token cap не является условием
допуска Codex. Ограничены вызовы и активное время. Native tokens — фактический
monotonic учёт по уведомлениям, с явным unknown при отсутствии usage;
повтор checkpoint не увеличивает расход второй раз. Это не жёсткий лимит
текущего ответа. Ограничения filesystem/executor/MCP при этом сохраняются.

### Восстановление и ограничения текущего native API

90 секунд — предел отдельного вызова модели (нового native turn или Providers operationId), а не всей фазы исследователя. Продолжение Providers получает новый ID, отдельный резерв и deadline в пределах оставшегося активного времени попытки. GET прежнего operationId не меняет сохранённый body/deadline. Durable ожидание вне Activity не расходует 15 минут; чистые dependency/owner probes также исключены.

Codex 0.166.0 может регистрировать resource builtins из metadata CodeModeOnly даже при выключенных MCP. Request-local config не делает registry исключительным. Доступ блокируют `environments:[]` и фактический scoped MCP inventory; любой неожиданный item прерывает только свой turn и не публикует вывод. После restart сохранённый `call_deadline_at` вызывает interrupt просроченного turn; потерянный interrupt ACK остаётся unknown до наблюдения terminal состояния. Подмена endpoint, авторизация и новые профили не выполняются.

Публичный get возвращает ссылки и хеши snapshot без исходного observation; оригиналы остаются в v1 и внутреннем immutable snapshot. Ручные решения читаются по 10: `next_review_revision` передаётся как `review_before_revision`. Фактическая native usage списывается монотонно и транзакционно один раз; Providers сохраняет usage каждого operationId.

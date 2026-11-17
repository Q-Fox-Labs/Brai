# Проверка наблюдений v3

Расследование сохраняет snapshots, intents, evidence и неизменяемые результаты.
Исходные ответы v1/v2 и `verification_status=unverified` сохраняют прежний смысл.
Вывод v3 читается отдельно и не означает исправление программы. Наличие этого
кода не подтверждает установку или приёмку на целевом сервере.

## Допуск и вывод

Поступление report модель не вызывает. Планировщик допускает максимум пять
расследований раз в шесть часов; первый tick — через шесть часов, без догоняющих
запусков после простоя. Ручной run-request выбирает свою case/group либо pending
порцию и не переносит расписание. Пустая порция возвращает no_work без модели.
Повтор request_id с тем же входом возвращает сохранённую квитанцию.

Admission закрепляет installation/owner, report/case IDs и hashes, revision,
состав группы, policy/config revision и executor. Новые участники группы не
наследуют прежний вывод. Для source нужны известный Git commit всех наблюдений
snapshot и разрешённый registry. Сходство и классификация v2 — только подсказки.

Состояние выполнения отделено от defect_verdict. `confirmed` доказывает
расхождение с требованием в проверенной версии и условиях. `refuted` опровергает
конкретный claim в проверенных условиях. `not_reproduced` сам по себе не означает
refuted. `insufficient_evidence` перечисляет недостающие сведения; ошибка
инфраструктуры может завершить попытку без вердикта. Ручное решение хранится
отдельно и имеет приоритет над поздним автоматическим выводом.

## Исполнитель и авторизация

`verification.executor` явно выбирает `codex_app_server` либо `providers`.
Основной native путь — отдельный приватный процесс Codex app-server со stdio
RPC, собственным HOME/state и закрытым launcher. Он использует одну существующую
авторизацию через [credential helper](owner-rpc/README.md), а не общий daemon
разработчика. Новые login, OAuth profiles и копия auth.json не создаются.
Ядро Hermes и его egress не меняются. Runner не получает owner HOME или bearer.

Root принимает source/producer и программы, готовит namespace и закрытые inputs,
создаёт private UDS listener и запускает helper под существующим owner UID/GID.
SO_PEERCRED допускает только заданный worker UID. Отдельный native не видит owner
DATA; auth.command получает только access в памяти через проверенный client.
Endpoint закреплён: `https://chatgpt.com/backend-api/codex`. Модель не выбирает
путь, команду, socket, account или endpoint. Полный [credential RPC](owner-rpc/openrpc.json)
принадлежит helper; его state сохраняет только fingerprints и metadata.

До новой фазы preflight разрешает credential и получает авторитетный каталог
через то же подключение. Выбирается последняя стабильная canonical Sol численно,
обязательно с high. Preview, другая семья, alias и снижение effort не служат
fallback. В startup metadata меняется только `tool_mode` выбранной модели на
`direct`; остальные модели, окна и поля каталога сохраняются. Файл проекции
передаётся native read-only. Исходная/effective catalog revisions, CLI version,
context window и фактическое effective window из usage сохраняются в checkpoint.
CLI version — metadata запроса каталога и диагностики, без version whitelist.
Фиксированные qualified model IDs и schema hash не заменяют реальную проверку.

Модель и catalog revision закреплены в расследовании; investigator и reviewer
работают в разных собственных threads. Перед стартом фазы выбранная модель
сверяется с фактическим native model/list и закреплённым intent. Смена каталога
не разрешает незаметно сменить модель уже начатого расследования.

Generation process profile обозначает сохранённый namespace native state,
а не версию CLI или поколение OAuth. Она стабильна при обычном restart/update.
Checkpoint отдельно фиксирует provider binding, sourceRef и accountId. Их fence
проверяется перед эффектами, ответом tool и в тихом ожидании. Helper меняет binding
при каждой наблюдаемой смене auth/access, включая refresh того же account: старая
фаза закрывается, новая требует свежего preflight. Авторитетного logout/login
поколения owner не предоставляет; полностью ненаблюдаемая идентичная смена
подключения не гарантированно обнаруживается. Детали — в контракте helper.

Providers использует публичный @brai/providers chat/get/cancel и caller-owned
continuation. Actual model сверяется с выбранной; unprepared profile закрыт.
Отказ Codex не переключает расход на Providers автоматически. Отсутствующий
verification выключает dispatch; невалидный reload сохраняет последнюю пригодную
policy целиком. Перед эффектами проверяются pause, активность owner и внешний
допуск. В модель передаётся только разрешённая техническая проекция.

## Инструменты и физическая граница

Thread создаётся с `environments=[]`, read-only и approvalPolicy=never.
Shell, patch, web, MCP, apps/plugins, skills, subagents и встроенные инструменты
отключены; доступен только переданный набор dynamic tools. Проверяются effective
sandbox ответа thread/start и все страницы scoped MCP inventory: неизвестный
или включённый runtimeStatus закрывает допуск. Неожиданный native item/request
останавливает только собственный turn и не публикует вывод.

Tools: evidence_list/read, source_read, case_related, reproduction_run/get.
Reviewer не получает reproduction_run. Нет произвольного shell, fetch, argv или
редактирования. SourceReader читает разрешённые immutable Git blobs с commit,
path, lines и full blob hash; скрытые/секретные пути и symlinks запрещены.
Artifact bytes автоматически не читаются. evidence_list возвращает метаданные
постранично через next_cursor/after_id; чтение по ID и validator не ограничены
первой страницей. Модели передаются manifest и ссылки, а не весь inventory.

Runner — отдельная программа с [private Unix JSON-RPC](runner.openrpc.json).
prepare/start/get/cancel/collect/cleanup используют scope и execution_id.
Модель выбирает только принятый spec_ref. Bwrap создаёт namespaces без сети;
source, harness, зависимости и synthetic input монтируются read-only. HOME и
credentials отсутствуют. Применяются принятые ограничения recipe на исполнение,
память, процессы, файлы, вывод и tmpfs. Generated scripts, URL и mounts из
observation не исполняются. Hashes source/tree/harness/fixture сверяются до запуска.

## Начальные recipes и область доказательства

[Подготовка registry](src/verification-recipes.ts) читает разрешённые Git blobs
двух конкретных commits. `reviewer-role` исполняет настоящую собранную
`natsPrincipal` и её локальные зависимости. Baseline допускает reviewer только
для admin и воспроизводит отказ активному creator; исправленная версия допускает
creator наряду с admin. Synthetic fixture заменяет Auth, идентичность и часы;
ожидание независимо следует из [контракта ролей](../auth/ROLES.md). Это проверка
прикладной identity-функции, не всей сети Auth, браузера или установки.

DTO recipes исполняют Ajv на закреплённых настоящих schemas: отсутствие title
в report v1 отклоняется; target.kind=pending в run-request v3 принимается.
Oracle закрепляет expected и точный confirms_claim/refutes_claim независимо от
проверяемой функции. Registry сохраняет source/requirement/compiler/lock и build
hashes. Общие regression/lifecycle harnesses сами по себе не дают рецепт для
любого обращения: нужны отдельно принятые fixture, source и независимый oracle.

Recipe разрешён только для совпадающих source ID/commit и **точного совпадения
четырёх полей** title/operation/expected/observed каждого case snapshot с
observation registry. Сходного заголовка, компонента или одного case группы
недостаточно. Для других наблюдений начальные recipes неприменимы; вывод должен
перечислить недостающие доказательства, а не переносить synthetic результат.

Intent сохраняется до запуска, terminal receipt — после физического завершения:
outcome, assertions, commit, hashes, substituted boundaries и cleanup. Потерянный
start ACK читается get того же ID. Unknown после restart не запускается заново;
tombstones сохраняются. ResultValidator проверяет candidate/review hash, scope,
evidence availability, provenance, сохранённый receipt, oracle и cleanup.
Confirmed/refuted без такого пакета не публикуются. Для refuted дополнительно
нужен точный claim из oracle.refutes_claim. Текст LLM не заменяет доказательство.

## Восстановление и эксплуатация

PostgreSQL хранит admission, snapshots, effects/checkpoints, бюджеты, результаты
и schedule. Runtime grants запрещают изменение originals/evidence/results/audit.
Связи scoped по owner/installation; HMAC cursor связан с областью запроса.
Temporal worker использует короткие Activities, durable ожидания и ContinueAsNew.
Process-owned проход держит PG session guard/fence и свои native связи до конца
I/O; служебный timeout Activity не отменяет этот проход и не создаёт второй loop.

Потеря thread/start или turn/start ACK сохраняет unknown: восстановление читает
собственный сохранённый thread/turn, не повторяет start. Новое соединение не
переиспользует старый числовой request ID. Потерянный tool ACK или неполное native
state могут требовать операторской сверки. Providers читает тот же operationId.
Отдельно helper сохраняет intent до возможного refresh: после неизвестного
исхода новый refresh запрещён, восстановление только read-only по новому свежему
access. Это не обещание OAuth commit или восстановления утраченного refresh token.

Cancel/stop закрывает новые действия и останавливает только подтверждённые свои
turns/runner handles. Infrastructure stop не устанавливает человеческий cancel.
WORKER_STOP_UNKNOWN остаётся unknown до сверки. Сохранённый полный результат может
быть дочитан; отсутствие подтверждённого исхода не разрешает новый inference.

По умолчанию attemptMs/deadline_at и toolCalls равны null: общего срока и счётчика
шагов нет. Явно сохранённый deadline не продлевается при recovery. Принятые бюджеты
моделей/runner/storage сохраняются; unknown расход не возвращается. Native usage
учитывается монотонно один раз и не означает hard per-response token cap.
Durable ожидание и dependency probes не расходуют активное время. Новые числовые
лимиты требуют отдельного согласования. Lifecycle/rollback/backup описаны в
[DEPLOYMENT.md](DEPLOYMENT.md); backup Bug Hunt не копирует OAuth state.

## Контракты и приёмка

[NATS](asyncapi-v3.json), [входы/model DTO](schemas/verification-v3.schema.json),
[runner RPC](runner.openrpc.json), [credential RPC](owner-rpc/openrpc.json).
Public MCP/Hermes имеют run/get/list/evidence; Web cancel/review проверяет текущую
сессию, review требует reviewer. Pause/status закрыты operator ACL.

Unit/fake проверки native, credentials и recipes подтверждают локальные контракты.
Изолированные PostgreSQL/Temporal tests проверяют persistence и workflows.
Отдельный [private native probe](runtime/qualification.mjs) проверяет настоящий
dynamic callback непредсказуемым oracle, историю и effective context; он не
запускается из health и не заменяет приёмку полного расследования.
До dispatch обязательна приёмка **фактического private process маршрута**:
Root/peer/namespace negatives, настоящий каталог и high/direct dynamic tools,
три исхода investigator→reviewer→validator, source/recipe applicability,
replay/restore/lost ACK и совместимость прежнего API. Исторический опыт на другом
native endpoint или успешная сборка эту приёмку не заменяют. Пока нет принятой
квитанции целевого состава, admission остаётся закрытым. Этот документ не
объявляет текущий DEV выпущенным или принятым.

# Codeworks: проекты, рабочие области и durable операции

Codeworks — один сервис Brai с собственной БД PostgreSQL на существующем сервере PostgreSQL. Он владеет реестром проектов, областями, правом записи, журналом операций и запросами выпуска. Game-core владеет задачами: Codeworks хранит только необязательный стабильный `element_id` области и отдельные ссылки `move_id`, `attempt_id`, `session_id` в подключениях. Одна область может пережить несколько попыток. Заголовки, статусы и планы задач не копируются; чужая БД не читается.

Машинный источник форматов — [api.schema.json](schemas/api.schema.json), JSON Schema Draft-07. Реальные NATS subjects и сообщения — [asyncapi.json](asyncapi.json), NATS Services ADR-32. MCP использует стандартный SDK и раскрывает те же owner-схемы; отдельного программного JSON-RPC API нет. Постоянные требования описаны в admin OpenSpec `contract-authoring`, `program-rpc`, `service-messaging`; продукт не читает admin во время работы.

## Сборка границ

`NATS / MCP → call → ядро domain → предметные порты storage / Git`.

`request-release → COMMIT intent → worker под flock → release → Git / GitHub → awaiting_ci → awaiting_deployment`. `release` принимает явные порты, не импортирует PostgreSQL или транспорт.

`prepare-write → COMMIT intent → worker под flock → Git branch → checkout → preparer → COMMIT ready`.

MCP stdio и локальный CLI — клиенты единственного NATS API, не отдельные экземпляры сервиса. `main.mjs` собирает PostgreSQL, ядро, NATS и восстановление. Прямой SQL находится в storage, миграции и worker; ядро не импортирует pg/NATS/MCP. Очередь — строки собственной БД, без дополнительного брокера, движка или фреймворка. Node 24.21.0 запускает исходные `.mjs`, отдельная компиляция не требуется.

## Доступ и реестр

NATS Service: `service_codeworks`, версия `1.0.0`, queue `service_codeworks`; SDK предоставляет PING/INFO/STATS. Subjects: `brai.codeworks.v1.<executor>.<method>`. Executor — удостоверенная broker ACL часть subject, а не поле запроса. Например, credentials Codex разрешают publish только `brai.codeworks.v1.codex.>`; credentials Hermes — только собственный prefix. Без этих ACL интерфейс нельзя считать удостоверенным. MCP/CLI получают собственные credentials и executor из явной конфигурации; подмена executor в payload запрещена схемой.

Runtime требует явный `CODEWORKS_ALLOWED_REPOSITORIES` — JSON-массив абсолютных repo_path. Он проверяет allowlist при регистрации, обращении к проекту и в worker. Для первого внедрения оператор разрешает только DEV/production checkout Brai; Admin в реестр и процесс Codeworks не входит.

Все операции проверяют executor по `project.executors`. Регистрацию выполняет только `CODEWORKS_ADMIN_EXECUTOR` (по умолчанию `codeworks_admin`); отдельные admin credentials не выдаются обычным исполнителям. `actor_id` необязателен и заявлен вызывающим; `operations.executor_id` всегда содержит транспортного исполнителя. Это внутренний доверенный интерфейс без пользовательского HTTP endpoint.

`project.register({project})` проверяет канонические `repo_path`, `common_dir`, существующий `workspace_root`, исполняемый файл подготовщика, Node/platform, нормализованные префиксы разрешённых и исключённых путей. Git flow: feature от `refs/remotes/origin/dev`, hotfix от `refs/remotes/origin/main`, префиксы `feature/` и `hotfix/`. При заданном `github` база сверяется с фактическим origin через ls-remote; устаревший локальный remote ref отвергается. Обновление remote refs перед подготовкой остаётся обязанностью оператора. Запасной переход на main запрещён. Hotfix дополнительно требует доверенное подтверждение установленного PROD на этом exact main SHA. Без подтверждения подготовка запрещена. Promotion использует `kind:promotion, commit_sha, evidence_id`: историческое доверенное подтверждение проверенного DEV должно точно соответствовать SHA и оставаться предком origin/dev. Последующая версия dev не подменяет выбранную базу. Ветка promotion — `release/codeworks-<UUID>`; изменять её проверенное содержимое запрещено.

Повтор идентичной регистрации возвращает прежнюю конфигурацию. Изменение политики в этой версии не поддержано. У одного Git common directory и корня областей только один проект. `project.get({project_id})` читает политику для разрешённого исполнителя. Необязательный `documentation_paths` задаёт нормализованные разрешённые префиксы документации без symlink. Регистрировать исключения может только администратор проекта; обычные инструменты агента не меняют реестр. Для managed agents префиксы применяет доверенный executor ниже.

## Операции

| Метод | Вход | Результат и эффект |
| --- | --- | --- |
| `prepare-write` | `project_id, idempotency_key, workspace_key, kind, session_id`; для promotion `commit_sha,evidence_id`; необязательно `actor_id, element_id, move_id, attempt_id` | `{operation_id,workspace_id}` после commit намерения. Создаёт область или продолжает прежнюю, не создавая новую ветку для новой attempt. |
| `status` | `project_id,workspace_id` | `{workspace,attachments,git}`. Последние 100 подключений; `git=null` до ready/при failed. Ready проверяет фактическое владение, HEAD и dirty. |
| `attach-or-transfer` | `project_id,idempotency_key,workspace_id,session_id,expected_epoch,mode`; для quiesce обязательно `writes_stopped:true`; ссылки attempt/move и actor необязательны | `{operation_id,workspace_id}`. Короткая завершённая операция с итоговым writer в operation-status. |
| `request-release` | `project_id,idempotency_key,workspace_id,session_id,expected_epoch,target,commit_sha`; actor необязателен | `{operation_id,workspace_id}`. Закрепляет текущий чистый commit и маршрут; создаёт durable Git flow при настроенном github. Незавершённый release области запрещает второй запрос с другим ключом. |
| `operation-status` | `project_id,operation_id` | `{operation}` с исходным запросом, исполнителем, actor, status, step, result/error и временем. |

MCP имена: `codeworks_project_register`, `codeworks_project_get`, `codeworks_prepare_write`, `codeworks_status`, `codeworks_attach_or_transfer`, `codeworks_request_release`, `codeworks_operation_status`. Параметры и результаты совпадают с NATS. CLI `node services/codeworks/src/client.mjs <method>` читает один объект параметров из stdin, печатает один JSON результата; stderr предназначен для безопасных ошибок.

`workspace_key` задаёт собственную идентичность области внутри проекта; он не равен attempt, Move или Element. Первое создание закрепляет UUID области, Element ID, kind, base ref/SHA, ветку и путь. Имена веток: `feature/codeworks-<workspace UUID>`, `hotfix/codeworks-<workspace UUID>`, `release/codeworks-<workspace UUID>`. Путь: `<workspace_root>/<workspace UUID>`. Изменение kind/Element для прежней области отвергается. Несколько разных workspace_key могут ссылаться на один Element.

## Единственный writer

Writer содержит `{executor_id,session_id,epoch,state}`. Первое создание даёт `epoch=1,state=active`. Повторная подготовка существующей области требует того же активного executor/session. Подключение прежнего активного writer допускает новую attempt без смены эпохи.

Передача требует ready, фактического владения Git и двух отдельных действий:

1. Прежний executor/session вызывает `mode=quiesce, expected_epoch, writes_stopped=true`, явно подтверждая прекращение записи. Ядро вызывает порт `assertQuiescent`. При включённом agent host он сначала закрывает admission, сохраняет отзыв session, убивает все её дочерние namespace-процессы и ждёт закрытия pipe/FD. Только после этого ядро фиксирует quiesced.
2. Новый исполнитель вызывает `mode=attach` с полученной эпохой. Только `quiesced` область меняет writer и увеличивает эпоху. Конкурент получает WRITER_BUSY.

Ни таймаут, ни отсутствие heartbeat, ни новая attempt не освобождают активного writer. Принудительной кражи активной области нет. После передачи старые epoch/session не могут писать через executor, запросить выпуск или сменить владельца. Dirty файлы остаются на месте. Для внешних клиентов без managed host оператор обязан предоставить собственный `assertQuiescent`; одно подтверждение клиента не защищает стороннюю оболочку.

## Доверенное исполнение Codex и Hermes

`CODEWORKS_AGENT_HOST_CONFIG` включает executor в том же owner runtime. Это один core и та же БД, а не отдельный сервис владения. `services/codeworks-agent` содержит тонкие frontend-процессы: Codex app-server stdio/Unix WebSocket и launcher существующего Hermes. На сервере весь исполняемый код, конфигурация, ключи и их родительские каталоги устанавливаются оператором вне writable репозиториев. Host проверяет root ownership и отсутствие group/other write у своих worker файлов; нельзя включать его из рабочего checkout. Корень operational worktrees должен быть отдельным от repo_path.

Native Codex видит synthetic readonly `/proc` только с immutable `/proc/self/exe`, необходимой runtime. Parent/self FD и host PID недоступны; native child не должен получить parent IPC через `pidfd_getfd` или ptrace. Доверенный frontend допускает thread только после start/resume/fork, turn — после ожидаемого native события, subagent — из события активного родителя. Подписываются только calls активного thread/turn; повторный call ID отклоняется. Ключ подписи и frontend находятся вне native PID namespace. Приёмка включает реальные proc/FD aliases и kernel API попытки, а не только проверку mount paths.

Нативный агент запускается в Linux bubblewrap namespace: host filesystem readonly, исходники и корень областей скрыты readonly mount, приватные host inputs скрыты, capabilities сброшены, `/tmp` и `/run` локальны. Writable остаётся только его отдельный профиль. Нативные file/patch/command writers не имеют доступа к исходникам даже при запросе `dangerFullAccess`. Существующий RTK hook сохраняется с исходным trust и служит интерфейсу; hooks не являются OS-границей. Оператор обязан скрыть account homes, credentials, управляющие sockets и иные доступные агенту пути удалённой записи. Linux, bubblewrap с user/PID namespaces, подготовленные зависимости и доверенный launcher обязательны; обход через несandboxed прежний процесс требует остановки такого процесса при включении.

Codex получает dynamic tool `codeworks` в настоящем app-server thread. Frontend подписывает запрос с реальным `threadId`; subagent имеет собственный threadId. Managed resume/fork сохраняют инструмент и routing, legacy unmanaged resume отклоняется. Hermes регистрирует тот же owner schema в настоящем `tools.registry`; dispatcher передаёт `AIAgent.session_id`. Секрет adapter передаётся через pipe в private namespace file и удаляется до model loop; подписи не принимаются из аргументов модели. Native Hermes tools закрыты dispatcher gate; его permissive hook не используется как enforcement. `--gateway` загружает штатный gateway через этот же bootstrap; platform toolsets должны разрешать codeworks, а существующий gateway останавливается оператором перед переключением. Самостоятельный запуск старого executable вне launcher не защищён.

У каждого executor отдельный adapter key/socket. Native identity отображается в durable случайный broker session UUID; workspace UUID, Element/Move/attempt и identity процесса не смешиваются. Control socket и scoped session sockets доступны только доверенному frontend/оператору; модель получает подписывающий adapter без возможности выбирать session_id. Перезапуск host убивает дочерние namespaces (`die-with-parent`), а session metadata восстанавливаются. Он не передаёт writer по heartbeat.

Машинный источник инструмента — [agent-tools.json](src/agent-tools.json). Действия:

| Действие | Поведение |
| --- | --- |
| `read(path)` | Читает исходную копию до первой записи, затем только свою область. |
| `batch(operations)` | `write/delete/rename/symlink`; проверяет весь batch, включая обе стороны rename и существующих ancestors. |
| `patch(patch)` | Parse `*** Begin Patch` с Add/Delete/Update/Move, затем та же общая проверка и исполнение. |
| `command(mode,argv,input?)` | Обязательный `read` или `write`; содержимое shell не классифицируется. Read mount readonly; write заранее подготавливает область. |
| `poll(command_id)`, `stdin(command_id,input,eof?)` | Только процессы собственной session. Старый открытый shell после quiesce остановлен; stdin отвергается. |
| `status` | Текущая область/writer без её создания. |

До первой мутации проверяются фактические канонические пути; абсолютный repo_path становится alias своей области. Переходы через symlink за пределы проекта, `.git`, `node_modules`, `.env*`, `.secrets`, `.agents`, `.codex` запрещены файловым worker. Локальные `@brai/*` разрешены через их настоящие workspace paths; сторонние зависимости readonly. После подготовки все последующие read/write данного агента используют область. Команда в режиме write может менять любые не исключённые файлы внутри области, поэтому shell не является способом документационной записи без worktree.

Только batch без symlink, целиком в `documentation_paths` и с расширениями `.md/.txt/.rst/.adoc`, может записать документацию в исходную копию без области. Mixed docs/code целиком получает область. Проверка всего batch предшествует первой записи; автоматического переноса уже выполненной половины или повтора команды нет. Ошибка IO во время исполнения может оставить частичный результат: агент проверяет его явно. Docs prefix должен существовать, иначе write fail-closed.

Host допускает 32 активных процесса, удерживает не более 256 результатов; команда ограничена 120 секундами (operator maximum 600), stdout+stderr 1 MiB. Scoped input frame 1 MiB, response 2 MiB, socket timeout 180 секунд; подготовка ожидается до 150 секунд, затем остаётся durable pending intent. Один batch содержит до 128 операций. Ни клиент, ни host не повторяют команды после неопределённого результата.

## Повторы, выполнение и восстановление

Ключ повтора имеет область `(project_id,executor_id,idempotency_key)` для всех изменяющих операций. Совпадающий нормализованный payload и метод возвращает первоначальный operation ID; другой payload даёт CONFLICT. JSON-порядок ключей не влияет на сравнение. Разные ключи подготовки одной области с тем же writer объединяются с существующей pending/running/succeeded подготовкой; новые ссылки attempt сохраняются отдельно. После failed для повторного исполнения нужен новый ключ: прежний ключ продолжает показывать прежнюю ошибку.

Долгое выполнение не удерживает NATS запрос. Worker запускается из pending/running записей при старте и затем раз в секунду. Одновременно не более четырёх workers процесса. Короткие изменения сериализует PostgreSQL advisory lock проекта. Все Git мутации выполняются под общим файловым `flock` данного Git common directory и session advisory lock. FD flock наследуют Git и подготовщик: остановка Node не освобождает блокировку, пока его дочерняя операция продолжает исполняться.

Намерение, UUID, случайный ownership token, база и назначение фиксируются до изменения Git. Ветка и постоянный `refs/codeworks/ownership/<workspace UUID>` создаются одной транзакцией `update-ref` с проверкой отсутствия обоих refs. Ownership ref удерживает Git blob с UUID, token, branch, base SHA и path; срок хранения reflog на доказательство не влияет. Worktree создаётся с native `--lock --reason codeworks:<token>`. Возобновление проверяет исходное доказательство ref, точные branch/path/common directory и locked reason. Ветка в другом каталоге, чужая ветка, каталог без своей регистрации, symlink или изменённый незавершённый index отвергаются без удаления и присвоения.

Регистрация worktree и заполнение файлов разделены: `--no-checkout` не завершает подготовку. `read-tree` создаёт отсутствующий index закреплённой базы; существующий index должен совпасть. `checkout-index --all` без `--force` заполняет отсутствующие файлы, затем требуется чистый checkout. Существующие изменения не перезаписываются. Незавершённая операция проверяет реальный Git и повторяет безопасные шаги, даже если процесс остановился после Git до commit результата. Собственные строки и ресурсы не удаляются при ошибке. Неизвестные Git lock-файлы/ручные изменения автоматически не снимаются: оператор разбирает причину, затем повторяет подготовку новым ключом.

## Зависимости

Подготовка вызывает только зарегистрированный существующий подготовщик, затем тот же `--check`. Установки npm, загрузок Node, изменений общих пакетов и отдельного runtime нет. До вызова Codeworks сверяет Node, platform и наличие lockfiles. Штатный подготовщик требует одинаковый lockfile либо только добавление локальных workspaces: весь внешний lock graph и прежние manifests должны совпадать; новые manifests сверяются с lock entries, их зависимости должны точно соответствовать уже закреплённым готовым пакетам. Новые workspace ссылки указывают только в текущий worktree. Штатный подготовщик проверяет npm, workspace manifests, полный установленный набор/версии, native Next пакет, сторонние readonly ссылки, локальные workspace ссылки и локальные результаты сборки. Несовместимость даёт DEPENDENCIES_INCOMPATIBLE с безопасным кодом причины. Намерение, ошибка и созданный собственный checkout остаются в БД/Git.

## Выпуски и история

При отсутствии `project.github` прежние запросы остаются `awaiting_execution` с причиной `RELEASE_EXECUTION_NOT_AVAILABLE`; автоматического переключения существующих проектов нет. Оператор регистрирует новую политику с `github:{repository:"owner/repo",required_checks:[{name,app_id}]}`. Список checks непустой: принимаются только успешные `completed/success` checks конкретного GitHub App на точном SHA; отсутствие, pending, failure, skipped, другой App/SHA или неоднозначные дубликаты запрещают продолжение. Обычные commit statuses не заменяют этот контракт. `origin` для чтения и записи должен быть единственным HTTPS URL `https://github.com/<repository>.git`; несовпадение запрещает работу. Нужны существующие Git с `merge-tree --write-tree`, `flock`, `gh` и operator GitHub authentication. Загрузок и установок runtime не делает.

Маршруты:

- Feature: точный origin/dev → своя feature ветка → PR в dev → merge → CI итогового SHA → запрос DEV установки → доверенное подтверждение установки.
- Promotion: исторический проверенный DEV SHA → своя release ветка без правок → PR в main → merge → CI итогового SHA → PROD установка. Latest dev не подменяет закреплённую версию.
- Hotfix: origin/main, равный фактически установленному PROD → линейная hotfix ветка (merge unreleased dev запрещён) → PR в main → CI и подтверждённая PROD установка → отдельный PR исходного исправления в dev → CI и DEV установка. Hotfix не завершён до обоих путей и подтверждений. Перед первым PR установленная версия и main повторно должны совпасть с frozen base.

Один worker под общим project flock/session advisory lock сериализует слияния; checkout основной/чужой ветки не меняется. Target SHA закрепляется до публикации. Каждый шаг сначала сохраняет намерение в `releases.details` и `operations.result`, затем изменяет внешнюю систему. Публикуется только закреплённый head; PR проверяется по repository, branch, head и target. PR body содержит идентификатор своей области; сторонний PR не присваивается.

Git создаёт детерминированный merge commit с точными parents `[target_sha,head]` через merge-tree/commit-tree. Конфликт сохраняет обе ветки и область. Последнее чтение PR/head/checks/target предшествует обычному non-force push candidate в target. Divergent конкурентное изменение атомарно отвергается сервером Git; чужой commit сохраняется. Изменившийся target требует нового намерения/проверки; worker не пересобирает и не выпускает latest автоматически. Защита веток может запретить прямой push: это блокировка, настройки/merge queue не обходятся. Удаления remote refs, force, rebase и cleanup здесь отсутствуют.

При потерянном ответе worker сначала читает реальный remote ref и PR, включая закрытые. Merge принимается только после проверки точных parents, containment в фактическом target и `PR.merged/merge_commit_sha` GitHub. Неопределённый create/push не повторяется вслепую: если результат чтением не подтверждён, сохраняется `awaiting_reconciliation`; оператор разбирает исходную публикацию. Ветка и незавершённая область остаются. Отмена транспорта не отменяет операцию. Waiting состояния опрашиваются не чаще 30 секунд; предел workers остаётся четыре.

Git merge сам по себе не завершает release. `awaiting_ci/HEAD_CHECKS_REQUIRED` означает проверки исходного head, `awaiting_ci/MERGE_CHECKS_REQUIRED` — проверки **точного итогового merge SHA**. Только затем `awaiting_deployment/EXACT_MERGE_DEPLOYMENT_REQUIRED` передаёт этапам CI/deployment `{release_id,state,details:{primary,backport?}}`; leg содержит `target,head,target_sha,merge_sha,pr_number,pr_url`. Runtime не запускает CI, сборку или rollout, не создаёт искусственные статусы. `succeeded` появляется лишь после успешных exact merge checks и доверенного подтверждения установки каждого необходимого leg. Workspace должен оставаться clean на закреплённом HEAD до завершения намерения.

Отдельный owner-вход `src/deployment-evidence.mjs` принимает один JSON из stdin: `{project_id,target:"dev"|"prod",commit_sha,evidence_url}`. Он предназначен **только** для доверенного deployment verifier после фактической установки и проверки окружения, включая исходную регистрацию установленного PROD. Это не метод NATS/MCP, agent tools или обычный параметр release. Credentials `CODEWORKS_EVIDENCE_DATABASE_URL` и allowlist передаются только verifier, вне агентских профилей и writable checkout. Порт `recordDeployment` пишет собственный append-only журнал `deployment_evidence`; точный повтор текущего отчёта идемпотентен. Последний отчёт определяет фактически установленную версию; URL — ссылка на подлинный отчёт verifier, не проверка HTTP-строки вместо установки. Без подключённого доверенного verifier Codeworks остаётся в ожидании. Вход доверяет аттестующему verifier, сам не исполняет rollout и не проверяет окружение. Этапы 5–6 реализуют этот адаптер; Stage 4 не создаёт реальных installed records.

События глобальной истории сейчас не нужны: технические намерения и writer-переходы доступны в собственных operations/attachments. Категории и типы service_history проверены через MCP при создании сервиса. Событие release не отправляется, пока фактический deployment-адаптер не подключён. Для будущего фактического выпуска гарантию доставки следует определить вместе с исполнителем, не заменяя её Core NATS publish после commit.

## Ошибки и пределы

NATS ошибки возвращаются заголовками `Nats-Service-Error` (owner code), `Nats-Service-Error-Code` (HTTP-подобный статус) и DTO `{code,message,retryable}`. INVALID_ARGUMENT 400; FORBIDDEN 403; NOT_FOUND 404; CONFLICT/WRITER_BUSY/OWNERSHIP_CONFLICT 409; DEPENDENCIES_INCOMPATIBLE/GIT_FAILED 422; BUSY 503; INTERNAL 500. Git flow также возвращает GITHUB_UNAVAILABLE, CHECKS_BLOCKED, TARGET_CHANGED, MERGE_CONFLICT, PRODUCTION_BASE_MISMATCH, VERIFIED_DEV_REQUIRED. Только BUSY объявлен retryable; waiting операции продолжаются по собственному расписанию. Внутренние stderr, SQL и credentials не выдаются.

Вход ограничен 65 536 байтами; NATS одновременно обслуживает восемь коротких запросов, остальные получают BUSY. Пул API: восемь соединений, connect 3 секунды, SQL 10 секунд, ожидание проектного lock 1 секунда. Опрос статуса и точный повтор уже принятого ключа не ждут долгой подготовки. Клиент NATS/MCP ждёт ответ 10 секунд. Тайм-аут связи не отменяет intent: проверяйте operation-status или повторяйте тот же ключ. Git/preparer команда ограничена 120 секундами, stdout 1 MiB; исходный intent остаётся при остановке.

## Конфигурация и собственная БД

Сервис: `CODEWORKS_ALLOWED_REPOSITORIES`, `CODEWORKS_DATABASE_URL`, `CODEWORKS_NATS_URL`, `CODEWORKS_NATS_CREDS_FILE`, `CODEWORKS_EXECUTORS` (через запятую), необязательный `CODEWORKS_ADMIN_EXECUTOR`. MCP/CLI: URL/creds-file и `CODEWORKS_EXECUTOR_ID`; PostgreSQL credentials им не нужны. Все адреса, каталоги экземпляра, ACL и внешние inputs задаёт оператор. Продукт не содержит серверных путей или Ansible.

Миграция: `CODEWORKS_OWNER_DATABASE_URL`, `CODEWORKS_APP_ROLE`, затем `npm run migrate --workspace=@brai/codeworks`. Owner должен владеть отдельной БД и отличаться от app. App без elevated flags/memberships получает SELECT/INSERT/UPDATE только `codeworks.*`, без DDL/DELETE и доступа к журналу миграций. Повтор миграции проверяет SHA256 исходного SQL; несовпадение даёт MIGRATION_CHECKSUM_MISMATCH. Runtime не запускает миграции.

Для восстановления нужны согласованный dump собственной БД **и** исходный Git common directory/workspaces с постоянным ownership ref и native locked reason. База без Git доказательств не присваивает найденные каталоги. Восстанавливать поверх активного исполнителя нельзя: остановите один сервис, верните БД/его Git ресурсы, запустите; pending/running и waiting Git flow проверяются и продолжаются. Выполненные операции не повторяются.

## Приёмка

`npm test --workspace=@brai/codeworks` проверяет схемы, transport DTO и независимое ядро writer/guard. `CODEWORKS_TEST_CONFIG_FILE=<protected JSON> npm run test:integration --workspace=@brai/codeworks` использует реальные PostgreSQL/Git/flock/штатный preparer и SIGKILL. Явный fixture JSON содержит `owner_url,app_url,restore_owner_url,restore_app_url,owner_role,app_role`; тест принимает только DB `brai_codeworks_test` и `brai_codeworks_restore_test`, не читает .env. Для установленного подготовщика используется common Git hook текущей копии либо явный `CODEWORKS_TEST_PREPARER`. Все disposable репозитории находятся в корневом `tmp/` и убираются после теста.

Для проверки настоящего backup/restore выполните `node services/codeworks/tests/integration/recovery.mjs prepare` с тем же защищённым config. Fixture оставит в первой test DB ready область, ожидающий release и намерение, оборванное SIGKILL после создания ветки. Оператор сохраняет `pg_dump` и восстанавливает его во вторую пустую test DB. Затем `node services/codeworks/tests/integration/recovery.mjs verify` проверяет восстановленные данные/миграцию, продолжает Git операцию через app credentials восстановленной БД и доказывает неизменность исходной операции. После успеха fixture очищает только свои test rows, restore schema и disposable Git. Во время этой последовательности не запускайте параллельно обычную integration suite, которая очищает те же test rows.

## Описания и независимые поставки компонентов

Codeworks владеет форматом [`component.json`](schemas/component.schema.json), версия 1.
Локальный CLI [`components/cli.mjs`](components/cli.mjs) читает описания из дерева
Brai; отдельный реестр имён и список сборок не нужны. Это инструмент подготовки
поставки, без NATS API выпуска и без доступа к Admin. Описание содержит стабильный
ID, вид компонента, проверяемые входы, build edges, команды, runtime closure,
миграции, health и логические deploy unit IDs. Параметры хоста задаёт оператор.

Порядок изменения, retirement/rename и воспроизводимые команды описаны в
[`components/README.md`](components/README.md). Отсутствие описания нового workspace
или executable, неверная схема, неизвестная зависимость и цикл — ошибки. Проверка
относительно Git-базы сохраняет удалённый ID только через явный retirement.

Изолированные Git flow проверки: `node --test --test-isolation=none services/codeworks/tests/git-flow.test.mjs`. Изменённые PostgreSQL/API пути: `CODEWORKS_TEST_CONFIG_FILE=<protected JSON> node --test --test-isolation=none --test-concurrency=1 services/codeworks/tests/integration/postgres.test.mjs services/codeworks/tests/integration/git-flow.test.mjs`. Реальные GitHub push/PR и exact checks проверяются отдельно: отсутствие CI сохраняет awaiting_ci, не считается успешной проверкой кода. В тестах GitHub и deployment verifier — явные doubles; они не подтверждают реальный rollout.

# Codeworks: проекты, рабочие области и durable операции

Codeworks — один сервис Brai с собственной БД PostgreSQL на существующем сервере PostgreSQL. Он владеет реестром проектов, областями, правом записи, журналом операций и запросами выпуска. Game-core владеет задачами: Codeworks хранит только необязательный стабильный `element_id` области и отдельные ссылки `move_id`, `attempt_id`, `session_id` в подключениях. Одна область может пережить несколько попыток. Заголовки, статусы и планы задач не копируются; чужая БД не читается.

Машинный источник форматов — [api.schema.json](schemas/api.schema.json), JSON Schema Draft-07. Реальные NATS subjects и сообщения — [asyncapi.json](asyncapi.json), NATS Services ADR-32. MCP использует стандартный SDK и раскрывает те же owner-схемы; отдельного программного JSON-RPC API нет. Постоянные требования описаны в admin OpenSpec `contract-authoring`, `program-rpc`, `service-messaging`; продукт не читает admin во время работы.

## Сборка границ

`NATS / MCP → call → ядро domain → предметные порты storage / Git`.

`prepare-write → COMMIT intent → worker под flock → Git branch → checkout → preparer → COMMIT ready`.

MCP stdio и локальный CLI — клиенты единственного NATS API, не отдельные экземпляры сервиса. `main.mjs` собирает PostgreSQL, ядро, NATS и восстановление. Прямой SQL находится в storage, миграции и worker; ядро не импортирует pg/NATS/MCP. Очередь — строки собственной БД, без дополнительного брокера, движка или фреймворка. Node 24.21.0 запускает исходные `.mjs`, отдельная компиляция не требуется.

## Доступ и реестр

NATS Service: `service_codeworks`, версия `1.0.0`, queue `service_codeworks`; SDK предоставляет PING/INFO/STATS. Subjects: `brai.codeworks.v1.<executor>.<method>`. Executor — удостоверенная broker ACL часть subject, а не поле запроса. Например, credentials Codex разрешают publish только `brai.codeworks.v1.codex.>`; credentials Hermes — только собственный prefix. Без этих ACL интерфейс нельзя считать удостоверенным. MCP/CLI получают собственные credentials и executor из явной конфигурации; подмена executor в payload запрещена схемой.

Runtime требует явный `CODEWORKS_ALLOWED_REPOSITORIES` — JSON-массив абсолютных repo_path. Он проверяет allowlist при регистрации, обращении к проекту и в worker. Для первого внедрения оператор разрешает только DEV/production checkout Brai; Admin в реестр и процесс Codeworks не входит.

Все операции проверяют executor по `project.executors`. Регистрацию выполняет только `CODEWORKS_ADMIN_EXECUTOR` (по умолчанию `codeworks_admin`); отдельные admin credentials не выдаются обычным исполнителям. `actor_id` необязателен и заявлен вызывающим; `operations.executor_id` всегда содержит транспортного исполнителя. Это внутренний доверенный интерфейс без пользовательского HTTP endpoint.

`project.register({project})` проверяет канонические `repo_path`, `common_dir`, существующий `workspace_root`, исполняемый файл подготовщика, Node/platform, нормализованные префиксы разрешённых и исключённых путей. Git flow первого этапа: feature от `refs/remotes/origin/dev`, hotfix от `refs/remotes/origin/main`, префиксы `feature/` и `hotfix/`. База читается из текущего локального remote ref; Codeworks не делает fetch. Обновление remote refs — обязанность оператора перед созданием новой области. Запасной переход на main запрещён.

Повтор идентичной регистрации возвращает прежнюю конфигурацию. Изменение политики в этой версии не поддержано. У одного Git common directory и корня областей только один проект. `project.get({project_id})` читает политику для разрешённого исполнителя. Префиксы путей — данные политики для следующих hooks; ограничения произвольных действий редактора/оболочки на этом этапе не реализованы. Сервис изменяет только собственные Git ресурсы и запускает зарегистрированный подготовщик.

## Операции

| Метод | Вход | Результат и эффект |
| --- | --- | --- |
| `prepare-write` | `project_id, idempotency_key, workspace_key, kind, session_id`; необязательно `actor_id, element_id, move_id, attempt_id` | `{operation_id,workspace_id}` после commit намерения. Создаёт область или продолжает прежнюю, не создавая новую ветку для новой attempt. |
| `status` | `project_id,workspace_id` | `{workspace,attachments,git}`. Последние 100 подключений; `git=null` до ready/при failed. Ready проверяет фактическое владение, HEAD и dirty. |
| `attach-or-transfer` | `project_id,idempotency_key,workspace_id,session_id,expected_epoch,mode`; для quiesce обязательно `writes_stopped:true`; ссылки attempt/move и actor необязательны | `{operation_id,workspace_id}`. Короткая завершённая операция с итоговым writer в operation-status. |
| `request-release` | `project_id,idempotency_key,workspace_id,session_id,expected_epoch,target,commit_sha`; actor необязателен | `{operation_id,workspace_id}`. Регистрирует запрос для текущего чистого commit. |
| `operation-status` | `project_id,operation_id` | `{operation}` с исходным запросом, исполнителем, actor, status, step, result/error и временем. |

MCP имена: `codeworks_project_register`, `codeworks_project_get`, `codeworks_prepare_write`, `codeworks_status`, `codeworks_attach_or_transfer`, `codeworks_request_release`, `codeworks_operation_status`. Параметры и результаты совпадают с NATS. CLI `node services/codeworks/src/client.mjs <method>` читает один объект параметров из stdin, печатает один JSON результата; stderr предназначен для безопасных ошибок.

`workspace_key` задаёт собственную идентичность области внутри проекта; он не равен attempt, Move или Element. Первое создание закрепляет UUID области, Element ID, kind, base ref/SHA, ветку и путь. Имена веток: `<kind>/codeworks-<workspace UUID>`. Путь: `<workspace_root>/<workspace UUID>`. Изменение kind/Element для прежней области отвергается. Несколько разных workspace_key могут ссылаться на один Element.

## Единственный writer

Writer содержит `{executor_id,session_id,epoch,state}`. Первое создание даёт `epoch=1,state=active`. Повторная подготовка существующей области требует того же активного executor/session. Подключение прежнего активного writer допускает новую attempt без смены эпохи.

Передача требует ready, фактического владения Git и двух отдельных действий:

1. Прежний executor/session вызывает `mode=quiesce, expected_epoch, writes_stopped=true`, явно подтверждая прекращение записи. Ядро вызывает также порт `assertQuiescent`; следующий этап может подключить проверку запущенных процессов. Сейчас Codeworks не запускает пользовательские редакторы/агентов и доверяет явному подтверждению прежнего владельца.
2. Новый исполнитель вызывает `mode=attach` с полученной эпохой. Только `quiesced` область меняет writer и увеличивает эпоху. Конкурент получает WRITER_BUSY.

Ни таймаут, ни отсутствие heartbeat, ни новая attempt не освобождают активного writer. Принудительной остановки или кражи активной области нет. После передачи старые epoch/session не могут запросить выпуск или сменить владельца. Проверка OS-записи внешних программ будет отдельным hook этапа 2; текущий writer регулирует операции Codeworks.

## Повторы, выполнение и восстановление

Ключ повтора имеет область `(project_id,executor_id,idempotency_key)` для всех изменяющих операций. Совпадающий нормализованный payload и метод возвращает первоначальный operation ID; другой payload даёт CONFLICT. JSON-порядок ключей не влияет на сравнение. Разные ключи подготовки одной области с тем же writer объединяются с существующей pending/running/succeeded подготовкой; новые ссылки attempt сохраняются отдельно. После failed для повторного исполнения нужен новый ключ: прежний ключ продолжает показывать прежнюю ошибку.

Долгое выполнение не удерживает NATS запрос. Worker запускается из pending/running записей при старте и затем раз в секунду. Одновременно не более четырёх workers процесса. Короткие изменения сериализует PostgreSQL advisory lock проекта. Все Git мутации выполняются под общим файловым `flock` данного Git common directory и session advisory lock. FD flock наследуют Git и подготовщик: остановка Node не освобождает блокировку, пока его дочерняя операция продолжает исполняться.

Намерение, UUID, случайный ownership token, база и назначение фиксируются до изменения Git. Ветка и постоянный `refs/codeworks/ownership/<workspace UUID>` создаются одной транзакцией `update-ref` с проверкой отсутствия обоих refs. Ownership ref удерживает Git blob с UUID, token, branch, base SHA и path; срок хранения reflog на доказательство не влияет. Worktree создаётся с native `--lock --reason codeworks:<token>`. Возобновление проверяет исходное доказательство ref, точные branch/path/common directory и locked reason. Ветка в другом каталоге, чужая ветка, каталог без своей регистрации, symlink или изменённый незавершённый index отвергаются без удаления и присвоения.

Регистрация worktree и заполнение файлов разделены: `--no-checkout` не завершает подготовку. `read-tree` создаёт отсутствующий index закреплённой базы; существующий index должен совпасть. `checkout-index --all` без `--force` заполняет отсутствующие файлы, затем требуется чистый checkout. Существующие изменения не перезаписываются. Незавершённая операция проверяет реальный Git и повторяет безопасные шаги, даже если процесс остановился после Git до commit результата. Собственные строки и ресурсы не удаляются при ошибке. Неизвестные Git lock-файлы/ручные изменения автоматически не снимаются: оператор разбирает причину, затем повторяет подготовку новым ключом.

## Зависимости

Подготовка вызывает только зарегистрированный существующий подготовщик, затем тот же `--check`. Установки npm, загрузок Node, изменений общих пакетов и отдельного runtime нет. До вызова Codeworks сверяет Node, platform и точные байты lockfile с source checkout. Штатный подготовщик проверяет npm, workspace manifests, полный установленный набор/версии, native Next пакет, сторонние readonly ссылки, локальные workspace ссылки и локальные результаты сборки. Несовместимость даёт DEPENDENCIES_INCOMPATIBLE с безопасным кодом причины. Намерение, ошибка и созданный собственный checkout остаются в БД/Git.

## Выпуски и история

На этом этапе выпуск **не исполняется**. Запрос для clean HEAD сохраняет release и операцию со статусом `awaiting_execution`, результатом `{release_id,reason:"RELEASE_EXECUTION_NOT_AVAILABLE"}`. Merge, push, сборка, rollout и проверка окружения не выполняются. Такой ответ нельзя показывать как успешный выпуск.

События глобальной истории сейчас не нужны: технические намерения и writer-переходы доступны в собственных operations/attachments. Категории и типы service_history проверены через MCP при создании сервиса. Событие release не отправляется, поскольку выпуска нет. Для будущего фактического выпуска гарантию доставки следует определить вместе с исполнителем, не заменяя её Core NATS publish после commit.

## Ошибки и пределы

NATS ошибки возвращаются заголовками `Nats-Service-Error` (owner code), `Nats-Service-Error-Code` (HTTP-подобный статус) и DTO `{code,message,retryable}`. INVALID_ARGUMENT 400; FORBIDDEN 403; NOT_FOUND 404; CONFLICT/WRITER_BUSY/OWNERSHIP_CONFLICT 409; DEPENDENCIES_INCOMPATIBLE/GIT_FAILED 422; BUSY 503; INTERNAL 500. Только BUSY объявлен retryable. Внутренние stderr, SQL и credentials не выдаются.

Вход ограничен 65 536 байтами; NATS одновременно обслуживает восемь коротких запросов, остальные получают BUSY. Пул API: восемь соединений, connect 3 секунды, SQL 10 секунд, ожидание проектного lock 1 секунда. Опрос статуса и точный повтор уже принятого ключа не ждут долгой подготовки. Клиент NATS/MCP ждёт ответ 10 секунд. Тайм-аут связи не отменяет intent: проверяйте operation-status или повторяйте тот же ключ. Git/preparer команда ограничена 120 секундами, stdout 1 MiB; исходный intent остаётся при остановке.

## Конфигурация и собственная БД

Сервис: `CODEWORKS_ALLOWED_REPOSITORIES`, `CODEWORKS_DATABASE_URL`, `CODEWORKS_NATS_URL`, `CODEWORKS_NATS_CREDS_FILE`, `CODEWORKS_EXECUTORS` (через запятую), необязательный `CODEWORKS_ADMIN_EXECUTOR`. MCP/CLI: URL/creds-file и `CODEWORKS_EXECUTOR_ID`; PostgreSQL credentials им не нужны. Все адреса, каталоги экземпляра, ACL и внешние inputs задаёт оператор. Продукт не содержит серверных путей или Ansible.

Миграция: `CODEWORKS_OWNER_DATABASE_URL`, `CODEWORKS_APP_ROLE`, затем `npm run migrate --workspace=@brai/codeworks`. Owner должен владеть отдельной БД и отличаться от app. App без elevated flags/memberships получает SELECT/INSERT/UPDATE только `codeworks.*`, без DDL/DELETE и доступа к журналу миграций. Повтор миграции проверяет SHA256 исходного SQL; несовпадение даёт MIGRATION_CHECKSUM_MISMATCH. Runtime не запускает миграции.

Для восстановления нужны согласованный dump собственной БД **и** исходный Git common directory/workspaces с постоянным ownership ref и native locked reason. База без Git доказательств не присваивает найденные каталоги. Восстанавливать поверх активного исполнителя нельзя: остановите один сервис, верните БД/его Git ресурсы, запустите; pending/running проверяются и продолжаются. Выполненные операции не повторяются.

## Приёмка

`npm test --workspace=@brai/codeworks` проверяет схемы, transport DTO и независимое ядро writer/guard. `CODEWORKS_TEST_CONFIG_FILE=<protected JSON> npm run test:integration --workspace=@brai/codeworks` использует реальные PostgreSQL/Git/flock/штатный preparer и SIGKILL. Явный fixture JSON содержит `owner_url,app_url,restore_owner_url,restore_app_url,owner_role,app_role`; тест принимает только DB `brai_codeworks_test` и `brai_codeworks_restore_test`, не читает .env. Для установленного подготовщика используется common Git hook текущей копии либо явный `CODEWORKS_TEST_PREPARER`. Все disposable репозитории находятся в корневом `tmp/` и убираются после теста.

Для проверки настоящего backup/restore выполните `node services/codeworks/tests/integration/recovery.mjs prepare` с тем же защищённым config. Fixture оставит в первой test DB ready область, ожидающий release и намерение, оборванное SIGKILL после создания ветки. Оператор сохраняет `pg_dump` и восстанавливает его во вторую пустую test DB. Затем `node services/codeworks/tests/integration/recovery.mjs verify` проверяет восстановленные данные/миграцию, продолжает Git операцию через app credentials восстановленной БД и доказывает неизменность исходной операции. После успеха fixture очищает только свои test rows, restore schema и disposable Git. Во время этой последовательности не запускайте параллельно обычную integration suite, которая очищает те же test rows.

# Поставка и восстановление bug-hunt

Сервис устанавливается выборочно из принятого артефакта component.json.
Образ runtime переиспользует неизменные зависимости; данные и credentials
не входят в образ. Compose-рецепт — deploy/compose.bug-hunt.yml.

## Порядок первой установки

1. Создать отдельную PostgreSQL БД, owner и app роли NOSUPERUSER,
   NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS.
   Запретить PUBLIC CONNECT и CREATE; выдать CONNECT только owner и app.
2. Закрепить installationId, cursorKey и конфигурацию экземпляра.
   Не генерировать их заново при обновлении или восстановлении.
3. Применить миграции owner-процессом. В runtime отсутствует owner URL.
4. Настроить NATS ACL до старта: service подписывается только на свои subjects,
   системный Service API и собственный inbox; публикует ответы и явно нужные
   Auth identity-get/session и Artifacts get. Web публикует report/get/list/review/
   operator-list. Broker личного Hermes получает только report/get/list.
   Обычные UID не получают credentials ни Web, ни broker.
   Status разрешён только оператору; право subject не берётся из тела сообщения.
5. Запустить runtime с app URL и read-only runtime/principal файлами.
6. Проверить status, MCP discovery и синтетическое обращение отдельно для Codex,
   личного Hermes и Web. Проверить отказ чужому владельцу и отзыв доступа.
7. Включить общий bugHunt для доверенного broker и установить новую поставку
   Hermes: BUG_HUNT.md находится внутри его instructions и загружается каждый ход
   вместе с BASE.md, независимо от личных USER.md/SOUL.md. Новые и прежние
   профили получают одну короткую обязательную строку с вызовом bug_hunt_help.
8. Постоянно подключить owner-bound MCP в Codex через Ansible и перечитать
   каталог. Одна строка server instructions направляет к bug_hunt_help;
   полный протокол и пример возвращаются только по вызову этого инструмента.
9. Выпуск не завершён до проверки установленного личного Hermes и нового чата
   Codex: четыре инструмента обнаружены, короткая строка присутствует в контексте,
   help возвращает справку без изменения данных,
   синтетическое наблюдение принято, повтор возвращает ту же квитанцию.
   Одно слияние Git без подключения сервиса/клиентов этого не подтверждает.


Принятый Compose монтирует BUG_HUNT_RUNTIME_INPUTS_DIR целиком read-only
в /run/bug-hunt. Каталог содержит только app-only runtime.json и principals.json.
Owner migration.env, NATS plan и другие операторские inputs находятся вне
этого каталога. Отдельный file bind mount реестра запрещён: атомарная замена
файла должна быть видна следующему HTTP-запросу без recreate контейнера.
Параметры соединений читаются при старте и требуют штатного перезапуска.
Флаги и бюджеты обработки перечитываются перед отправкой задания, как описано
ниже. Реестр principals перечитывается на каждом HTTP-запросе.

## Данные и откат

Владелец БД отвечает за резервную копию всех таблиц, включая mutation и review,
и отдельную защищённую копию installationId, cursorKey и runtime inputs.
Использовать pg_dump custom format и pg_restore в отдельной БД;
проверить IDs, исходные наблюдения, квитанции повторов и аудит.
Содержимое Artifacts сохраняется по его собственному lifecycle.

Задания и результаты диагностики хранятся в существующем журнале `verification_mutation` с отдельными типами записи. Полный дамп сохраняет задания, факты, результаты и исходные квитанции. Проверка восстановления поднимает отдельную БД и сверяет старый `request_id`, исходную запись и обработанность карточки.

Откат приложения сохраняет БД и не удаляет миграции. Версия 1 читает схему 1;
следующее изменение до выпуска должно сохранять этот путь либо явно остановить
несовместимый откат. Runtime не удаляет старые обращения при заполнении:
новые запросы получают BUSY, прежние квитанции остаются доступными.
Изменение maxReports не разрешает удалять пользовательские данные.

## Оператор диагностики

Плейбук Admin `prepare_brai_bug_hunt_investigator.yml` устанавливает отдельную службу выдачи авторизации, worker и таймер. Таймер получает расписание из входа оператора `brai_bug_hunt_investigator.calendar`. По умолчанию подготовка сохраняет службы выключенными. Явное `activate: true` проверяет установленную версию допуска и регистрирует точный unit. Таймер включается отдельно после ручной проверки. Для остановки используйте `disable_brai_bug_hunt_investigator.yml`. При занятом worker он останавливает новые циклы и даёт текущему завершиться перед отзывом допуска.

Защищённый вход задаёт неизменяемый `payload`, отдельные `user`, `uid`, `gid`, loopback `mcp_url` и `mcp_token`. Для авторизации передаётся принятый `provider`, как у Диалогов, и пути `helper_source` и `client_source` с соответствующими SHA-256. Launcher проверяет квитанцию провайдера. Служба использует существующего владельца OAuth и отдельный Unix-сокет с проверкой UID. Рабочая версия Codex и модель берутся из текущей поставки провайдера и каталога. Новый приватный сеанс Codex получает факты Ansible, работает в режиме `read-only` с отключёнными MCP и инструментами и возвращает типизированный вывод.

В `brai_bug_hunt_runtime.mcp.investigators` укажите `codex:<principalId>` фонового исполнителя. Его отдельный токен в `brai_bug_hunt_principals` привязывается к тому же владельцу, что и карточки. Auth и NATS обслуживают авторизацию Bug Hunt. Для фонового цикла работают PostgreSQL, Bug Hunt и общий провайдер. Клиентские чаты, процессы Hermes, Диалогов и общий app-server Codex в запуске не участвуют.

Таймер вызывает `investigate_brai_bug_hunt.yml` для `hermes` и `agent`. Плейбук берёт следующую карточку владельца. Ручной запуск может передать `bug_hunt_case_id` и стабильный `bug_hunt_request_id` для повторной доставки. По умолчанию журнал читается от регистрации карточки. `bug_hunt_since` и `bug_hunt_until` задают явный период UTC. Без прямого свидетельства итог остаётся `insufficient_evidence`.

Для ручного пакета остановите расписание и дождитесь завершения предыдущего одиночного цикла. Запустите установленный `investigate_brai_bug_hunt_batch.yml` с тем же `inventory.yml` и явным `bug_hunt_batch_parallelism`. Значения параллелизма по умолчанию нет. `bug_hunt_batch_plan_only=true` читает очередь и показывает агрегаты без выдачи заданий. Для приёмки доступны выбранные контрольные карточки через `bug_hunt_batch_case_ids`. Обычный ручной вызов обходит всю очередь владельца. Итог показывает чтения Ansible, число вызовов модели, максимум одновременно выполнявшихся задач и состояния обработки. Пакет отдельно показывает карточки, обработанные без диагностики. При отсутствии или отказе источника разбор сохраняет `insufficient_evidence` и перечень необходимых данных. Пакет использует существующего provider owner и создаёт временный рабочий каталог на каждый запуск модели. Запуск плейбука не включает расписание.


Очередь и итоги входят в полный дамп Bug Hunt. Защищённые входы установки и клиентские токены восстанавливаются из защищённой конфигурации. Каталог моделей генерируется заново. Копии OAuth для Bug Hunt не создаются.

## Подключения

BB и Codex подключаются к одному Streamable HTTP MCP со своим клиентским токеном. Для MCP через stdio используйте `node dist/client.js stdio`. Из терминала `node dist/client.js bug_hunt_get input.json` выполняет тот же вызов. Задайте `BRAI_BUG_HUNT_MCP_URL` и `BRAI_BUG_HUNT_MCP_TOKEN_FILE`. Напрямую по сети используйте HTTPS. Локальный HTTP допустим на loopback. Клиентский токен получает отдельную запись в реестре.
Личный Hermes использует sharedServicesConfig.bugHunt.enabled=true только
в защищённой конфигурации broker; его UID-процесс не получает bearer или NATS.
Web проверяет Origin и сессию, затем передаёт ограниченный контекст через NATS.
Новые операторы не становятся проверяющими из параметров модели.

Readiness требует БД, schema_version=1 и рабочий NATS request-reply.
При сбое процесса accepted данные переживают перезапуск; unknown request
повторяется с прежними request_id и точным содержимым.

## Обновление до систематизации

До миграций 002/003/004 оператор устанавливает поддержанное pgvector в собственной
БД bug-hunt; приложение и owner migrator не получают SUPERUSER.
Проверяются прежние hashes, стабильные ключи и исходные квитанции.
V1 schema остаётся 1; sys_capability отдельно фиксирует local 2, model 3 и embedding-generations 4.

Сначала установить новую программу с processing.enabled=false. Проверить v1,
пустое/частичное покрытие v2, девять MCP tools и личный broker.
Затем выбрать ограниченные бюджеты, проверить фактическую модель Gemma2
из SYSTEMATIZATION.md и включать фон небольшими порциями с наблюдением jobs.
Клиентский состав определяется отдельно принятой установкой.

Флаги, бюджеты и внешний доступ могут изменяться через защищённый каталог
runtime inputs без перезапуска: worker перечитывает их перед dispatch.
Database/connection/lease settings требуют штатного restart.
При изменении ACL проверить активные mounted bytes и фактические права нового
соединения; замена host файла и HUP сами по себе не доказывают обновление bind mount.

Backup включает целую БД: группы, аудит, решения, chunks, jobs, attempts,
budget reserves и квитанции. installationId/cursorKey и внешняя policy сохраняются
отдельно защищённым способом. Проверка restore выполняется в другой БД, включая
права app, прежний replay и unknown attempts без нового вычисления.

Перед rollback запретить новый background dispatch, сохранить in-flight intent
и сверить прежние Providers operation IDs. Unknown не объявляется отменённым.
Откатывается только программа; новые таблицы и данные сохраняются.
Старый migrator 001 с REVOKE ALL ON ALL TABLES повторно запускать нельзя:
он снимет grants новых таблиц. Миграция и rollback приложения — отдельные действия.
После возврата новой программы anti-join reconcile обнаружит пропущенные report.

## Отдельное поколение embedding

1. Применить owner migration 004; app получает только SELECT/INSERT реестра
   и аудита, а UPDATE — только полей активного указателя. DDL в runtime запрещён.
2. Проверить operator status: generations.active/build и оба покрытия всего
   корпуса установки. Сохранить active, принятую версию и причины пересчёта.
3. Поставить processing.pause и изменить только защищённый
   processing.targetGeneration на новое стабильное имя. Selector остаётся
   закреплённым в программе. Подготовка registry и jobs не активирует новое имя.
   Проверить прежний active, новый build и объём build_coverage.
4. Принять ограниченные budgets, снять паузу и наблюдать полноту нового build.
   Reconcile добавляет только недостающее embedding obligation. Local/Jev,
   исходники, прежние intent и векторы сохраняются.
   PREVIOUS_GENERATION_UNKNOWN требует решения оператора и явного retry нового
   job, если он принимает риск дополнительного расхода; глобальный build не
   заменяет такой per-job retry.
5. При полном покрытии вызвать только операторский subject
   brai.bug_hunt.v2.processing.activate-generation:
   {request_id,generation,expected_active_generation,reason}.
   Проверить исходную квитанцию и новое active. Повторить тот же вход при
   неизвестном исходе. Новый request_id для слепого повтора запрещён.
6. Проверить similar без inference и CURSOR_STALE для прежнего курсора.
   Для отката активировать прежнее сохранённое поколение той же CAS-командой,
   после проверки его полного покрытия. Если после build появились report,
   старое поколение может требовать явно принятого достроения.

NATS service должен подписываться на новый subject; отдельная operator identity
может публиковать его. У Web, broker Hermes, обычного пользователя и MCP такого
права нет. JSON не может назначить owner или метаданные поколения.
Квитанция и audit сохраняются при перезапуске. Смена target не является релизом
новой модели или разрешением runtime вне Local AI.

Backup включает embedding_generation, embedding_generation_control,
embedding_generation_activation, processing_job/attempt, embedding_chunk и
v2_mutation вместе с исходниками. После pg_restore проверить app SELECT и
запрет UPDATE metadata/DELETE audit до повторной миграции, а затем CAS/replay.
pg_dump без --create не переносит database-level ACL: подготовить отдельную
целевую БД, явно запретить PUBLIC CONNECT/CREATE/TEMPORARY и выдать CONNECT
owner/app до восстановления табличных grants. Сохранять installationId/cursorKey.

Миграция 004 меняет уникальный ключ очереди на ключ с index_generation.
Ранее установленный binary первого этапа (v1, без enqueueProcessing) сохраняет
report/get/list/review; после возвращения v2 anti-join догоняет его новые report.
Старый migrator 001 при таком откате не запускают. Непубликованный промежуточный
stage-2 binary с прежним ON CONFLICT очереди несовместим с 004; для переключения
поколения использовать принятую программу с поддержкой 004 и activate-generation.
Исходная схема v1 и клиентские DTO не меняются; восстановление поколения не
удаляет additive schema и данные. job_id текущей ветви для processing.retry
доступен через enrichment.processing.branches вместе с index_generation.

## Автоматическая подготовка для Jev

После принятого выпуска включить classificationEnabled и защищённую
externalProjectionPolicy=technical-fields-v1 для явно разрешённых owners.
externalProjections может быть пустым: worker готовит каждое наблюдение
автоматически, сохраняет исключённые поля и версию политики. Точный ручной
inputHash/text остаётся необязательным исключением. Ни observation, ни модель
не задают разрешение; выключение политики прекращает новые dispatch.

Сначала поставить processing.pause, сохранить полную БД и runtime inputs,
проверить Jev/Providers без inference и применить policy. Затем снять паузу,
проверить реальные classification jobs и новые обращения, модель/usage,
неизменность оригиналов и отсутствие новых invoke при replay.
Суточные бюджеты сохраняются: оставшийся backfill продолжится после UTC rollover.
Изменение только flags/политики не требует перезапуска runtime.

## Verification v3

Миграция 005 добавляется owner-программой без изменения originals/v1/v2.
Поставка включает workflow bundle, worker, runner, credential helper/client,
schemas и принятый source/recipe registry. До фактической приёмки целевого
состава verification.enabled=false; наличие артефакта и успешная сборка не
открывают admission и не объявляют DEV принятым.

### Lifecycle и приватные программы

Worker, helper и runner имеют отдельный host lifecycle от intake/API и worker v2.
Их запуском, readiness, остановкой, обновлением и rollback владеет Root через
общую роль обоих операторских установщиков. Клиентский и административный входы
используют эту роль; собственные процессы worker или ручной запуск из чата не
заменяют принятый lifecycle. Параметры конкретного экземпляра находятся у
установщика, а не в observation или ответе модели.

Root принимает source/producer receipts и immutable программы, готовит users,
private sockets, закрытые inputs и mount namespaces. Helper запускается под
существующим credential owner UID/GID без дополнительных групп; native/worker
работает отдельно и не видит owner DATA. Root заранее создаёт UDS listener для
worker и передаёт его helper после drop UID/GID. Helper проверяет SO_PEERCRED;
worker не получает provider group. Точный launcher/config/env контракт находится
в [credentials/README.md](owner-rpc/README.md).

Native app-server — собственный private stdio-процесс с чистым HOME/CODEX_HOME,
read-only runtime assets и закрытым startup config. Через auth.command он получает
только access из существующего owner. Нового login, копии auth.json, собственного
refresh механизма или изменений ядра/egress Hermes нет. Единственный owner
сохраняет своё DATA и общий inode flock с остальными потребителями.

Защищённый native registry задаёт принятые программы/launcher, helper socket,
sourceRef, private stateRoot/catalogPath и стабильную generation этого state.
Обычная смена CLI, metadata или OAuth binding не меняет generation native state.
CLI version и hashes каталога записываются для диагностики; версия CLI и набор
qualified model IDs не служат whitelist. До новой фазы загружается авторитетный
каталог того же account, выбирается последняя стабильная Sol/high, а startup
проекция меняет только tool_mode выбранной модели на direct.

Checkpoint отдельно фиксирует source/account/provider binding и catalog revision.
Нельзя обновить эти поля задним числом для продолжения старой фазы. Каждый
наблюдаемый refresh того же account меняет provider binding; старая фаза получает
закрытый допуск. Новая фаза требует preflight с актуальной связью. Root сохраняет
mapping profile revision → generation/stateRoot для восстановления собственных
threads. Потеря state не маскируется выдачей прежней generation пустому каталогу.

Runner получает только собственные intents/receipts и immutable inputs; его
namespace не имеет сети, owner HOME и credentials. Source registry и начальные
recipes подготавливаются из принятых Git commits; hashes source/tree/harness,
fixture, requirement и compiler provenance проверяются до запуска. Применимость
к observation проверяет [контракт v3](VERIFICATION.md), а не текст модели.

### Порядок включения

1. Сохранить согласованное состояние и прежний API release; оставить v3 dispatch
   выключенным. Применить additive migration 005 отдельным owner-процессом.
2. Подготовить общей Root ролью private runtime, mounts, UDS peers, source/recipe
   registry и отдельную очередь/identity Temporal. Проверить readiness программ
   без допуска inference, а также сохранность прежних v1/v2 запросов и квитанций.
3. На фактическом установленном маршруте проверить Root/source admission,
   отрицательные UID/mount/config проверки, отсутствие auth.json и bearer в
   native state/evidence/журналах, общий refresh lock и закрытый unknown recovery.
4. Проверить настоящий подписочный каталог, Sol/high/direct dynamic tools,
   investigator→reviewer→validator и три исхода на изолированных synthetic данных.
   [Private native probe](runtime/qualification.mjs) проверяет подключение отдельным
   настоящим turn с непредсказуемым oracle; health его не вызывает.
   Нужны реальные runner receipts, точная recipe applicability, replay, restart,
   потеря ACK без повторного start и restore. Старый опыт на другом endpoint или
   fake/unit tests не являются квитанцией этой установленной поставки.
5. Только после принятия квитанции точного состава включить защищённую policy
   для разрешённых owners. Сохранить принятую revision и проверить первый
   разрешённый проход. Наличие настроенного profile не доказывает его квалификацию;
   незавершённая приёмка оставляет admission закрытым.

### Backup, неизвестный исход и первый откат

Backup включает всю БД, installationId/cursorKey и защищённые runtime inputs,
native private state/history с generation mapping, metadata catalog, несекретный
helper state с pending/unknown, runner intents/receipts/tombstones, принятый
source/recipe registry и согласованную Temporal history. Секретные runtime inputs
сохраняются только установленным защищённым способом. Backup Bug Hunt не копирует
OAuth auth.json и не создаёт второй credential owner. Сохранение единственной
авторизации остаётся lifecycle её владельца.

Восстановление проверяется в изоляции: прежние IDs/receipts, scope, grants,
generation/stateRoot, unknown effects и старые v1/v2 запросы должны сохраняться.
Restore одной БД не восстанавливает native state и Temporal. При отсутствии
соответствующих state/history новый model/run start запрещён. Потерянный
thread/turn ACK читается только по прежнему собственному binding; неизвестный
refresh разрешает только read-only recovery нового свежего access. Ни timeout,
ни новое соединение не доказывают отмену уже начатой операции.

Первый путь rollback v3 — выключить новый admission/dispatch и вернуть прежний
принятый API с v3 off. Сначала сверить собственные in-flight checkpoints и
остановить их принятым lifecycle; неясные исходы сохранить unknown. Не удалять
таблицы, originals, evidence, native/helper state, runner tombstones или Temporal
history. Сохранить совместимую возможность дочитать незавершённые histories;
остановка без подтверждения не освобождает допуск на повторный inference.

Rollback программы не откатывает additive schema и не запускает старый migrator
001: его grants несовместимы с новыми таблицами. Возврат v3 требует сверки
прежних effects и повторной приёмки изменённого состава, а не слепого dispatch.
Подробности исходов и ограничений — в [VERIFICATION.md](VERIFICATION.md).

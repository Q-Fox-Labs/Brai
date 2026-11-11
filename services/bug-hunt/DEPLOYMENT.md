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

Откат приложения сохраняет БД и не удаляет миграции. Версия 1 читает схему 1;
следующее изменение до выпуска должно сохранять этот путь либо явно остановить
несовместимый откат. Runtime не удаляет старые обращения при заполнении:
новые запросы получают BUSY, прежние квитанции остаются доступными.
Изменение maxReports не разрешает удалять пользовательские данные.

## Подключения

Codex подключается штатным Streamable HTTP MCP с credential, внесённым
оператором в реестр. Глобальный конфиг не изменяется самим сервисом.
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

Миграция 005 применяется owner-программой без изменения originals/v1/v2.
Поставка включает workflow bundle, worker, runner, schemas и recipes.
Dispatch включается после приёмки immutable поставки, replay и qualification
существующего Codex. Новых профилей авторизации Codex не требуется.
Защищённый registry закрепляет existing Unix endpoint, server/schema generation,
source/recipe hashes, Temporal queue/identity и runner socket.

Worker и runner запускаются отдельно от intake/API и worker v2. Worker видит
существующий native socket, runner — собственные inputs/state и immutable код.
Users/groups, ACL и limits задаёт установщик экземпляра. Процесс с полномочиями
агента не заменяет отдельный runner. Credentials не входят в evidence.

Перед остановкой/откатом выключить verification dispatch и сверить свои
in-flight bindings. Backup БД дополняется native state, runner tombstones,
protected inputs и согласованной Temporal history. Потеря истории не разрешает
новый dispatch вслепую; таблицы и совместимый worker сохраняются.
Подробности: [VERIFICATION.md](VERIFICATION.md).

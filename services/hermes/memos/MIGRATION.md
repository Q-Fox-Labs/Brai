# Перенос владельцев памяти MemOS

Владелец операции — MemOS. Программа migration.py входит в его операторский
lifecycle. Доверенная Ansible-операция запускает её владельцем таблиц
PostgreSQL через защищённый DSN. Identity и пользовательские worker
не получают этот DSN. Программа не вызывает MemOS add, повторное извлечение
фактов или генерацию embeddings.

## Входы

Команда: Python из установленного окружения MemOS с psycopg2,
migration.py --config /absolute/private/config.json --phase PHASE.
Config и freeze marker — root-owned обычные файлы без symlink с правами
0600 или строже. Все каталоги пути принадлежат root и не допускают запись
группе или остальным. DSN не передаётся в аргументах и не печатается.

Config имеет ровно поля:

- version: 1, dsn, schema, runId, freezeFile.
- runtimeRoles: непустой полный список ролей runtime, включая роли шлюзов.
- mapping: объект с Telegram author ID в ключе. Значение содержит ровно
  userId, profileId, homeScope, memoryEpoch, authorId,
  cubes: {"main": "profile-id__main"}.
- quarantine: отдельные userId, profileId, homeScope, memoryEpoch.
- verifiedRows: объект physical memory ID →
  {"authorId":"11","rowHash":"64 lowercase hex","evidenceRefs":["journal reference"]}.

Пользователи, профили и пары scope/epoch уникальны, включая quarantine.
SQL properties.user_id содержит постоянный Brai userId; профиль отдельно
записывается в info.hermes_profile_id. Исходный Telegram author ID сохраняется.
Registry и внешний API используют логические категории. Физическое имя куба
для каждого профиля обязательно равно profileId + '__' + logicalCube.
Mapping.cubes проверяется по этой точной формуле. Общая PostgreSQL остаётся
одной, но MemOS scheduler/enrichment видят в каждом физическом кубе только
память одного профиля. Дополнительно обязательны userId/profile/scope filters.
Карантин использует собственный profileId с тем же namespace; он не остаётся
в legacy cube и не присваивается профилю администратора.
Schema и имена runtime roles допускают [a-z_][a-z_0-9]*; имя schema вместе
с суффиксом _brai_owner должно укладываться в 63 символа PostgreSQL.

## Доказательство владельца

Сначала owner создаёт inventory. Его защищённый файл содержит version: 1,
rows: [{id,rowHash,row}], полные edges и общий sourceHash.
Row — точный результат PostgreSQL to_jsonb(memories row) при UTC.
Hash вычисляется SHA256 UTF-8 канонического JSON с сортировкой ключей,
без ASCII-экранирования и пробелов. Обычные значения сериализуются как
Python json.dumps с ensure_ascii=False и allow_nan=False. Дробные JSONB
numeric читаются как Decimal и записываются без округления в float.
Авторитетный rowHash берётся из inventory, его не пересчитывают через
Node JSON.stringify или обычный Python float parser.

Доверенный preflight сопоставляет реальный sender в Telegram session/journal
всему исходному разговору и его производным фактам, затем формирует verifiedRows.
EvidenceRefs — ссылки проверенных источников, а не текст памяти.
Наличие hermes_author_id, имени или упоминания пользователя недостаточно.
CLI доверяет root-owned аттестации; он не читает Telegram-журналы
и не заменяет проверку provenance.

Row принимается только при совпадении полного hash, author ID и cube mapping.
Явные конфликтующие sender/author ID во вложенных messages дают карантин целиком.
Неизвестные или чужие hermes_source_ids/hermes_source_event и смешанные копии
event/logical ID распространяют карантин на зависимые строки. Программа
не делит смешанный LLM-факт на предполагаемых авторов.
Нестандартные не-объектные properties/info завершают всю фазу отказом;
их исходники не уничтожаются.

## Фазы и транзакции

1. inventory --inventory-output /absolute/private/new-file.json создаёт
   новый root-owned 0600 файл; существующий путь не заменяется.
   Stdout содержит только counts/hash и состояние.
2. plan возвращает counts, sourceHash, configHash, postHash, preflightHash.
   Живые строки и manifest не меняются.
3. Lifecycle останавливает всех писателей и фоновые очереди MemOS, обеспечивает
   отсутствие старых runtime credentials и публикует marker
   {"runId":"same-run","frozen":true}. Это ответственность Ansible;
   marker сам по себе не останавливает процессы.
4. apply --frozen --preflight-hash HASH требует marker, точный hash плана
   и отдельную роль владельца. ACCESS EXCLUSIVE locks на memories и edges
   берутся до повторного чтения и проверки hash. Изменение источника или
   config до применения откатывает всю транзакцию.
5. verify проверяет snapshot, manifest, каждую перенесённую строку,
   исходные сохранённые edges и ACL. Все live edges после apply должны
   соединять существующие rows одного configured user/profile/scope/epoch. Идентичный повтор apply с прежним
   run ID/hash проверяет результат и возвращает прежнее состояние.
6. rollback --frozen --preflight-hash HASH использует исходный hash этого run.
   Он восстанавливает ownership metadata и архивированные edges только
   при полном совпадении перенесённых rows с ожидаемым post-state.
   Помимо hash выполняется точное SQL JSONB сравнение целых rows.
   Удалённая/изменённая строка, изменённое ребро или переиспользованный ID
   прерывает всю транзакцию. Новые edges, затрагивающие старые rows, также
   требуют ручного решения. Новые rows и edges между новыми rows сохраняются.
   Повтор успешного rollback безопасен. Apply этого run после rollback
   запрещён; новый переход требует нового инвентаря и отдельного run. Новый apply с другим run ID при существующем
   состоянии applied отклоняется.

Снимок находится в schema <schema>_brai_owner: memories и edges —
типизированные полные копии с run_id, runs — приватный manifest и hashes.
Embeddings копируются один раз в snapshot, без дублирования внутри manifest.
Snapshot сохраняется после rollback. Ни PUBLIC, ни runtime не имеют доступа
к schema и snapshot tables. Проверяются прямые и эффективные права runtime.
Прямое или наследуемое членство runtime в роли владельца, superuser,
createrole, bypassrls или replication запрещено.
Разделение owner/runtime должно существовать до операции.

Контент, embeddings, created_at и updated_at живых memories не переписываются.
Меняются только properties ownership/scope metadata и физическое имя cube.
Hermes_cube, hermes_memberships и hermes_primary_cube в backend metadata
содержат физические имена; gateway переводит их обратно в логические.
Неизвестные author cube metadata дают карантин, а не общий физический куб.
У quarantine отдельный user/scope, hermes_quarantined: true, без автоматической
выдачи администратору или всем пользователям. Просмотр карантина возможен
только через доверенную owner/admin операцию.
Live edges остаются только между двумя достоверно установленными строками
одного автора. Cross-owner, quarantine и dangling edges остаются в защищённом
snapshot. Все изменения, snapshot и manifest коммитятся вместе.

CLI не печатает DSN, memory IDs, Telegram IDs, тексты или исходную metadata.
Ошибка даёт ненулевой код и безопасный код отказа в stderr.
Защищённые inventory/config/snapshot не входят в Git или результаты пользователя.

## Проверки

node --test services/hermes/memos/tests/migration.test.mjs выполняет Python
unit tests. Реальная PostgreSQL проверка включается только с явным
MEMOS_MIGRATION_TEST_DSN одноразовой синтетической БД. Подключение должно
уметь создавать роли и schema fixture; данные MemOS в эту БД не копируются.
Fixture создаёт случайные собственные schema и runtime role, удаляет только
их, проверяет quarantine/edges, hash drift, freeze, ACL, идемпотентность,
откат с новыми данными и отказ при CAS-конфликте.
MEMOS_MIGRATION_TEST_PYTHON выбирает уже установленный интерпретатор с psycopg2.
Без DSN интеграционные сценарии явно пропускаются;
это не доказательство работоспособности PostgreSQL.

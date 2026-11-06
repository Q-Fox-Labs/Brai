# Перенос legacy владельцев Artifacts

`ownership_migration.py` — чистое ядро отдельной операторской миграции. Оно не импортируется runtime, не является MCP-инструментом и не меняет правило неизменяемого owner обычных операций.

## Источники и назначение

Оператор передаёт typed snapshot таблиц `artifacts`, `artifact_references`, `artifact_output_bindings`, `artifact_relations`, `artifact_links` и root-private mapping пользователей. Автор подтверждается фактическим входящим Telegram journal/FileStore ledger либо записью реального создания в проверенной private native session. Для publish_file одновременно сверяются actual tool call, ID/SHA/bytes ответа, immutable agentPublisher fingerprint, эффективный requestId публикации и createdAt внутри интервала вызова. Повтор старого запроса, fetch, outgoing доставка и UUID в тексте, даже в аттестованной памяти, ownership не доказывают. Неполный набор доказательств остаётся в карантине.

Назначение каждого Artifact должно вести к проверенному userId. Отсутствующая или противоречивая аттестация даёт отдельный непродуктовый quarantine owner, который не совпадает ни с одним реальным пользователем и не подключён к агентскому профилю. Связанный relation-component с различными назначениями целиком уходит в карантин. Неподтверждённые межвладельческие relations и действующие share grants требуют отдельной проверки и останавливают перенос.

Меняются только `owner_id`, `document.artifact.ownerId` и `document.prepareInput.ownerId`. UUID, requestId, upload token, размер, SHA-256, состояния, timestamps и неизвестные поля сохраняются. Файлы `files/{artifactId}` не открываются и не изменяются; повторной публикации и новых Artifact IDs нет.

References/output bindings сохраняют точные исходные ключи и документы в typed snapshot. Их live owner меняется только при отдельном подтверждении owner самого scope и совпадении назначения всех файлов. Неаттестованный scope с чужими либо карантинными файлами удаляется из активной таблицы и остаётся в закрытом архиве. Он не продолжает выдавать чужие IDs обычному агенту прежнего владельца.

## Owner lifecycle

Оператор вызывает `build_plan(snapshot, config)`, затем `migration_sql(plan, phase, runtime_roles)`. Поля config: `runId`, `originalOwnerId`, `quarantineOwnerId`, `allowedOwners`, `accountsHash`, `provenanceHash`, `ownerSoftwareHash`, `assignments`; необязательные `bindingOwners` и `externalOwners` требуют такой же операторской аттестации.

Фазы:

1. Inventory выполняет только repeatable-read SELECT и сохраняет закрытый source snapshot.
2. Plan связывает точные source/accounts/provenance/software hashes с before/after snapshot.
3. Apply требует отдельного разрешения и фактического freeze писателей. Под advisory/table locks сверяются исходные строки; одна транзакция создаёт typed snapshots и manifest, переносит owner и проверяет результат.
4. Verify работает в read-only транзакции и сравнивает точные строки изменяемой области с ожидаемым after snapshot. Только успешная verify позволяет выдать machine receipt.
5. Rollback под freeze сверяет after snapshot и восстанавливает только затронутые IDs/ключи. Новые несвязанные записи сохраняются. Изменённая после переноса строка, занятый прежний ключ или новая зависимость от переносимого файла дают CAS-отказ; чужие новые данные не перезаписываются.

Архив `artifacts_brai_owner` содержит manifest `runs` и `{artifacts,references,outputs,relations,links}_snapshots` с `run_id`, `phase=before|after` и исходными типизированными колонками. Он принадлежит database owner; PUBLIC и runtime roles не получают USAGE/доступ к таблицам. Архив содержит приватные metadata и upload tokens: его нельзя публиковать или копировать в Git.

Повтор уже применённого неизменного plan проверяет after snapshot и возвращает прежний manifest без повторного переноса. Изменённые software/input hashes или состояние manifest дают отказ. Потеря ответа не считается откатом: сначала проверяют manifest и выполняют verify.

## Интеграция оператора

Ansible-адаптер и фактические параметры экземпляра принадлежат Admin. Оператор использует существующий PostgreSQL owner, не выдавая credentials пользовательским процессам. Для DEV root-private inventory, plan и закреплённая копия ядра хранятся в каталоге текущего identity transition; stdout содержит только counts/hash. После quiescence provenance читает только три закреплённые consistent read models: native state.db, Telegram observer.sqlite3 и FileStore files.sqlite. Их SHA и sourceGroupSha256 входят в provenance binding; возврат к свежим transport базам старого HOME закрыт. Перед apply/verify требуется повторный inventory/plan на этих снимках.

Квитанция `brai_artifacts_owner_verify` связывает `accountsPath/accountsSha256`, `ownerSoftwareHash`, `sourceHash`, `postHash`, `currentHash`, `provenanceHash`, закрытые inventory/plan/software paths и hashes, snapshot runId/schema, summary и verifiedAt. Её дата должна следовать реальному maintenance freeze. Квитанция тестового стенда не заменяет owner verify живых данных.

В DEV preflight обнаружены legacy файлы других Telegram пользователей под прежним общим owner. Однозначные источники переносятся с прежними IDs. Неоднозначные источники остаются доступными только административной проверке; сохранение их IDs/байтов не означает разрешение ordinary agent fetch до установления владельца.

## Проверки

Автономные `tests/ownership.test.mjs`/`test_ownership.py` проверяют mapping, сохранение неизвестных metadata, архивирование scope, relation-components и безопасную генерацию SQL.

Отдельная Ansible acceptance поднимает собственную tmpfs PostgreSQL из уже установленного образа и проверяет реальный apply/verify, повтор, runtime ACL, owner API proxy, CAS rollback, сохранение новых записей и неизменность физических synthetic bytes. Живые БД и пользовательские файлы в этот стенд не подключаются; контейнер и временные файлы удаляются в finally.

# Изолированная приёмка artifacts

Набор проверяет собранный кандидат только на отдельном стенде. Он не собирает продукт и не создаёт контейнеры: перед любым запуском менеджер должен передать точный source revision, принять упаковку и конфигурацию экземпляра, а также открыть gate операции 3. Не запускайте scripts до этого gate.

## Закреплённый стенд

Стенд должен иметь собственную сеть `172.30.59.0/24` и отдельные PostgreSQL, NATS, auth, web, agent, artifacts и Caddy. Никакая служба не должна подключаться к production. Публичные тестовые bind адреса — только loopback:

| Назначение | Адрес |
| --- | --- |
| Web и сырой upload `/upload/{token}` | `http://127.0.0.1:13000` |
| MCP Streamable HTTP | `http://127.0.0.1:13005/mcp` |
| Files Caddy для host-agent | `http://127.0.0.1:19080` |
| Локальная выдача test OTP | `http://127.0.0.1:13006` |
| Внутренний metadata URL, доступный host-agent и контейнерам | `http://172.30.59.1:19080` |

Порты PostgreSQL и NATS не публикуются на хост. Входы `BRAI_ACCEPTANCE_*` для них должны быть выданы операцией 2 с минимальными ACL; этот набор не создаёт широкого fixture principal. Fresh-volume init выполняется отдельным явным этапом перед запуском runtime и затем отдельно доказывается по UID/GID и mode. Обычный запуск и восстановление не должны зависеть от init container.

## Этапы

1. Зафиксировать source revision и gate в `BRAI_ACCEPTANCE_SOURCE_REVISION` и `BRAI_ACCEPTANCE_GATE=accepted`. Preflight проверяет значения и loopback origins до сетевого запроса. Не помещайте токены или Cookie в отчёт.
2. Запустить изолированные PG/NATS/auth/web/agent/artifacts/MCP/files Caddy по командам менеджера. Отдельно подготовить auth БД и роли мигратором `node /app/services/auth/dist/migrate.js` с test-only owner URL, именами owner/app ролей, `AUTH_ORIGIN=http://127.0.0.1:13000` и одноразовым `AUTH_SECRET`; мигратор штатный и не вызывает Resend. Auth fixture собирает официальный `createAuth` с PostgreSQL runtime ролью и `runNats` на собственном NATS principal; inbox — `_INBOX.brai_auth`. OTP доставляется только callback-ом в память процесса, а локальный endpoint выдаёт одноразовый код лишь для адресов из явного allowlist с доменом `@brai.invalid`.
3. Указать `BRAI_ACCEPTANCE_ASSET_DIR=tmp/artifacts-root-assets` либо другой каталог только для чтения с `assets-manifest.json`. Этот набор должен включать настоящие `small.png`, `original-large.png`, `sample.pdf`, `sample.wav`, `sample.webm`; harness до запроса проверяет размер и SHA-256 каждого входа. Вызвать `node deploy/tests/artifacts-acceptance/harness.mjs media`. Он использует официальный MCP SDK на настоящем NATS-backed MCP, создаёт objects через `prepare`, отправляет сырой PUT `/upload/{token}`, затем сверяет metadata, SHA-256 и байты через files Caddy. После проверки удаляет только собственные artifacts. Результат — JSON без токенов в `tmp/`.
4. Отдельно проверить браузерный flow по [browser-checklist.md](browser-checklist.md), используя собственный Chrome `isolatedContext` и передавая `pageId` каждой операции. Загрузки/ошибки ограничить тестовым пользователем и тестовыми объектами.
5. Выполнить эксплуатационные проходы из плана в итоговом отчёте менеджера: UUID route GET/HEAD/range/conditional работает после остановки только controller, PG и NATS; перезапустить только files Caddy без volume init. Затем повторить те же запросы и сверить хеш.
6. Измерить обычную выдачу Caddy и UUID route из того же тома. Согреть оба маршрута; повторить попарно несколько раз на одном наборе файлов и сравнить медианы. Разделить RSS/heap и page cache. Кандидат проходит при деградации медианы не больше 10%.
7. Для crash/ENOSPC/timeout указать уже принятые core proofs, их точные условия и ссылки на постоянные тесты/контракты; повторять их при изменении соответствующего runtime. На общем стенде реально проверить отключение controller/PG/NATS, перезапуск files Caddy и удаление тестового файла без ложного успеха. Обрывы upload проверять только на собственных bounded данных. Не использовать production адреса.
8. Создать внешнюю ссылку только после явной тестовой конфигурации внешнего loopback URL. В обычной конфигурации проверить `SHARING_NOT_CONFIGURED` и отсутствие rows в `artifact_links`; затем проверить expiry/revoke/delete на выделенном test address и снова выключить sharing.
9. Удалить только файлы и данные этого run ID, сохранить полный отчёт в `tmp/` до проверки менеджером и передать номер кандидата и ограничения.

До запуска стенда выполните offline guard `node deploy/tests/artifacts-acceptance/native-schema-guard.mjs`. Он компилирует все request/result schemas, используемые native fixture, отдельные native v1 `InitializeParams`/`InitializeResponse` и self-contained v2 schemas, а также OpenRPC/product notification contracts. Guard проверяет полные canned initialize/account/config/model/thread ответы, image data URL и `localImage` path в `turn/start`/`turn/steer` и `userMessage` history с точными `clientId`, start/steer и turn/item events; проверяет точный MCP tool surface, Prepare/Get/Link request fields и допустимый успех SDK без `isError: false`. Guard не открывает socket, БД или NATS.

`native-fixture.mjs` требует явный абсолютный `BRAI_NATIVE_SCHEMA_DIR` с proof схемы установленного Codex 0.160.0 и проверяет agent по его OpenRPC/schema. Initialize schemas берутся из самостоятельных native v1 файлов; остальные использованные native schemas — из self-contained файлов `v2/`, а не из aggregate v2 definitions. Это schema-checked Unix WebSocket fake для Codex 0.160.0. Он сохраняет test threads/items в выделенном durable каталоге и поддерживает startup account/config/model/thread calls, создание и возобновление thread, history read/list, goal/settings, `turn/start`, `turn/steer` и события хода. Он явно не исполняет модель и не заменяет живой inference.

При длинном пути worktree задайте `BRAI_NATIVE_FIXTURE_SOCKET=/tmp/brai-native-<runId>/codex-v160.sock`. Родительский каталог заранее создаёт операция стенда с владельцем fixture и режимом `0700`; fixture проверяет владельца, режим и предел Unix socket менее 108 байтов. Durable threads остаются в каталоге run ID. Fixture сохраняет nullable goals, использует целые Unix seconds и возобновляет оставшееся время активного хода без повторного добавления input.

До запуска `harness.mjs` должны быть переданы `BRAI_ACCEPTANCE_GATE=accepted`, точный `BRAI_ACCEPTANCE_SOURCE_REVISION`, уникальный `BRAI_ACCEPTANCE_RUN_ID` и явные адреса test database/NATS с ACL операции 2. Auth fixture требует выданные operation 2 имя отдельной тестовой базы, runtime URL/app role, свой NATS URL/principal и явный список test email. Никакие credentials не печатаются или записываются в отчёты.

Все временные файлы должны быть внутри worktree `tmp/artifacts-acceptance/` либо явно переданного каталога того же run. Никогда не используйте `HOME`/`CODEX_HOME`, `.env` файлы или git-tracked reports для состояния теста.

Для памяти записывайте process RSS controller и files Caddy через фактический `/proc/<pid>/status` или `docker top`/`docker stats` с пояснением поля. Node heap допустимо снимать отдельным fixture wrapper через `process.memoryUsage()`. Page cache считайте отдельно по файловой системе/ядру; не приравнивайте Docker memory usage к RSS. Сравните контрольный процесс на пустом прогретом стенде и передачу крупных файлов, чтобы увидеть рост heap относительно размера файла.

# Agent

Отдельная программа соединяет web через NATS с существующим Codex app server. История и выполнение принадлежат Codex; своей БД и очереди заданий нет.

## Запуск

Из корня: `npm ci`, `npm run build:agent`, затем `BRAI_AGENT_CONFIG=/absolute/config.json npm start --workspace=@brai/agent`. Конфигурация содержит `codex.socketUrl`, `nats.servers`, настроенные `projects` с `projectId/name/cwd`, необязательные `allowedModels` и `newThread.model/approvalsReviewer`. Credentials задаются явно в защищённой конфигурации. Сборка и запуск не читают admin. Health: `BRAI_AGENT_CONFIG=/absolute/config.json npm run health --workspace=@brai/agent`.

## Контракт

NATS Services `brai_agent`, версия2.0.0, endpoint `brai.agent.v2.rpc`. Запросы описаны в [AsyncAPI](asyncapi.json) и [JSON Schema](schemas/messages.schema.json). Действия: `projects`, `status`, `threads`, `create`, `open`, `turns`, `items`, `activities`, `item`, `start`, `steer`, `interrupt`, `answer`. Ответ успешной мутации содержит `outcome=accepted` и исходный `operationId`. Ошибки используют стандартные NATS Service Error headers; `outcome` различает `not-sent`, `unknown`, `query`. Неизвестный исход нельзя автоматически повторять.

`generation` защищает мутации от старого исполнителя. Одинаковый operationId возвращает исходный результат; другое содержимое отклоняется. Ledger ограничен и живёт только в текущем поколении. Разрешены только настроенные проекты и модели; произвольного RPC proxy нет. Мутация не ждёт завершения хода.

Core NATS `brai.agent.v2.event` передаёт только AG-UI `STATE_SNAPSHOT`: полное ограниченное представление сообщений и идентификаторов действий и ожидающих запросов, с project/thread/generation/epoch/seq. Внутри того же generation/epoch любой больший seq заменяет состояние целиком: промежуточные снимки можно объединять. После нового поколения/epoch читают `open`; автоматического turn/start нет. Сохранённую историю читают native `turns/items`, передавая непрозрачный cursor.

Четыре формы: команда, изменение файлов, дополнительные разрешения, вопрос. Ответ проверяется исходной native schema до first-wins claim; stale/неизвестные запросы не подтверждаются. Raw reasoning, binary/media и секреты профиля не передаются. Публичная краткая reasoning summary доступна только в раскрытом действии. `phase`, статус и код выхода сохраняются; сокращение обозначается явно.

Размеры и ёмкости экспортированы из `@brai/agent/contracts`. При переполнении интерфейс получает отказ либо восстановление снимка. Brai не выбирает замену модели; для созданных им чатов provider fallback отключён. Для прежних чатов настройкой fallback владеет Codex. Остановка agent закрывает его подключения; Codex daemon остаётся владельцем собственного выполнения.

## Проверки

`npm run typecheck:agent`, `npm run test:agent`, `npm run build:agent`. Unit проверки не используют аккаунт, сервер Codex или модель. Upstream wire schemas закреплены в [contracts/codex](contracts/codex/README.md); обновление требует проверки фактического протокола, а не собственного форка.

`models` возвращает до100 видимых native моделей, их `efforts/defaultEffort`, названия и configured `defaultModel`; configured `allowedModels` ограничивает каталог и исполнение. Результат кэшируется только в поколении Codex. `create` принимает optional `model`; `start` — optional `model/effort`. Явный выбор проверяется по каталогу до native мутации. Значения передаются напрямую в thread/start и turn/start и становятся штатными default для следующих ходов. Steer не меняет настройки. Snapshot thread metadata может содержать `reasoningEffort` и фактический model из resume/принятого start. Наличие в каталоге само по себе не подтверждает доступ к inference.

`create/start.permissionMode` — `ask|auto|full`, default `auto`. Native mapping: ask = on-request/user/workspace-write; auto = on-request/auto_review/workspace-write; full = never/user/danger-full-access. Для turn/start workspaceWrite ограничен configured cwd, networkAccess=false. Профиль применяется только к новому заданию, без изменения global config.toml. Pending approvals проходят native reviewer; браузер не отвечает автоматически. Произвольные permission/sandbox поля не допускаются.

## Ленивое чтение действий и активность

`open`, `items` и события передают текст сообщений пользователя/агента. Остальные записи содержат только `id/turnId/type/text:""`, optional `status/exitCode/revision`; command, output, diff и summary отсутствуют. Browser не получает тела скрытых действий. Native history содержит тела, поэтому backend читает их у Codex, но не отправляет до раскрытия.

`activities` принимает `projectId/threadId/turnId/itemIds`: от 1 до 100 уникальных IDs. Ответ `{generation,data:DisplayItem[]}` сохраняет порядок запроса и содержит заголовки `summary` до 256 UTF-8 bytes, пустой text и состояние. `item` принимает `projectId/threadId/turnId/itemId`; ответ `{generation,item:DisplayItem}` содержит display body. Чтения не запускают ход; generation фиксируется до чтения, смена поколения даёт `STALE_GENERATION` с outcome query. Не найденный item/turn даёт `NOT_FOUND`. Повтор чтения безопасен. Для старых действий используется native exclusive anchor: predecessor затем ascending page; live cache ограничен 128 отображёнными элементами на session и существующими пределами display полей. Raw reasoning/media не возвращаются. Длинные поля сокращаются с явным маркером, как прежде.

`revision` — seq изменения live item; для сохранённого item без live версии — 0. Изменение вывода обновляет revision, сохраняя скрытое представление. `timestamp` сообщений и `thread.lastMessageAt` используют Unix milliseconds; native `updatedAt` остаётся Unix seconds. Native startedAtMs, затем completedAtMs определяют время сообщения; для старых записей без времени fallback — updatedAt*1000. Live сообщение фиксирует время первого наблюдения, delta/command/plan его не меняют. `thread.active` отражает native active или ход inProgress; потеря соединения выключает live индикатор.

`threads` запрашивает native updated_at desc, затем сортирует страницу по времени сообщения и ID. Для определения времени проверяет до десяти native страниц по 100 items на чат, параллельно не более четырёх чатов; результаты кэшируются по native updatedAt, до 1000 чатов на generation. Если сообщения нет в этом ограниченном окне, lastMessageAt=0. Native continuation cursor сохраняется: порядок всех загруженных страниц уточняет потребитель. Авторизация и доступ проектов остаются на существующей web/NATS границе; новые чтения не обходят проверку configured cwd.

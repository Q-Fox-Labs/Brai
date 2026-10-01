# Agent

Отдельная программа соединяет web через NATS с существующим Codex app server. История и выполнение принадлежат Codex; своей БД и очереди заданий нет.

## Запуск

Из корня: `npm ci`, `npm run build:agent`, затем `BRAI_AGENT_CONFIG=/absolute/config.json npm start --workspace=@brai/agent`. Конфигурация содержит `codex.socketUrl`, `nats.servers`, настроенные `projects` с `projectId/name/cwd`, необязательные `allowedModels` и `newThread.model/approvalsReviewer`. Credentials задаются явно в защищённой конфигурации. Сборка и запуск не читают admin. Health: `BRAI_AGENT_CONFIG=/absolute/config.json npm run health --workspace=@brai/agent`.

## Контракт

NATS Services `brai_agent`, версия2.0.0, endpoint `brai.agent.v2.rpc`. Запросы описаны в [AsyncAPI](asyncapi.json) и [JSON Schema](schemas/messages.schema.json). Действия: `projects`, `status`, `threads`, `create`, `open`, `turns`, `items`, `start`, `steer`, `interrupt`, `answer`. Ответ успешной мутации содержит `outcome=accepted` и исходный `operationId`. Ошибки используют стандартные NATS Service Error headers; `outcome` различает `not-sent`, `unknown`, `query`. Неизвестный исход нельзя автоматически повторять.

`generation` защищает мутации от старого исполнителя. Одинаковый operationId возвращает исходный результат; другое содержимое отклоняется. Ledger ограничен и живёт только в текущем поколении. Разрешены только настроенные проекты и модели; произвольного RPC proxy нет. Мутация не ждёт завершения хода.

Core NATS `brai.agent.v2.event` передаёт только AG-UI `STATE_SNAPSHOT`: полное ограниченное представление native items и ожидающих запросов, с project/thread/generation/epoch/seq. Внутри того же generation/epoch любой больший seq заменяет состояние целиком: промежуточные снимки можно объединять. После нового поколения/epoch читают `open`; автоматического turn/start нет. Сохранённую историю читают native `turns/items`, передавая непрозрачный cursor.

Четыре формы: команда, изменение файлов, дополнительные разрешения, вопрос. Ответ проверяется исходной native schema до first-wins claim; stale/неизвестные запросы не подтверждаются. Raw reasoning, binary/media и секреты профиля не передаются. Публичная краткая reasoning summary доступна как текст. `phase`, статус и код выхода сохраняются; сокращение обозначается явно.

Размеры и ёмкости экспортированы из `@brai/agent/contracts`. При переполнении интерфейс получает отказ либо восстановление снимка. Brai не выбирает замену модели; для созданных им чатов provider fallback отключён. Для прежних чатов настройкой fallback владеет Codex. Остановка agent закрывает его подключения; Codex daemon остаётся владельцем собственного выполнения.

## Проверки

`npm run typecheck:agent`, `npm run test:agent`, `npm run build:agent`. Unit проверки не используют аккаунт, сервер Codex или модель. Upstream wire schemas закреплены в [contracts/codex](contracts/codex/README.md); обновление требует проверки фактического протокола, а не собственного форка.

# Модули программы agent

Публичная граница закреплена в [README](README.md), DTO и AsyncAPI. Здесь описаны обычные вызовы внутри одной программы, без внутреннего RPC.

## Владельцы и порты

`state.ts` единолично владеет загруженными сеансами, active turn, pending requests, журналом неизменяемых операций и границей generation/streamEpoch/seq. История принадлежит Codex; состояние не содержит второго постоянного журнала. `projection.ts` преобразует наблюдения и меняет проекцию только через функции владельца состояния.

`ports.ts` задаёт `CodexPort`: `connect()`, `call(method, params, {mutation, timeoutMs})`, `respond(rawRequestId, answer)`, `subscribe(listener)`, `status()` и `close()`. Вызовы возвращают Promise; подписка возвращает функцию отключения. Наблюдение различает notification, request и connection. RPC ID остаётся строкой или числом upstream. Ошибка содержит безопасные code/outcome и факт отправки; транспорт никогда не повторяет мутацию. `status()` возвращает только generation, connection и authorization, без upstream account.

`application.ts` предоставляет сценарии subjects владельца: projects/status/threads/thread/history/create/start/steer/interrupt/respond. Входы и выходы — DTO контракта. Ядро получает CodexPort, конфигурацию проектов, state и преобразование проекции явно; не импортирует WebSocket, NATS или UI. Проверяет project/cwd, поколения, операции и исходные запросы. Локальное первое решение формы фиксируется до отправки upstream.

`history.ts` читает ограниченные страницы turns/items через порт, сохраняет порядок и ID, выдаёт курсор и явно сокращённые элементы. Не использует deprecated includeTurns или внутренние файлы Codex. Raw reasoning content не возвращается; допустимы только upstream summaries.

`projection.ts` принимает наблюдение Codex и сеанс владельца, возвращает конечные изменения и проверенные AG-UI события. Завершённый item заменяет дельты. Snapshot имеет одну синхронную границу seq; публикация не ждёт браузера. Переполнение явно требует нового снимка.

`nats.ts` проверяет DTO, вызывает application, проверяет ответ и публикует проверенные envelopes через ограниченную очередь. Реализует NATS Services discovery/error headers. `main.ts` собирает зависимости и освобождает только собственные ресурсы. `config.ts` принимает явные проекты, socket и NATS inputs; экземпляр не зашит в продукт.

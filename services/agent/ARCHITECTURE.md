# Архитектура agent

Один процесс, пять модулей. `main` собирает зависимости и предоставляет NATS Services/Core NATS. `codex` владеет одним WebSocket, поколением, сопоставлением RPC и native schema checks. `application` владеет ограниченной проекцией, pending requests и operation ledger; принимает закрытые сценарии. `display` преобразует native items для live и history. `health` читает status через NATS.

История, контекст и инструменты принадлежат внешнему Codex app server. Между локальными модулями обычные вызовы и подписка наблюдений. Web импортирует только публичный контракт. Нет message/tool lifecycle engine, второй истории, собственного исполнителя или межмодульного RPC.

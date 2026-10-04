# Архитектура agent

Один процесс, пять модулей. `main` собирает зависимости и предоставляет NATS Services/Core NATS. `codex` владеет одним WebSocket, поколением, сопоставлением RPC и native schema checks. `application` владеет ограниченной проекцией, pending requests и operation ledger; принимает закрытые сценарии. `display` преобразует native items для live и history. `health` читает status через NATS.

История, контекст и инструменты принадлежат внешнему Codex app server. Между локальными модулями обычные вызовы и подписка наблюдений. Web импортирует только публичный контракт. Нет message/tool lifecycle engine, второй истории, собственного исполнителя или межмодульного RPC.


Режимы используют native collaboration settings. Goal/set владеет продолжениями и счётчиками цели; application только задаёт settings, goal и interrupt в явном сценарии с unknown после частичного эффекта. Native история хранит предложенные plan items. Turn/plan/updated остаётся ограниченной живой проекцией, отдельной от документа; отсутствие восстановления шагов обозначается явно. Новых процессов, хранилищ или циклов исполнения целей нет.

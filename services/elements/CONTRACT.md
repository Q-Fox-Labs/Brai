# Контракт Elements v1

`service_elements` владеет собственной PostgreSQL-схемой `elements`. Он не читает базы Web, History или Alerts. Web и Agent обращаются к сервису через NATS Services и MCP.

## Структура

Element имеет фиксированный тип `level`, `mission`, `quest`, `goal` или `task`. Родитель допускается только по цепочке Level → Mission → Quest → Goal → Task. Для активации контейнер должен иметь от 2 до 6 прямых дочерних элементов. Каждая ревизия описания неизменяема.

Move имеет тип `action` или `operation`, обязательную JSON Schema результата и связи `launch`, `input`, `output` или `accept`. Связи указывают конкретную ревизию Element. `launch` и `accept` разрешены только для Operation. Element закрывает только успешная Operation с ролью `accept`.

## Выполнение

`claim` создаёт одну активную попытку. `complete` проверяет результат по JSON Schema и принимает его только после успешной проверки. `fail` сохраняет ошибку и возвращает Move в `planned`. Повтор `claim` с тем же `idempotency_key` возвращает первоначальную попытку. Повтор завершённой попытки возвращает её первоначальный результат.

## NATS Services

| Subject | Назначение |
| --- | --- |
| `brai.elements.v1.query.graph` | карта Elements, Moves и связей |
| `brai.elements.v1.query.timeline` | лента попыток |
| `brai.elements.v1.query.element` | элемент и его текущая ревизия |
| `brai.elements.v1.query.moves` | доступные Moves |
| `brai.elements.v1.command.create` | пакетное создание структуры |
| `brai.elements.v1.command.revise` | новая ревизия Element |
| `brai.elements.v1.command.claim` | начало попытки |
| `brai.elements.v1.command.complete` | принятие результата |
| `brai.elements.v1.command.activate` | проверка и активация |

Все запросы ограничены доверенным владельцем, переданным сервером Web. MCP игнорирует `user_id` из аргументов модели и использует `ELEMENTS_MCP_OWNER_ID`.

## Events

Outbox публикует события в JetStream stream `BRAI_ELEMENTS_EVENTS_V1`, subject `brai.elements.v1.events.<event_type>`. Stream и durable consumers `history_elements_events` и `alerts_elements_events` создаёт инфраструктура; Elements проверяет их конфигурацию при запуске. Publisher повторяет публикацию с прежним `event_id` до PubAck. Потребители обязаны ACK только после commit и безопасно обрабатывать повтор.

Потребители History и Alerts являются отдельными адаптерами; Elements не открывает их базы и не вызывает их внутренний код.

# ABOUTME: Описывает переносимые NATS identities и минимальные ACL artifacts.
# ABOUTME: Не подключает операторский overlay и не содержит secret values.

# Candidate ACL artifacts

Действующий `nats.conf` остаётся конфигурацией v2. Отдельный операторский ACL
подключается только при согласованном совместимом переключении web и agent на
v3. До этого overlay выключен; этот документ не является конфигурацией брокера.

Защищённый внешний ввод брокера содержит два дополнительных пароля:

- `NATS_ARTIFACTS_SERVICE_PASSWORD` — principal NATS Service `artifacts`.
- `NATS_ARTIFACTS_MCP_PASSWORD` — отдельный клиентский principal `artifacts_mcp`.

Runtime artifacts получает `NATS_USER=artifacts` и `NATS_PASSWORD` через собственный
защищённый ввод; MCP получает `NATS_USER=artifacts_mcp` и `NATS_PASSWORD` отдельно.
MCP нужны только NATS и явные HTTP allowlists; ему не нужны URL БД и файловый том.
Учётные данные существующих web и agent передаются отдельными защищёнными входами.
Пароли не создаются конфигурацией, не хранятся в Git и не выводятся при проверке.

Минимальные разрешения дополнительных клиентов:

- web публикует `prepare`, `get`, `relation.add`, `reference.list` artifacts.
- agent публикует `get`, `relation.list`, `reference.reserve`, `reference.get`,
  `reference.confirm`, `reference.list`, `reference.update-state` artifacts.
- MCP публикует ровно 16 subjects artifacts и подписывается только на собственный inbox.
- artifacts подписывается на те же 16 subjects, собственный inbox и discovery
  собственного NATS Service; обычные публикации запрещены, разрешены ограниченные
  ответы на запросы.

Точные subjects принадлежат [контракту artifacts](../../services/artifacts/asyncapi.yaml).
Собственные inbox prefixes должны совпасть с ACL. Новые разрешения не открывают
JetStream или subjects чужих сервисов. Прежние разрешения auth/timer и согласованные
RPC/event subjects agent сохраняются только в объёме их собственных контрактов.

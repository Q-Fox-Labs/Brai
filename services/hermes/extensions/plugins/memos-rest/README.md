# MemOS REST

Подключает штатный MemoryProvider к существующему MemOS; кубы не создаёт, deployment/БД/модели не меняет. Без routing_enabled старый JSON остаётся legacy. Живые настройки — HERMES_HOME/memos-rest.json, каталог — memos-catalog.json.

| Настройка/диагностика | Читать |
|---|---|
| Multi-cube, каталог, epoch/phase, writer/router/bridge | [Запись и маршрутизация](docs/routing.md) |
| Recall/tools, Telegram Business/приватность | [Чтение и доступ](docs/privacy.md) |
| Admin purge/handoff, границы, проверки/ограничения | [Администрирование](docs/admin.md) |

Неразрушительное обслуживание привязано к user_id и scope_profile живого профиля, а также полному набору managed cubes. Прежние purge/handoff остаются только default/root. Отдельный handoff-empty передаёт строго пустую frozen область в production без удаления и разблокировки массовой очистки. frozen/disabled/suspended/epoch и backend-права проверяй отдельно. Создание куба/конфигурация/HTTP 200 не доказывают реальную доставку, recall или очищение. Документация не разрешает очистку/разблокировку; действует MEMORY_POLICY.md. Секреты/переписку в комплект не копируй.

# Codeworks

Codeworks хранит рабочие области и выполняет операции с ветками, GitHub, CI и
выпусками. Codex работает штатно, без запуска через Codeworks и посредника
для файлов или команд. Чтение и диагностика доступны независимо от сервиса.

Перед первой правкой кода агент создаёт область с коротким названием задачи
в workspace_key, например codeworks-auto-cleanup; ветка будет feature/codeworks-auto-cleanup.
UUID и хэши не используются как названия новых веток. Фича начинается от DEV,
хотфикс — от установленного PROD. Все итерации проходят в своём дереве.
После явного «принято» в чате агент вызывает release. Успешный CI обязателен
для слияния и установки; кеши и готовые артефакты переиспользуются по хэшам.

```sh
codeworks --request-json '{"action":"prepare","project_id":"brai","workspace_key":"my-task","kind":"feature","request_key":"my-task-prepare"}'
codeworks --request-json '{"action":"status","project_id":"brai","workspace_key":"my-task"}'
```

Дождитесь ready, затем используйте возвращённый path обычными инструментами.
Для sync/release нужны workspace_id, точный commit_sha и стабильный request_key;
после успешного выпуска cleanup ставится автоматически. Его идентификатор —
cleanup_operation_id в статусе выпуска. Если очистка сохранила дерево с ошибкой,
устраните причину и повторите cleanup с новым request_key. Справка и схемы:
`codeworks --help`, `codeworks --schema`.

Подключение: CODEWORKS_CLIENT_CONFIG — публичный JSON с server, credsFile,
executorId. credsFile указывает существующий защищённый NATS options JSON
(servers, user, pass, inboxPrefix) либо стандартный .creds. CODEWORKS_NATS_URL,
CODEWORKS_NATS_CONFIG / CODEWORKS_NATS_CREDS_FILE и CODEWORKS_EXECUTOR_ID
перекрывают соответствующие значения. Credentials в запросы не включаются.

Небольшой хук помогает при забытом переходе в дерево; его ошибки не блокируют
чтение. Настройка RTK сохраняется. Глобальное подключение хука и включение
службы выполняются отдельно после согласования.

[Контракт и переход](CONTRACT.md) · [Кеши и CI](ci/README.md)

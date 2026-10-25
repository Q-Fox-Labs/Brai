# Codeworks: техническое устройство

Codeworks хранит рабочие области и координирует операции с Git, GitHub, CI и выпусками. Он не запускает агента и не меняет его разрешения.

[Контракт](CONTRACT.md) описывает lifecycle и API; [дескрипторы компонентов](components/README.md) — discovery, проверки, сборку и поставки; [CI](ci/README.md) — доказательства происхождения артефактов; [Temporal](TEMPORAL.md) — исполнение, восстановление и обновление.

## Клиент и конфигурация

CLI предоставляет prepare, status, sync, release, cleanup, lifecycle.status, release.close и workspace.cancel. Схемы доступны через --schema, справка — через --help. После изменяющего запроса клиент сохраняет ID операции и читает status; неизвестный исход не разрешает повтор с новым ключом.

CODEWORKS_CLIENT_CONFIG указывает JSON с server, credsFile и executorId. credsFile ссылается на защищённый NATS options JSON либо .creds. Переменные CODEWORKS_NATS_URL, CODEWORKS_NATS_CONFIG / CODEWORKS_NATS_CREDS_FILE и CODEWORKS_EXECUTOR_ID переопределяют соответствующие значения.

## Политика проекта

Регистрация проекта задаёт допустимые пути, Git flow и исключения documentation_paths. Каталог в исключениях охватывает вложенные файлы; обычный файл — только его путь. Hook использует ту же политику для распознанных правок. Смешанная правка исключённого документа и защищённого кода требует рабочей области.

Это возможности механизма. Обязанности агента, порядок приёмки и настройки конкретной команды задаются вне продуктового контракта.

## Связанные материалы

- [CONTRACT.md](CONTRACT.md).
- [ci/README.md](ci/README.md).
- [components/README.md](components/README.md).

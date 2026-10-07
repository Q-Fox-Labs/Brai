# Local-ai: сборка и запуск

Поставка использует заранее собранный payload. Dockerfile не устанавливает пакеты и не скачивает код, веса или ключи. Контекст создаёт Ansible во временном каталоге; он не строится из основной рабочей копии и не хранится в Git.

## Содержимое контекста

Контекст сборки содержит только:

- `services/local-ai/Dockerfile` и `services/local-ai/Dockerfile.dockerignore`, скопированные из продукта;
- `payload/app/` — готовое приложение с исходниками запуска, `dist`, контрактами, схемами, профилями, `services/local-ai/migrations/001.sql` и фактическим production dependency closure в `app/node_modules`;
- `payload/runtime/` — подготовленные Node.js, llama.cpp, Python, виртуальная среда GigaAM, FFmpeg/ffprobe и необходимые системные библиотеки;
- `payload/hf-modules-cache/` — проверенный dynamic-code cache Transformers для закреплённой ревизии GigaAM;
- `payload/SHA256SUMS` — SHA-256 inventory всех остальных файлов в `payload/`.

`payload/runtime` копируется в `/opt/brai/local-ai/runtime`, `payload/app` — в `/opt/brai/local-ai/app`, а dynamic-code cache — в приватный каталог `HF_MODULES_CACHE`. Образ сохраняет `release.json` и `payload.SHA256SUMS` для происхождения и сверки содержимого. Подготовитель обязан записать и проверить SHA-256 каждого файла; он не копирует виртуальную среду или динамическую библиотеку, ссылающуюся на host path. Каталоги библиотек, включённые в payload, задают абсолютные пути из `LD_LIBRARY_PATH` образа.

Базовый образ передаётся обязательным build argument `BRAI_LOCAL_AI_BASE` со значением из `release.json`: Ubuntu 24.04 `linux/amd64` по immutable manifest digest. Dockerfile отклоняет другое значение. Digest и glibc 2.39 подтверждены метаданными [официального Docker Hub manifest](https://hub.docker.com/layers/library/ubuntu/noble-20260911/images/sha256-496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4); точный образ и portable payload кандидата отдельно прошли изолированную приёмку. Обязательный `BRAI_SOURCE_REVISION` задаёт один полный принятый Git checkpoint для всего compiled product snapshot и тот же revision в OCI label. Foundation basis в descriptor не заменяет этот вход и не идентифицирует payload. Для сборки Ansible копирует Docker-файлы и descriptor в контекст и запускает Docker с этим контекстом; в рабочем checkout не устанавливают Node/npm-пакеты и не собирают Docker-образ.

Dockerfile сам по себе не подтверждает готовый образ или ABI-совместимость. Для проверенного кандидата из [KNOWN_ISSUES.md](KNOWN_ISSUES.md) приняты точные runtime/context hashes и изолированная функциональная матрица; проверка production остаётся отдельным этапом выпуска.

## Конфигурация и запуск

Процесс запускается как UID/GID `1000:1000` из `/opt/brai/local-ai/app/services/local-ai`. Он требует `LOCAL_AI_CONFIG_JSON` со всеми закрытыми разделами, которые проверяет `src/main.mjs`: `postgres`, `nats`, `transport`, `artifacts`, `installer`, `lifecycle`, `runtime`. Все поля обязательны по контракту конфигурации; неизвестные поля и неверные типы завершают запуск. Конкретные адреса, секреты и числовые лимиты задаёт защищённая конфигурация экземпляра после измерений. Образ не содержит её и не задаёт значения по умолчанию.

`runtime.llama_cpp` должен ссылаться на `/opt/brai/local-ai/runtime/llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/app/llama-server`. `runtime.gigaam_pytorch` использует `/opt/brai/local-ai/runtime/gigaam_pytorch/.venv/bin/python` и runner из `/opt/brai/local-ai/app/services/local-ai/runners/gigaam/runner.py`. Runtime factory передаёт дочернему процессу только `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL` и `LC_CTYPE`, а остальные переменные берёт из profile config. Поэтому `runtime.*.env` явно задаёт `LD_LIBRARY_PATH`, `HF_HOME` и `HF_MODULES_CACHE`; `PATH` включает payload FFmpeg. В image `LD_LIBRARY_PATH` включает каталоги `app` и `system` закреплённого llama.cpp payload, а также подготовленные Python/torch/system library каталоги. Список допустимых переменных ограничен кодом сервиса.

Постоянный каталог установки весов — `/var/lib/brai/local-ai/models`. Seed-каталоги и служебный VAD подключают отдельно. Они не входят в image. Каталоги `home`, `models`, `staging`, `tmp` и `/var/tmp/brai-local-ai` доступны UID 1000. HF cache располагается внутри приватного `home`; ambient root cache и `HF_TOKEN` не используются.

Запуск сервиса не применяет миграции и не загружает модели. SQL миграции должен присутствовать по пути `/opt/brai/local-ai/app/services/local-ai/migrations/001.sql`: standalone migration module читает этот файл относительно `dist/storage/migrate.js`. Перед первым запуском оператор отдельно выполняет миграцию тем же образом с отдельным защищённым окружением:

```text
/opt/brai/local-ai/runtime/node-v24.21.0-linux-x64/bin/node /opt/brai/local-ai/app/services/local-ai/dist/storage/migrate.js
```

Это окружение содержит `LOCAL_AI_DATABASE_URL`, `LOCAL_AI_OWNER_ROLE` и `LOCAL_AI_APP_ROLE`. Оно не использует `LOCAL_AI_CONFIG_JSON` и не получает runtime credentials приложения. Оркестратор обязан монтировать постоянные model/cache каталоги и выдавать контейнеру только необходимые подключения к PostgreSQL, NATS и внутреннему artifacts/history. Секреты передаются через защищённый механизм окружения, а не через image, release descriptor или command line.

## Готовность и остановка

Docker HTTP healthcheck не объявлен: у сервиса нет HTTP health endpoint. NATS Services PING подтверждает ответ процесса, но не готовность зависимостей. Проверяйте `brai.local_ai.v1.status`: сервис готов только при общем `state: "ready"` и состояниях `ready` у `database`, `nats`, `executables`, `weights`. Загруженная модель для готовности не обязательна; idle/unloaded — нормальное состояние.

SIGTERM и SIGINT обрабатывает управляющий процесс. Он прекращает приём запросов, закрывает installer и lifecycle, ждёт дочерние процессы и закрывает NATS/PostgreSQL в заданный конфигурацией срок. Числовые сроки и измеренные ASR пределы не задаются этим документом.

## Модели и измерения

В образ не включают веса, пользовательские данные или секреты. Подготовленные seed revisions, размеры, пути и GGUF hash перечислены в `release.json`. Служебный segmentation VAD находится отдельно от четырёх файлов модели GigaAM.

Кандидат source `57b1b3432f6dc02d5c6852f6fa2139248ed5e80e`, image `sha256:0f41020141723ab487b99d6fc354af048316655ac3911ce772774f23b07ff764` прошёл изолированную runtime-приёмку: short/long ASR, четыре формата, ровно 180 секунд и превышение на кадр, FFmpeg и подтверждённый выход групп процессов. Проверенный профиль сохраняет предел аудио 180 секунд и decode timeout 30 секунд. Эти результаты относятся к точному кандидату; состояние рабочего выпуска указано в [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

История отправляется одним Core NATS publish без reply и повторов. `config.history` и `postgres.outboxCapacity` удалены. Пропуски при разрыве или заполнении SDK буфера учитываются в `runtime.history.diagnostics()`; history не участвует в readiness. Прежняя таблица outbox остаётся неиспользуемой для отката.

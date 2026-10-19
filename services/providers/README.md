# Providers runtime

Одна Node.js 24 программа владеет NATS v1, внутренним HTTP, PostgreSQL
ledger, Артефактами и наблюдаемостью. Штатный LiteLLM 1.104.2 выполняет
адаптацию моделей. CONTRACT.md и HTTP.md задают поддержанный интерфейс.

`release.mjs check-source <40-char SHA>` проверяет принятую ревизию и
готовые зависимости package-lock. `release.mjs materialize <SHA> <output>`
собирает только providers, копирует замкнутый runtime без симлинков и
публичный контракт Артефактов, создаёт SHA256 manifest и делает файлы
read-only. Установок пакетов, скачиваний и миграций сборка не выполняет.
Команду запускают из корня принятого checkout; допустимое назначение
задаёт явный операционный выпуск. Runtime запускают `node services/providers/dist/main.js`.
Миграции 001–003 выполняют явно от owner до start; runtime имеет только DML.

Конфигурация: NATS_URL/USER/PASSWORD/INBOX_PREFIX, PROVIDERS_DATABASE_URL,
LITELLM_URL и LITELLM_API_KEY. Ключи upstream получает только LiteLLM
через opaque env_file; его master key обязателен. HTTP использует
отдельный token и identity (см. HTTP.md). Секреты и адреса экземпляра
не входят в каталог моделей или release artifact.

LiteLLM и программа должны разделять приватный loopback: api_base
разрешает только 127.0.0.1:18401/dispatch/<random nonce>. Egress guard
проверяет точный запрос и разрешает одну внешнюю отправку, включая
transport replay stock LiteLLM. Guard обязателен. Proxy слушает только
127.0.0.1, без опубликованного порта; внешним callers доступен facade.
При смене network namespace пересоздают обе программы вместе.

PROVIDERS_V0_ENABLED=0 отключает legacy v0 регистрацию; v1 сохраняет
общий предел двух compute без очереди. Перед отключением v0 оператор
проверяет отсутствие постоянных callers. Существующие consumers не
переключаются автоматически. Passive readiness не вызывает модель;
NATS PING сам по себе не подтверждает готовность PG/Proxy.

Копия собственной PostgreSQL БД, roles/HBA, защищённые inputs,
immutable release manifest и готовые container images нужны для
восстановления. Артефакты резервирует их владелец. Сохранённые unknown
операции не пересылают; результаты 24 часа, ключи 7 суток. Откат
программы не отменяет расходы и не удаляет БД или готовые Артефакты.

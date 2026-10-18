# Контракт providers v0

Экспериментальный синхронный endpoint — `brai.providers.v0.invoke.decide`.
Постоянные consumers не подключаются. Машинный контракт: [AsyncAPI](asyncapi.yaml)
и закрытые [Draft-07 схемы](schemas/v0.schema.json).

## Путь и доверие

NATS Services adapter → чистое ядро → LiteLLM 1.104.2 `/v1/systemone` →
одноразовый egress → фиксированный TypeSafe `/v1/systemone` → обратно.
Egress — маленький HTTP-модуль той же TS-программы, не отдельный процесс.
Он не адаптирует модельный API, не выбирает модель и не выполняет вызов без
предшествующего запроса LiteLLM. Секрет получает только LiteLLM штатным env_file;
egress пересылает его Authorization без чтения secret-файла и без журналирования.
LiteLLM доступен только доверенной программе Brai; приватный egress listener —
loopback, зарегистрированные случайные capabilities, фиксированные метод/origin/path.

Доверенная граница caller задаёт ownerId. UUID и ownerId не дают полномочий;
NATS broker/ACL изолируют вход. Нет публичного HTTP или браузерного входа.
Окружение запуска явно передаёт NATS_URL, LITELLM_URL, PROVIDERS_EGRESS_PORT
(по умолчанию loopback18401). Health модели отсутствует.

## Данные и ограничения

Запрос: UUID requestId, непустой ownerId ≤255 символов, provider=`typesafe`,
model=`jev-1.13.0`, state ≤16384 символов, ровно один вопрос noul с instructions
≤2048 символов; deadlineAt — абсолютный RFC3339. Имена вопроса: латинская буква,
затем буквы/цифры/подчёркивания, ≤64 символов. Неизвестные поля отвергаются.
Максимальный UTF-8 JSON запроса32768 байт, ответа upstream16384 байта.
Выход семантически ограничен одной вероятностью noul в [0,1]; max_tokens
не добавляется, System One его не поддерживает. Нет генерации свободного текста.
Параллелизм2, очередь отсутствует; время ожидания ≤min(deadlineAt-now,30000мс).
NATS caller выбирает timeout больше этого срока с запасом доставки; broker payload
должен быть ≥32768 байт. У fixture стандартный конечный NATS limit1MiB.

Ответ содержит requestId, provider, requestedModel, actualModel, answers и usage.
actualModel обязан быть точным jev-1.13.0; неизвестная/другая модель — отказ протокола.
Вероятность не округляется. Usage содержит inputTokens/outputTokens либо null,
когда реальный upstream не сообщил счётчики. Egress сохраняет только наличие
и проверенные counts до нормализации LiteLLM, не промпт или ответ. Программа
возвращает реальные counts, а не созданные LiteLLM нули.

## Повторы, дедлайн и ошибки

Прикладных retries/fallback нет. Настраиваемые retries LiteLLM/router отключены,
drop_params=false, модель одна. Stock 1.104.2 содержит безусловный транспортный
replay POST при RemoteProtocolError/ConnectError. Поэтому egress атомарно claim-ит
одноразовый случайный nonce до внешнего fetch; любой replay/late/unknown nonce
отвергается до обращения к TypeSafe. Nonce хранится только во время полного
вызова LiteLLM, ≤2 active entries. Он не равен requestId caller и не создаёт
дедупликацию повторных запросов caller. Число внешних dispatch на попытку ≤1.

Abort прекращает локальное ожидание, но не доказывает остановку TypeSafe или
отсутствие списания. Слот удерживается до остановки локальных HTTP-действий.
После возможной отправки timeout, разрыв или потеря ответа означает unknown;
автоматическая новая попытка запрещена. После перезапуска состояние не восстанавливается.

Ошибки — оба заголовка Nats-Service-Error/Nats-Service-Error-Code (500)
и прямой DTO {code,outcome}; code из схемы, outcome=not_sent|failed|unknown.
INVALID_REQUEST, MODEL_NOT_ALLOWED, DEADLINE_EXCEEDED и OVERLOADED до отправки:
not_sent. 401/403: UPSTREAM_ACCESS/failed;429: UPSTREAM_RATE_LIMIT/failed;
5xx: UPSTREAM_FAILURE/unknown; невалидный ответ: UPSTREAM_PROTOCOL/unknown;
обрыв/abort: OUTCOME_UNKNOWN/unknown. Сырые upstream body/exception не возвращаются.
Сбой egress после возможной отправки даёт безопасный5xx/unknown.

NATS Services: brai_providers, version0.0.1, уникальный instance ID,
queue brai_providers, стандартные PING/INFO/STATS. PING не проверяет TypeSafe.
Нет БД, каталога, потоков, tools, файлов, истории, уведомлений и фоновых задач.
Справочники History прочитаны при разработке; события в v0 не требуются и не публикуются.

## Проверка и готовность

Существующими зависимостями: `npm test --prefix services/providers`.
Для real NATS задайте PROVIDERS_TEST_NATS_URL собственного изолированного broker;
без него NATS-тест явно skipped. Контроль HTTP/egress бесплатный, не заменяет
stock LiteLLM и настоящий Jev. Последние проверенные18 тестов включали real NATS.
Живая приёмка ещё не выполнена: ready-image pull упал из-за заполненного диска.
Нельзя объявлять этот v0 принятым для live по одним mock-тестам.

[LiteLLM1.104.2 source](https://github.com/BerriAI/litellm/tree/v1.104.2),
[TypeSafe API](https://docs.typesafe.ai/api), [цена](https://docs.typesafe.ai/models).

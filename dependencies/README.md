# Зависимости Brai

[Temporal](temporal/README.md) `1.31.0` — сервер workflow с отдельным PostgreSQL и постоянной историей. Микросервисы подключаются к `temporal:7233` через существующую сеть `BRAI_NATS_NETWORK`; namespace — `brai`.

[Instaloader](instaloader/README.md) `4.15.3` установлен как отдельная контейнерная CLI-зависимость для получения медиа и метаданных Instagram. Его образ и Docker Compose находятся в `instaloader/`; инструмент запускается по запросу с явным каталогом данных.

Brai использует NATS `2.15.0` с JetStream и полный Supabase `self-hosted/v0.8.2`. Эти определения запускаются через Docker Compose без репозитория `admin`. Секреты, параметры экземпляра и подготовленный корень Supabase передаются явно.

## Подготовка экземпляра

1. Установите Docker Engine и Docker Compose v2.
2. Подготовьте корень self-hosted Supabase по [официальной инструкции](https://supabase.com/docs/guides/self-hosting/docker), используя [закреплённый выпуск](https://github.com/supabase/supabase/tree/self-hosted/v0.8.2/docker). Его `setup.sh` создаёт конфигурацию, SQL и каталоги `volumes/`. Путь к этому корню задайте абсолютным `SUPABASE_DATA_ROOT`. Для существующего стека используйте прежний корень; повторно не запускайте генерацию секретов и инициализацию данных.
3. Сохраните Supabase `.env` отдельно с правами `0600`. Определения ожидают переменные официального выпуска. Существующему экземпляру передайте его прежний файл.
4. Создайте две отдельные проектные Docker bridge networks: обычную для NATS и `--internal` для PostgreSQL. Веб-приложение подключается только к NATS; сервисы auth и timer — к обеим сетям. Studio и API остаются внутри Supabase.
5. Подготовьте три существующих volume: для NATS, `db-config` и `deno-cache` Supabase. Передайте их точные имена через конфигурацию. Compose использует `external: true` и не создаёт новые хранилища молча.
6. В отдельном защищённом файле NATS задайте независимые случайные значения `NATS_ADMIN_PASSWORD`, `NATS_WEB_PASSWORD`, `NATS_TIMER_PASSWORD`, `NATS_AUTH_PASSWORD`. Укажите абсолютный путь к файлу в `NATS_SERVER_ENV_FILE`. Не передавайте административный пароль приложению или пароли в публичные переменные Next.js.
7. Заполните `instance.env.example` и сохраните конфигурацию экземпляра вне Git.

Запуск из корня Brai:

```sh
docker compose --env-file /absolute/instance.env -f dependencies/nats/compose.yml up -d --wait
docker compose --env-file /absolute/supabase.env --env-file /absolute/instance.env \
  -f dependencies/supabase/compose.yml -f dependencies/supabase/networks.yml up -d --wait
```

Остановка через `stop` сохраняет данные. Не применяйте `down -v` и не удаляйте подготовленный корень Supabase. Bind mounts всегда указывают на явный `SUPABASE_DATA_ROOT`; перенос Compose-файла не меняет расположение данных.

Административные точки доступны только на хосте: NATS `127.0.0.1:4222`, Supabase API/Studio `127.0.0.1:8000`, Supavisor `127.0.0.1:5432` и `127.0.0.1:6543`. PostgreSQL и Studio не публикуют собственные порты. В контейнерной сети таймер подключается прямо к `supabase-db:5432`; отдельные БД и прикладные роли создаёт развёртывание приложения.

## Параметры клиентов NATS

| Назначение | Пользователь | inboxPrefix | Stream / consumer |
| --- | --- | --- | --- |
| Серверный шлюз Next.js | `web` | `_INBOX.brai_web` | `BRAI_TIMER_EVENTS_V2` / `web_events` |
| Сервис таймера | `timer` | `_INBOX.brai_timer` | `BRAI_TIMER_COMMANDS_V2` / `timer_commands` |
| Авторизация | `auth` | `_INBOX.brai_auth` | request-reply без JetStream |
| Управление | `admin` | собственный префикс | не передаётся приложениям |

URL контейнерных клиентов — `nats://nats:4222`; логин и пароль передавайте отдельными параметрами клиента. Нестандартный `inboxPrefix` обязателен: подписка на обычный `_INBOX.>` запрещена. NATS Services использует имена `brai_timer` и `brai_auth`; доступны PING, INFO, STATS на общих и относящихся к этому имени subjects. Сервис отвечает только на полученные запросы: один ответ в пределах 30 секунд через `allow_responses`.

`web` вызывает четыре auth endpoints из [контракта auth](../services/auth/README.md). Он публикует start/stop команды и запросы snapshot/history/command; читает события. Он не публикует события, не создаёт и не изменяет streams, не управляет потребителем команд. Для событий разрешён только именованный pull consumer `web_events`.

`timer` читает команды, обслуживает запросы и публикует started/stopped/rejected события. Он не публикует start/stop команды. Разрешено управление только двумя перечисленными streams и потребителем `timer_commands`. Удаление streams запрещено прикладным пользователям. JetStream INFO, точечные stream INFO, consumer API и ACK subjects разрешены в пределах этих имён.

`auth` обслуживает только четыре auth endpoints и discovery; отвечает через `allow_responses`. Он не читает и не публикует данные таймера, не использует JetStream. Анонимные `brai.timer.v1.*` запрещены всем runtime пользователям.

Streams создаёт сервис таймера; инфраструктура их не создаёт. Их создание, политики хранения, схемы сообщений и семантика принадлежат `services/timer`. Эта конфигурация закрепляет только инфраструктурные имена и права для согласованных subjects. При изменении consumer names или inboxPrefix сначала согласуйте ACL.

Полный Compose Supabase производен от официального выпуска; [лицензия upstream](https://github.com/supabase/supabase/blob/self-hosted/v0.8.2/LICENSE) применяется к исходному определению. Настройки, секреты и данные конкретного экземпляра в поставку не входят.

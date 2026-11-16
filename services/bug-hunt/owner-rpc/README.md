# Закрытый credential helper Bug Hunt

Helper выдаёт access из существующего Codex owner. Это внутренняя программа
Bug Hunt, а не новый OAuth owner. Она импортирует проверенные по SHA-256 байты
`services/hermes/extensions/tools/codex_cli_owner.py` из принятого Root source.
Функции `snapshot`, `resolve`, `refresh` и общий `hermes-owner.lock` не меняются.
`auth.json` не копируется, refresh token не извлекается и не передаётся native.
Версия CLI не проверяется по списку разрешённых версий.

Связи: Root admission → helper с UID/GID provider → существующий owner DATA;
worker/native → private UDS → helper. Только launcher выбирает программы, пути,
peer и provider source. Модель этих входов не задаёт. Helper не делает inference,
не меняет ядро Hermes и не подключается к его egress.

## Запуск

Root заранее проверяет полную принятую provider source/producer квитанцию,
бинарные программы, закрытый config и namespace. Затем запускает:

```text
<provider.python> -I -S -B <accepted>/services/bug-hunt/owner-rpc/helper.py --config <root-config> --listen-fd <fd>
```

`--config` — Root-owned обычный файл без symlink/hardlink и записи для group/other;
его каталоги также принадлежат Root и закрыты от такой записи. Форма входа:

```json
{
  "version": 1,
  "socket": "/run/instance/bug-hunt/credentials.sock",
  "stateRoot": "/var/lib/instance/bug-hunt-credentials",
  "peerUid": 1234,
  "provider": {"...": "точный принятый provider из egress Root receipt"}
}
```

`provider` сохраняет принятую форму существующего egress: `uid`, `gid`,
`ownerHome`, `codexHome`, `codex`, `node`, `componentRoot`, `helperPath`,
`helperSha256`, `providerSourceReceipt`, `closedConfig` и остальные поля
Root admission. Helper повторно проверяет свой effective UID/GID, отсутствие
supplementary groups, `-I -S -B`, hash и точное расположение owner helper,
отсутствие `.brai-runtime.json` даже как broken symlink, пути и права owner,
отдельные rw mounts HOME/CODEX_HOME, read-only mount `config.toml` и его hash.
Полная проверка source/producer остаётся обязанностью Root launcher.

Окружение ровно:

```text
HOME=<provider.ownerHome>
CODEX_HOME=<provider.codexHome>
PATH=<directory of provider.node>:/usr/bin:/bin
PYTHONNOUSERSITE=1
PYTHONDONTWRITEBYTECODE=1
```

Допускается также только `LC_CTYPE=C.UTF-8`, который CPython может сам добавить
при locale coercion чистого окружения. Иные переменные отклоняются.

Helper работает как `provider.uid:provider.gid`, `extra_groups=[]`.
`stateRoot` существует заранее, принадлежит этому UID/GID, имеет режим 0700.
В нём 0600 singleton flock и atomic/fsync state. Root не удаляет и не подменяет
этот каталог при рестарте, обновлении или rollback.

Для production Root заранее создаёт и слушает AF_UNIX/SOCK_STREAM socket
Root:workerGid 0660 в каталоге Root:workerGid 0710 и передаёт listener через
`--listen-fd`. Helper проверяет тип, listening и точное `getsockname`, снимает
наследование FD; проверка pathname permissions и его уборка принадлежат Root.
Worker не добавляется в provider group и не видит owner mounts. Соединение
допускается только при Linux `SO_PEERCRED.uid == peerUid`, без исключения для UID 0.

Без `--listen-fd` доступен private self-bind: родитель socket принадлежит helper
UID/GID с режимом 0700; socket создаётся 0600 и только если pathname отсутствует.
Это режим локального запуска и fake fixtures с тем же UID. Helper не удаляет
чужой или оставшийся socket и не подменяет его при рестарте.

## RPC и client

[OpenRPC](openrpc.json) описывает операции. Транспорт — UTF-8, один JSON-документ
на строку, JSON-RPC 2.0, именованные параметры. Поддерживаются batch, числовой,
строковый и null ID; уведомления выполняются без ответа. Ответы не содержат
diagnostic details. Parse/invalid/method/params имеют стандартные коды
`-32700/-32600/-32601/-32602`, ошибки admission — `-32000` с фиксированным кодом
в `error.message`.

`credentials.status({})` не запускает refresh и не берёт общий owner flock:

```text
{ready, code, binding, accountId, expiresAt, baseUrl, sourceRef}
```

`binding`, `accountId`, `expiresAt` равны null при недоступном snapshot.
Иначе `expiresAt` — Unix seconds, `baseUrl` всегда
`https://chatgpt.com/backend-api/codex`, `sourceRef` — SHA-256 принятого
`providerSourceReceipt`. `ready` означает свежий snapshot без pending/unknown.
`code` — `READY`, `CODEX_OWNER_ACCESS_EXPIRED`, `OWNER_OUTCOME_UNKNOWN` или
фиксированная ошибка. Status не очищает неизвестный исход.

`credentials.resolve({expectedBinding?: string})` возвращает:

```text
{access, binding, accountId, expiresAt, baseUrl, sourceRef}
```

Unfenced resolve нужен trusted native preflight до фиксации фазы: он может
обновить истёкший access штатным owner и вернуть новую связь. `expectedBinding`
— fence, а не выбор аккаунта. Он проверяется до вызова owner и после получения
результата. Native хранит account/source/binding из одной связи и применяет
их к каталогу, headers и фазе.

Native auth.command запускает только принятую команду:

```text
<accepted Python> -I -S -B <accepted>/services/bug-hunt/owner-rpc/client.py --socket <accepted socket> --binding <phase binding>
```

Client всегда передаёт `expectedBinding`, не делает повторов и проверяет ответ,
binding, endpoint, sourceRef и freshness до stdout. Успех — ровно access и LF,
exit 0. Ошибка — пустой stdout, один фиксированный код в stderr, exit 1.
Bearer не попадает в argv, env, state или журналы helper/client.

## Binding и неизвестный refresh

Binding — opaque durable random epoch наблюдаемого подключения. Epoch меняется
при смене source receipt, SHA account/access или identity auth-файла
`dev/inode/size/mtime_ns/ctime_ns`. Наблюдаемое исчезновение/ошибка snapshot также
инвалидирует прежнюю связь. Epoch сохраняется через обычный restart.

Политика консервативна: **каждый обнаруженный refresh меняет binding**, даже
для того же account. Если fenced resolve сам обновил access, он завершает owner
вызов, но возвращает `HELPER_BINDING_CHANGED` без access. Прежняя фаза должна
завершиться с закрытым допуском; новая фаза делает unfenced preflight.

Существующий owner не предоставляет authoritative logout/login generation.
Helper не может отличить собственный refresh от внешнего повторного входа
по одному account. Полностью идентичное восстановление state без наблюдаемого
изменения между обращениями не обнаруживается. Epoch не обещает такую гарантию.
Проверка binding не отменяет уже выданный bearer и не блокирует внешний owner
после последнего snapshot; следующий boundary проверяет связь заново.

На свежем access helper вызывает `owner.resolve(read_only=True)` без общего
flock и без refresh intent. Если нужен refresh, сначала атомарно сохраняется
несекретный intent с SHA исходного access, затем вызывается `owner.resolve()`.
Вызовы helper сериализованы; существующий owner сериализует общий refresh с
Hermes/MemOS своим inode flock. Его штатный deadline 15 секунд включает ожидание
lock; штатный finally завершает/убивает CLI. Новых продуктовых таймеров нет.

`CODEX_OWNER_BUSY` доказывает отсутствие refresh; intent снимается, последующий
вызов может повторить попытку. Любой другой сбой потенциального refresh оставляет
`unknown`; crash с `pending` трактуется так же после restart. Повторный refresh
запрещён. Допускается только `owner.resolve(read_only=True)` и только свежий access
с SHA, отличным от baseline intent. Такой read-only успех снимает unknown.
Новый inode или новая expiry при прежнем access сами по себе не восстанавливают
допуск. Read-only проверку восстановления вызывает resolve; status лишь сообщает
`ready:false, code:OWNER_OUTCOME_UNKNOWN`.

Разрыв клиента не отменяет локальный owner вызов. SIGTERM/SIGINT закрывает
admission/listener и каналы peers, ждёт уже начатые local calls и
только затем освобождает singleton lock. Новые/ожидающие вызовы получают закрытый
допуск. Это **не гарантия OAuth commit**: если удалённая ротация уже произошла,
а новый state не сохранён, helper не восстановит утраченный refresh token.
Допуск остаётся unknown; восстановлением занимается единственный owner.

На соединение выделяется stdlib thread; peers фиксированы Root и доверены.
Общие helper операции сериализуются без отдельной очереди или таймера. Новых
числовых пределов входа/параллелизма этот контракт не вводит. Launcher отвечает
за жизненный цикл доверенного worker и единственного helper/stateRoot.
Helper не создаёт History события: credential и account admission остаются
приватными; владелец фазы записывает её результат без credential payload.

## Проверки

```sh
python3 -B -m unittest discover -s services/bug-hunt/owner-rpc -v
```

Тесты используют временные синтетические credentials, реальные UDS/SO_PEERCRED,
fake owner и неизменённый настоящий owner с fake stdio CLI. Они не запускают
модели, не читают рабочую авторизацию и не подтверждают production namespace
или реальное совместное обновление Hermes/MemOS. Root admission и negative
namespace acceptance проверяются отдельно установщиком.

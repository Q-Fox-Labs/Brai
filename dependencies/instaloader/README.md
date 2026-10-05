# Instaloader

[Instaloader](https://github.com/instaloader/instaloader) — открытый Python-инструмент под лицензией MIT для получения медиа и метаданных Instagram. Версия `4.15.3` и runtime-зависимости закреплены в `requirements.txt`. Образ содержит CLI и Python-модуль; команда выполняется в отдельном контейнере по запросу.

## Установка и проверка

Из этого каталога:

```sh
docker build -t brai-instaloader:4.15.3 .
docker run --rm --network none brai-instaloader:4.15.3 --version
docker run --rm --network none --entrypoint python brai-instaloader:4.15.3 -m pip check
```

На управляемом сервере установка выполняется плейбуком `admin/ansible/playbooks/operations/install_brai_instaloader.yml`.

## Запуск

Передайте абсолютный путь к существующему каталогу, доступному для записи UID/GID `1000:1000`. На управляемом сервере каталог готовится через Ansible. В нём сохраняются загрузки и `.config/instaloader/` с сессиями; не помещайте его содержимое в Git.

Из корня Brai:

```sh
export BRAI_INSTALOADER_DATA_DIR=/absolute/instaloader-data
docker compose -f dependencies/instaloader/compose.yml run --rm instaloader --help
docker compose -f dependencies/instaloader/compose.yml run --rm instaloader PROFILE
```

Для интерактивного входа добавьте `--login USERNAME` к аргументам Instaloader. Сессия сохраняется в подключённом каталоге и используется при следующих запусках. Доступ к Instagram зависит от его ограничений и прав учётной записи.

Python-модуль доступен через замену entrypoint:

```sh
docker compose -f dependencies/instaloader/compose.yml run --rm --entrypoint python instaloader -c 'import instaloader; print(instaloader.__version__)'
```

[Установка](https://instaloader.github.io/installation.html), [CLI](https://instaloader.github.io/cli-options.html), [Python API](https://instaloader.github.io/as-module.html).

# Описания и поставки Brai

`component.json` находится рядом с компонентом. Владелец формата — Codeworks,
машинный источник — [`component.schema.json`](../schemas/component.schema.json),
JSON Schema Draft-07. Node проверяет используемые keywords без npm preparation;
новый keyword требует явной поддержки и не игнорируется молча.
Новых библиотек, движка задач и фоновых процессов нет.

Discovery работает в Git checkout: `git ls-files --cached --others --exclude-standard -z`
задаёт список исходников, включая новые ещё не добавленные файлы. Ignored live,
secret и output-каталоги не обходятся. Уже tracked файл остаётся исходником,
даже если позже добавлен в `.gitignore`; удаление описания проверяет lifecycle.
Пути generated delivery проверяются отдельно от discovery. Изолированные source
fixtures создают собственный Git repository перед добавлением компонентов.

Автор добавляет описание в той же ветке, что и компонент. При изменении импорта,
контракта, упаковки или checks он обновляет соответствующие входы. Пути относительны
корню Brai. `inputs.runtime` перечисляет исходники и рабочие assets,
`inputs.build` — дополнительные входы компиляции, `inputs.checks` — тесты.
Можно использовать существующий путь или glob Node `fs.globSync`.
`dependencies[].inputs` перечисляет реальные публичные файлы соседа, нужные сборке;
`delivery` перечисляет его файлы, нужные поставке. Прямые импорты соседнего кода
сохраняются как явные build edges, без копирования определений владельца.
`delivery.files` содержит только конкретные пути. `npm.workspaces` задаёт roots
точного transitive runtime closure из `package-lock.json`; devDependencies не входят.

Из корня репозитория:

```sh
node services/codeworks/components/cli.mjs validate --base refs/remotes/origin/dev
node services/codeworks/components/cli.mjs plan history alerts
node services/codeworks/components/cli.mjs run history alerts
```

`validate` проверяет схему, полноту описаний, импорты, граф и lifecycle.
`plan` печатает отдельные build/runtime/check keys. `build` компилирует только
изменившиеся build inputs, `check` использует ту же сборку и запускает declared
checks, `package` использует ту же сборку и упаковывает runtime, `run` делает все
три действия. Новое описание автоматически входит в `npm run build` и `npm test`.
Команды выполняются из каталога компонента. Они не должны скрывать повторную
компиляцию в check или package. Прямые legacy `npm test --workspace` сохраняют
свой прежний самостоятельный build; общий pipeline использует raw check из описания.

Build receipt находится в `tmp/component-state`; его можно удалить для полной
сборки. После успешной команды build он сохраняет digest выбранных prepared
delivery files: paths, bytes и modes. Check/package сверяют этот digest, включая
повторную сверку после checks. Изменённый или пропавший output отвергается;
явный build/run восстанавливает его настоящей сборкой. Старый receipt без digest
требует явный build, автоматического принятия существующих outputs нет.
Verification/packaging code не входит в compiler key и сам по себе не сбрасывает сборку. Изменение только
теста меняет check key, сохраняя build/runtime keys. Runtime key учитывает build identity
и фактические выбранные файлы поставки, включая delivery зависимостей; после сборки
он вычисляется заново по готовым outputs. Validate требует наличия delivery files;
планирование и pipeline допускают ещё не созданные dist/.next до первой сборки. Runtime package ID — SHA-256
фактических файлов, modes, launch contract и locked package identity, поэтому тест и время проверки не меняют ID поставки.

Готовая поставка находится в `tmp/component-packages/<id>-<sha256>` и содержит
manifest с SHA-256/размерами каждого файла и точными locked package keys/versions.
Повтор проверяет существующий каталог вместо перезаписи. CLI повторно использует
проверенную поставку при прежнем runtime key; новый check не копирует runtime заново. В payload сохраняются
относительные пути опубликованных owner contracts; полное дерево исходников не
нужно. Smoke выполняется из отдельного временного каталога вне репозитория с
пустыми NODE_PATH/NODE_OPTIONS. OCI Dockerfile только копирует готовые файлы,
не устанавливает зависимости. Registry/Actions использует этот же упаковщик
через [общий CI](../ci/README.md); rollout остаётся отдельным этапом.

Скрипты History/Alerts `scripts/package-runtime.mjs` используют тот же упаковщик,
принимают только prebuilt outputs с проверенным build receipt и печатают точный immutable каталог. Их `--output`
теперь задаёт родительский каталог под корневым `tmp`, а не изменяемую поставку.

CLI по умолчанию сравнивает с `refs/remotes/origin/dev`; для другой принятой базы
передайте `--base <ref>`. Перед запуском оператор обновляет refs. Удалённый ID
оставляют как `status: retired` с `reason`; при новом ID старый tombstone указывает
`renamedTo`. Удаление описания или deploy unit без retirement отвергается. Смена
каталога с прежним ID сохраняет идентичность. Tombstone не запускает и не удаляет
службу: фактическое отключение — отдельный reviewed rollout оператора.

Описаны web, auth, timer, history, alerts, artifacts (включая MCP), game-core,
transcription, local-ai, agent, providers, supabase-mcp, hermes, codeworks и
codeworks-agent (retired; прежний контроллер не поставляется). Transcription сохраняет coordinator/helper/local/external как
четыре executable одного владельца. Caddy, NATS, Temporal и Supabase — внешние
зависимости оператора. Instaloader — рецепт внешней on-demand программы (type `library`): готовые файлы
задают pinned OCI runtime requirement. First-party executable здесь отсутствует;
активные Brai службы его не импортируют. Runtime executable принадлежит внешнему
образу `brai-instaloader:4.15.3` из его Dockerfile/requirements.txt; build/deploy
этого образа выполняет общий CI по pinned/hash-locked recipe. Exact GHCR digest
и offline CLI acceptance фиксирует composition; установка остаётся rollout.
Проверяемый offline запуск: `docker run --rm --pull never --network none
--read-only brai-instaloader:4.15.3 --help`. Отсутствующий образ — явная ошибка,
не повод скачивать или считать CLI проверенным.

Local AI поставляет app, профили и runners. Подготовленный native/Python/FFmpeg
runtime остаётся по `services/local-ai/release.json`; полная OCI-поставка формируется
существующим release lifecycle Local AI. Веса, VAD, секреты и installation state
в app payload не входят. Каталог, installer, model runtime и lifecycle не меняются;
отдельные Ollama/llama runtimes не создаются.

Проверки формата и автономной упаковки:

```sh
node --test --test-isolation=none services/codeworks/components/*.test.mjs
```

Конкретные unit IDs, включённость компонентов и сведения установки принадлежат оператору. Дескрипторы содержат поддерживаемые цели, но не подтверждают их состояние.

Hermes payload включает собственные MemOS embedding adapter и codex_bridge.py,
а также pinned bridge requirements. Python bridge-venv, operator bridge_runtime.py
с single-owner binding, codex_cli_owner.py и установленный Codex остаются явными
внешними prerequisites существующего Hermes lifecycle. Без них Python bridge
не считается готовым runtime. Gateway, MemOS engine, browser, AWG2 и intake
предоставляет оператор; first-party adapters находятся в этом описании.
Providers действует в DEV; отдельный внешний LiteLLM proxy закреплён digest
в systemRequirements, его конфигурация litellm.yaml входит в поставку.

Executable gate проверяет объявленные package bin, runtime scripts с флагами Node/Python,
conventional main/runner и файлы с shebang и executable mode независимо от имени/каталога.
Новый такой файл требует executableSources владельца; bin/runtime scripts также
требуют delivery.entrypoints. Generated outputs проверяются после сборки.

## Документация в проверках компонентов

Тот же graph/CLI проверяет обязательные индексы, карточки по существующим ID, технические README, ссылки и локальные якоря. Активные документы должны быть достижимы от [главного README](../../../docs/README.md). Архивы, vendor и тестовые fixtures не требуют переписывания; принятые правила GameCore сверяются по baseline.

Проверка выполняется также при планировании и исполнении CI, даже при полном попадании в кеш. Личные файлы docs/user-agent/usercustom не читаются из исходников и запрещены в составе поставки. Самостоятельного сервиса или второго реестра компонентов нет.

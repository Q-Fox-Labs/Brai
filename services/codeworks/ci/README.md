# Общий CI и состав поставки

Владелец — Codeworks. Единственный workflow: [codeworks.yml](../../../.github/workflows/codeworks.yml).
Один стандартный `ubuntu-24.04` job использует Node 24.22.1 / npm 11.19.1;
внутри исполняются не более двух независимых компонентов. Новых платформ,
npm-пакетов, серверных runtime или daemon нет.

Поток: Git source boundary → descriptors/lifecycle → content keys → GHCR и
подтверждения исходных Actions attempts → отдельные `build/check/package/reuse`
sets → одна подготовка npm при необходимой работе → build/check/package →
сверка исходников и output seals → GHCR → immutable digest proof в Actions.

## Допуск без дополнительных расходов

Job проверяет **до выделения runner** repository variables
`CODEWORKS_ZERO_EXTRA_POLICY=account-wide-actions-usd0-stop-usage` и
`CODEWORKS_BILLING_CONFIRMED_AT=<UTC время подтверждения>`. Оператор задаёт их
только после проверки или прямого подтверждения владельцем аккаунта: account-wide
Actions product budget — USD 0, **Stop usage** включён. Это подтверждение
оператора, не API-доказательство. Repository admin права не доказывают тариф,
остаток minutes/storage или hard stop. Агент не включает допуск по предположению.

Larger runners, paid overage и платное расширение хранения не запрашиваются.
Блокировка hard stop сохраняет `awaiting_ci`; billing/spending-limit annotation
даёт `CI_BILLING_BLOCKED`. Причина может быть и ошибкой оплаты, поэтому это не
доказательство именно исчерпания minutes. Недоступный остаток квоты обозначается
`unavailable-to-workflow-token`, без вымышленного числа.

На 2026-10-21 [документация GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
указывает бесплатные storage/bandwidth GHCR. Это текущая политика, которую
нужно проверять перед новым включением CI. [Budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)
объясняют Stop usage: без него бюджет только уведомляет о перерасходе.

## Ключи и повторное использование

Полный Git SHA — только provenance. `lock-inputs.mjs` выбирает точный transitive
lock closure workspaces, nested paths, workspace links, обязательные peers и
подходящие platform optionals. Optional peers исключены. Runtime исключает
devDependencies; build/check включают dev roots своего workspace. Неверный lock,
отсутствующая обязательная запись и несовместимая платформа — ошибки.
Посторонний lock entry не меняет ключи других компонентов.

Build key учитывает sources, interfaces, compiler recipe, toolchain, platform/libc
и effective web variant. Check key добавляет tests и launch/delivery contract.
Artifact input key учитывает runtime closure, packaging recipe, immutable base
digest, paths/modes и delivery contract. Полный CI recipe fingerprint отдельно
закрепляет принятый workflow и его средства проверки; смена recipe требует
приёмки. Только `web` различает `BRAI_WEB_VARIANT=development/production`.
DEV/PROD сам по себе не входит в generic key. Next standalone отключён;
production closure готовит общий упаковщик.

`ghcr.io/<owner>/<repo>-components/<id>` содержит `build-<sha256(build key + CI recipe)>` с prebuilt
first-party outputs и seal, `input-<artifact input key>` с полным runtime и
`check-<check key>`. Состав находится в `.../release:run-<run id>-<attempt>`.
Tags — только поиск; состав использует digests. Payload проверяется по каждому
path/hash/mode. Restore возвращает только generated outputs, не перезаписывает
sources/node_modules и не принимает dist без sealed build receipt.

Все checks завершаются до первой публикации. Ошибка или изменение source/recipe
во время checks ничего не публикуют. Сбой публикации может оставить отдельные
OCI objects, но failed run не становится успешным выпуском. При всех hits нет
npm ci и component build/check/package, публикуется только новый маленький состав.
Перед каждым CI check/package проверяется готовый build receipt: потеря receipt
останавливает run и не запускает скрытую компиляцию через обычный CLI.
`CODEWORKS_DISABLE_CACHE=1` отключает `~/.npm` и Docker layer cache; immutable
GHCR reuse сохраняется. Download cache не содержит готовые поставки.

## Доверие и runtime

Операторская `project.github.ci` закрепляет `check_name`, `app_id`,
`workflow_sha256`, `recipe_sha256`. Прежняя регистрация сама не меняется.
Verifier читает exact check App/head, Actions run/attempt/job, push event,
repository, стандартный runner, workflow и все recipe bytes на exact SHA.
GHCR composition сверяется с immutable Actions artifact
`codeworks-proof-<run id>-<attempt>`: digest архива, manifest и digest состава.
Для reused runtime/check/build сверяется digest в proof исходного successful run.
OCI labels, check name или ссылка на чужой successful run недостаточны.

Actions proof — транспорт первичной проверки с retention 30 дней. Owner verifier
однократно сохраняет успешно удостоверенный proof в append-only PG `verified_ci`,
привязав его к project/run/attempt и fingerprint operator policy. Обычный agent API
не имеет такого write-port. Сохранённые proofs и защищённые release records не
теряют доказательство после expiry Actions artifact. До первичной проверки
неизвестный expired proof даёт явный stop, без молчаливой пересборки.

Owner экспортирует компактный Ed25519-signed catalog проверенных component
key/digest/source/run/attempt/recipe в GHCR: immutable `catalog-<content hash>` и
поисковый pointer `verified-<recipe>`. Перед retry неизвестной публикации читает
content tag; совпавший object не пересоздаётся. CI проверяет подпись public key из
operator var и записывает **immutable catalog digest** в состав. Final owner
verifier независимо проверяет этот catalog ключом из `project.github.ci`;
подмена repo var/каталога обычным агентом не создаёт trusted evidence. Подпись
не заменяет первую exact Actions/run/recipe/digest проверку.

Private key `/etc/brai-dev/codeworks-ci/identity.pem` создаёт Ansible один раз;
owner задаёт `CODEWORKS_REUSE_PRIVATE_KEY_FILE`. Public PEM закрепляют и в policy
`reuse_public_key`, и в repo var `CODEWORKS_REUSE_PUBLIC_KEY`. Ключ не передаётся
CI. Помимо UID/mode0600 существующая namespace mask `/etc/brai-dev` скрывает его
от native агентов и broker read/write commands, FS tools ограничены project roots.
При reinstall сохраняются key и PG; backup/restore возвращает прежнюю пару и
`verified_ci`, не генерирует замену. Потеря ключа требует явной ротации policy.
[Операция Ansible и backup scope](/srv/projects/admin/docs/CODEWORKS_AGENTS.md).

Owner проверяет произвольный готовый exact run (в том числе до PR) через
`src/verify-ci.mjs <registered project id> <exact SHA>`; connection приходит из
`CODEWORKS_DATABASE_URL` либо закрытого `CODEWORKS_DATABASE_CONFIG_FILE` (`app_url`).
CLI не принимает agent proof и не объявляет установку. Worker использует тот же
store/catalog порт, а durable release leg сохраняет exact CI composition.

Owner verifier использует существующую GitHub CLI auth с Actions/contents и
`read:packages`/`write:packages` для private GHCR и owner catalog. Push workflow может требовать OAuth `workflow`.
Секрет остаётся в памяти, не argv/manifest/stdout/Git. Недоступный verifier даёт
`awaiting_ci/CI_VERIFICATION_UNAVAILABLE`. Durable leg хранит `head_ci/merge_ci`
с exact run/attempt/source/composition digest. Installed всё ещё требует отдельный
deployment verifier; workflow не запускает rollout или миграции.

Container images используют pinned Node base и COPY готового payload, без
install/compile. Program images — scratch с `/payload` для извлечения Docker
через Ansible; Node/Python/external prerequisites перечислены явно. Instaloader
собирается отдельно из hash-locked wheels на pinned Python base и проходит
`--help` с `--network none` до публикации. Library files сами не заменяют runtime.
Local AI сохраняет runtime/models/catalog/installer lifecycle; веса/state не входят
в image. Hermes/MemOS engines, Python bridge, owner launcher, Codex и LiteLLM
остаются явными pinned внешними prerequisites своих владельцев.

## Проверки

```sh
node --test --test-isolation=none services/codeworks/components/*.test.mjs services/codeworks/ci/*.test.mjs services/codeworks/tests/ci-verifier.test.mjs
```

Fixtures не доказывают реальные Actions/GHCR/установку. Обязательны настоящие
cold/repeat/lost-cache runs, isolated component/unrelated lock/test-only changes,
digest/CLI проверки и measurements настоящих compositions. До подтверждения
нулевого hard stop и нужного API доступа запуск запрещён; отсутствие evidence
не считается PASS.

Owner reuse catalog использует стабильный OCI package `catalog-v1`. Первая owner-публикация содержит `org.opencontainers.image.source` зарегистрированного репозитория, чтобы GHCR связал package и предоставил Actions унаследованный доступ. Если account отключает наследование, оператор должен явно предоставить workflow read access; `403` останавливает планирование. Старый экспериментальный package `catalog` не используется.

## Точная область обслуживания

`memos-rest.json` задаёт tenant через `user_id`, профиль обслуживания через
`scope_profile`. Если `scope_profile` отсутствует, сохраняется прежнее `default`.
CLI сверяет переданные owner, профиль и весь набор `Catalog.cubes` с живой
конфигурацией. Параметры команды не меняют область и не создают root alias.
`status`, `prepare`, `freeze`, `resume` работают с настроенным owner; обычные
разрушительные `purge/handoff` по-прежнему допускают только `default/root`.

### Передача пустого профиля

Оператор нового профиля может явно вызвать `handoff-empty` с его точными
`--scope-profile`, `--user-id`, `--managed-cubes` и свежим `--new-epoch`.
Перед операцией запись должна быть frozen, `bulk_clear_locked=true`, а все
writer-процессы этой области остановлены. Команда под admin/delivery/submit
locks проверяет отсутствие owner-записей в каждом managed cube и пустоту
native `memos-rest/pending` и `memos-rest/receipts`. Непустая область, очередь,
квитанция или неверная identity останавливают переход без удаления и без
изменения config/fence/state.

Только после этих проверок команда сохраняет настоящий resumable handoff
intent, отзывает прежние сессии и записывает production epoch/generation.
Результат остаётся disabled/frozen с `bulk_clear_locked=true`; API delete,
очистка очередей и обычный destructive handoff не вызываются. Точный повтор
завершённого перехода возвращает прежний результат. После сбоя допускается
продолжить только тот же scope/epoch. Это подготовка пустого профиля,
а не доказательство реального write/read: перед включением writer нужна
отдельная функциональная приёмка.

## Разрушительное обслуживание: только default/root/all managed cubes

CLI не меняет `config.yaml` и не создаёт удалённые кубы. Все admin команды требуют точной области. Следующие команды предназначены **оператору deployment**, здесь не запускались на реальном backend:

```sh
CUBES='main life_work life_society life_systems life_body life_vividness life_relationships life_intellect life_comfort life_mission life_capital life_time life_meaning user infra'
hermes memos-rest prepare --scope-profile default --user-id root --managed-cubes $CUBES \
  --router-url http://172.19.0.1:8012 --router-model gpt-6-luna \
  --router-env-file /etc/.secrets/memos/codex-bridge.env --router-key-env MEMOS_BRIDGE_TOKEN
hermes memos-rest resume --scope-profile default --user-id root --managed-cubes $CUBES
hermes memos-rest freeze --scope-profile default --user-id root --managed-cubes $CUBES

# Разрушительная очистка setup: новый epoch, phase остаётся setup, состояние frozen.
hermes memos-rest purge --scope-profile default --user-id root --managed-cubes $CUBES \
  --confirm 'PURGE default/root managed' --new-epoch FRESH_SETUP_EPOCH

# Разрушительная передача: production epoch, остаётся frozen до явного resume.
hermes memos-rest handoff --scope-profile default --user-id root --managed-cubes $CUBES \
  --confirm 'PURGE default/root managed' --new-epoch FRESH_PRODUCTION_EPOCH
```

Если проекты каталогизированы, `$CUBES` должен включать **каждый** такой project cube. Удаление проекта из каталога до purge исключит его из области; сначала очистить, потом убрать каталог.

`freeze` сначала атомарно закрывает submit boundary, затем дожидается delivery lock. `purge/handoff` держит admin/delivery/submit locks, пишет resumable maintenance intent, удаляет exact owner IDs из всех managed cubes с read-back, уничтожает pending/receipts без backup, меняет epoch/generation. Сбой оставляет frozen; повтор той же операции продолжает cleanup. Resume запрещён для незавершённого cleanup. `purge` удаляет **все** записи owner root в managed cubes, включая старые legacy/setup записи, не только записи с новым home/epoch.

Session fence хранит только хеши session IDs и cutoff, не память. Handoff/purge отзывает зарегистрированные и старые canonical Hermes sessions (`state.db` читается read-only); checks started_at защищают также от задержанного появления старой сессии. Старый provider object, stale job, session_end/checkpoint/rewind не могут архивировать предыдущий epoch. После смены epoch нужны новые агенты/сессии, не только resume флага.

**Важно:** код нового guard не может внедриться в уже загруженный старый Python process. Deployment должен штатно загрузить новый provider; дочерняя задача не перезапускала gateway и не объявляет runtime active.

## Проверка patch

`tests/test_provider.py` — прежние 12 legacy-тестов. `tests/test_routing.py` — multi-cube tracer bullets с RED→GREEN вертикальными срезами: worker/provenance, scoped recall/forget, logical correction/replay, handoff/fence, cache isolation, native mirror, project binding, CLI/setup/schema, router failure/lost response, boundary freeze, strict grounding, operation conflicts, uncertain material, delayed sessions, shared infra/privacy, secret boundary, production gate.

Все записи тестов — in-memory fake API; временные профили находятся в scratch. Production MemOS writes не выполняются.

```sh
PY=${HERMES_HOME}/installs/8a4017c4cabfe15f/environments/f2ca2391080d4affa99e0f9b4f7e3f41/venv/bin/python
PYTHONPATH=${HERMES_HOME}/hermes-agent "$PY" -W error::ResourceWarning \
  -m unittest discover -s ${HERMES_HOME}/plugins/memos-rest/tests -v

# Реальный router/bridge, только нейтральные fixture messages, ноль MemOS calls:
"$PY" ${HERMES_HOME}/plugins/memos-rest/tests/verify_router_live.py \
  --env-file /etc/.secrets/memos/codex-bridge.env --key-env MEMOS_BRIDGE_TOKEN --model gpt-6-luna
```

Проверка owner-scoped empty handoff: 47 unittest tests OK, включая legacy, wrong scope, непустые кубы/очереди, lock race, interrupted commit и canonical session fencing. Ни модель, ни живой MemOS в этих тестах не вызываются. Историческая отдельная проверка bridge: реальный bridge — шесть смысловых сценариев, `failures: []`, `memos_writes: 0`. Это не проверка live provider deployment. `.venv` под source tree отсутствует; указан фактически найденный установленный Hermes venv.

## Исправление классификации без очистки переписки

`quality-plan` принимает точные `--scope-profile`, `--user-id`, `--managed-cubes`. Команда читает факты и их источники текущих home/epoch, отдельно проверяет grounding, полезность и назначение в контексте того же автора и сессии. Business-приватные записи не входят в область. Закрытый план в `memos-rest/quality/` содержит прежние копии, решения и контрольную сумму. В вывод попадают только количества, ID плана и SHA; MemOS не изменяется.

После согласования точного плана оператор вызывает `quality-apply` с теми же scope и `--plan-id`, `--plan-sha`. Требуются пустая очередь, frozen профиль и отдельно разрешённое одноразовое применение при снятой защите массовых изменений. Защиту необходимо вернуть и отдельно проверить перед resume. Команда сама не меняет `bulk_clear_locked`, epoch или SQL-права; purge/handoff не используется.

До первого изменения сверяется весь исходный набор фактов. Правильные записи не переписываются. Для изменённых сфер новые копии с прежним logical ID подтверждаются до удаления старых. Неполезные или неподтверждённые факты исключаются, исходники переписки сохраняются. План содержит исходные записи, журнал позволяет продолжить точно тот же прерванный переход. Полная переписка и архив main не удаляются. Изменившийся исходный набор требует нового плана.

## Ограничения

- Exact read-back/scoped get может экспортировать весь выбранный куб: установленный backend игнорирует дополнительные metadata filters; это безопасная, но более дорогая локальная фильтрация.
- Search расширяет область, но качество backend ranking и полнота top-k не гарантируются. Shared/author filtering может уменьшать recall.
- Неудачный независимый ход не блокирует последующие ходы; замены, удаления и неизвестные операции сохраняют порядок и остаются барьерами.
- LLM grounding проверяет provenance, не математически доказывает entailment/атомарность. Реальные сложные сценарии parent должен квалифицировать перед активацией.
- Поправка с несколькими атомарными фактами сознательно отклоняется; разделить на несколько явных операций.
- Epoch fencing не удаляет историю Hermes, резервные копии backend или чужие owner записи. Admin удаляет только согласованную MemOS область и транспортные payloads, без нового backup.

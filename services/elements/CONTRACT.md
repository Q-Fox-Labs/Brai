# game-core

Сервис владеет Элементами, ревизиями, Ходами, попытками и текстовыми ресурсами в одной собственной БД. Канонические записи находятся в схеме `game_core`. Развёртывание, npm workspace, MCP-имена и NATS Service `service_elements` сохраняют прежние технические имена Elements для совместимости инфраструктуры. Второго экземпляра сервиса или канонического хранилища нет. Старые команды заменены согласованной моделью; старый domain/storage не подключён к предметным операциям. Миграция запрещает переход при непустых прежних Elements: сначала нужен явный перенос их данных.

## Данные и доступ

Восемь таблиц: `elements`, `element_revisions`, `moves`, `move_attempts`, `resources`, `attempt_resources`, `element_resources`, `outbox`. Собственные ID и ссылки — UUID. Внешний user ID остаётся исходной строкой Auth. Каждая связь проверяется в области владельца, включая составные FK. Web передаёт только ID проверенной сессии. MCP фиксирует владельца конфигурацией и игнорирует входной `user_id`. NATS доступен только доверенным внутренним потребителям с ACL.

Элемент имеет тип `level|mission|quest|goal|task`, необязательного родителя и текущую неизменяемую ревизию. Корневые Цели и Задачи разрешены. Указанный родитель следует иерархии Level → Mission → Quest → Goal → Task. Ревизия содержит title, description, fields (структурированные авторские поля). Ожидаемые результаты не заменяют фактические ресурсы. Геометрия полотна хранится отдельно в браузере.

Ход имеет `element_id` владельца, `target_element_id`, `previous_move_id`, тип `operation|action`, назначение `work|start|accept|finish|confirm|review|final`, title, instructions, fields и conditions. Числового порядка исполнения нет. Внутри Задачи допускается только одно продолжение одного предшественника. Выше Задачи независимые ветки допустимы, автоматическое слияние ресурсов не поддерживается. Один владелец не может одновременно запускать разные Ходы одной Задачи.

Попытка фиксирует запуск, исполнителя, ключ безопасчного повтора, входы, результат и ошибку. `attempt_resources` содержит только входные пары; выходы определяет `resources.created_by_attempt_id`. `element_resources` имеет роли `input|output`. Ресурс не копируется при повторном использовании. Исторические даты могут быть null; `recorded_at` обозначает запись реконструкции, а не дату прошлого события.

## Транспорт

Сохраняются subjects `brai.elements.v1.query.{graph,element,timeline,moves}` и `brai.elements.v1.command.{create,revise,activate,claim,complete}`. Добавлены `command.fail` и `command.link`. MCP предоставляет соответствующие `elements_*` инструменты; точные схемы — [messages.schema.json](schemas/messages.schema.json) и `toolInputs` в адаптере MCP. NATS Services поддерживает PING/INFO/STATS и queue `service_elements`. Ошибки передаются `Nats-Service-Error` и `Nats-Service-Error-Code`.

- `create`: `{user_id,elements:[{id?,revision?,kind,parent_id?,title,description?,fields?}],moves:[{id?,element_id,target_element_id?,previous_move_id?,kind,purpose?,title,instructions?,fields?,conditions?}]}`. Пакет атомарен. Родители и предшественники создаются до зависимых записей. Создание с уже занятым ID возвращает CONFLICT без частичных изменений.
- MCP также создаёт отдельный Элемент или Ход с теми же полями.
- `revise`: `{user_id,element_id,revision_id,title,description?,fields?}`. `revision_id` — ключ безопасного повтора. Повтор той же версии возвращает её; другая сущность или заголовок с тем же ID — CONFLICT. Завершённые Элементы не редактируются.
- `activate`: `{user_id,element_id,cancel?}`. Без cancel активирует черновик. `cancel:true` отменяет незавершённую ветку, её ненужные Ходы и активные попытки без ожидания приёмки. Завершённые результаты сохраняются.
- `claim`: `{user_id,move_id,idempotency_key,executor_kind,executor_id?,attempt_id?}`. Operation исполняет agent/system; Action — human. Повтор ключа возвращает первоначальную попытку. Входы собирает сервис: входы владельца плюс входы и выходы успешной попытки предшественника. Последующие изменения их не переписывают.
- `complete`: `{user_id,attempt_id,result:{resources:[{id?,title,content,metadata?,artifact_ids?}]}}`. Создаёт текстовые выходы и завершает попытку атомарно. Повтор успешной попытки возвращает прежний результат без новых ресурсов. Файлы остаются в Artifacts: каждый artifact ID проверяется через его get-контракт, ownerId и ready; байты здесь не хранятся.
- `fail`: `{user_id,attempt_id,error_code}`. Сохраняет технический сбой и возвращает тот же Ход в planned. Новый ключ claim создаёт новую попытку; история сохраняется.
- `link`: `{user_id,after_move_id,before_move_id,moves:[operation,action]}`. После подтверждённых человеческих замечаний вставляет ровно доработку и повторное рассмотрение. Имена и ID старых записей сохраняются; меняется предшественник продолжения. Повтор уже применённой вставки отклоняется без новых записей.

`conditions.required_resources` содержит известные UUID необходимых входов. `conditions.decisions` содержит `{element_id,stage,outcome?}`. Для planning требуется подтверждение текущей ревизии и outcome approved. Для final — success. Решение создаётся только успешной человеческой попыткой с metadata `{element_id,revision_id?,stage,outcome}`; сервис проверяет целевой Элемент и записывает confirmed_by. Постановка не подтверждает доступы и деньги автоматически.

Рабочие Ходы Задачи и start ребёнка ждут подтверждения актуальной постановки владельца. Accept и finish всегда ждут финального решения именно по целевому Элементу. Finish дополнительно ждёт завершения или отмены детей. Accept сам закрывает ребёнка и связывает созданные итоги как output; закрытие не является отдельным ресурсом. Start фиксирует входы ребёнка. План и внутренние Ходы создаёт вызывающий через API; автономный планировщик не добавлен.

`graph` принимает `{user_id}` и возвращает полную личную карту BoardData: `elements` (id,kind,parentId,status,revision,title,description,fields,provenance,input,output), `moves` (id,ownerId как UUID Элемента,targetId,previousId,kind,purpose,title,status,attemptId,executor,instructions,fields,conditions,input,output), `resources` (id,attemptId,title,content,metadata,artifactIds), `attempts`, `revisions`, `links:[]`. Чужие записи не входят в ответ. `element` выбирает запись по element_id; `moves` — доступные Ходы; `timeline` — до 100 последних попыток, без курсора. Дальнейшую пагинацию не обещаем.

## Гарантии и ограничения

Изменения сериализуются транзакционной advisory-блокировкой владельца; SQL timeout 10s. Предметное изменение и outbox записываются одной транзакцией. Доставка использует прежний JetStream `BRAI_ELEMENTS_EVENTS_V1` и consumers History/Alerts; PubAck предшествует отметке published. Повтор использует прежние ID и содержимое. Outbox не является вторым общим журналом. События не содержат текст ресурсов и секреты. Категории execution/execute, exchange/import подтверждены через актуальный History MCP.

Пределы транспорта: запрос 65536 bytes, ответ 524288 bytes; входная очередь 64, активных запросов 8, deadline 10s. Ошибки: INVALID_ARGUMENT (400), NOT_FOUND (404 для отсутствующей и чужой записи), FORBIDDEN (403), CONFLICT/INVALID_STATE (409), BUSY/DATABASE_UNAVAILABLE (503), DEADLINE_EXCEEDED (504), INTERNAL (500). Слишком большая карта возвращает ошибку; потоковый обход не реализован.

CLI `dist/import-snapshot.js <private-json>` принимает снимок и владельца из защищённой среды. Частный набор не входит в публичный репозиторий. Импорт атомарен; повтор не перезаписывает существующие записи, частичный или чужой набор отклоняется. Событие фиксирует именно импорт реконструкции сегодня. Исторические даты, реальные сайты, телефон и секреты не восстанавливаются догадкой.

# Контракт Каналов v1

Статус: контракт v1 реализован в общей невыпущенной области с адаптером Приёма. Машинные определения: [AsyncAPI](asyncapi.yaml), [DTO](schemas/common.schema.json), [операции](schemas/api.schema.json). Выпуск и переключение Telegram не разрешены; несовместимые уточнения согласуются отдельно.

Первый профиль — Telegram через существующий адаптер Hermes. Согласованная граница потребителя: [Приём](../intake/CONTRACT.md). Контракт и история источника: [История](../history/CONTRACT.md). Для новых типов добавляется версия профиля, а не исполняемый код в пользовательской конфигурации.

## 1. Ответственность и сущности

Каналы владеют типами, подключениями, каналами, версиями настроек/правил, результатами определения канала и квитанциями административных операций. Приём владеет оригиналом поступления и исполнением сценария; Контакты — людьми и профилями; Входящие — сообщениями; Артефакты — файлами; Понимание — машинными результатами.

Три уровня:

| Сущность | Идентичность | Изменяемые настройки |
| --- | --- | --- |
| Тип | code и положительная целая version | Новая схема/поведение — новая неизменяемая версия профиля |
| Подключение | UUID, ownerId, type, sourceId, внешний botId | Имя, enabled, credentialsRef, разрешённые отправители, extensions |
| Канал | UUID, ownerId, connectionId, kind, точный chatId/threadId, parentId | Имя, enabled, locationRef, разрешённые отправители, полный набор правил, extensions |

В пользовательском дереве бот является корнем подключения. Для приёма сообщений «бот без темы» означает конкретный диалог бота: kind=dialog, chatId задан, threadId=null. kind=topic требует chatId и threadId. Сам botId без chatId не является маршрутом и не даёт wildcard-доступа ко всем чатам. Такой технический контекст сохраняет договорённость «бот и его топики», не смешивая личные диалоги разных людей.

parentId у topic может ссылаться только на dialog того же подключения и chatId. Отсутствие родителя допустимо. Иерархия не задаёт наследование правил; отключение всего бота выполняется через подключение. Адрес и принадлежность после создания неизменяемы: другой адрес — новый канал.

Telegram IDs — строки: botId и actor ID — положительные decimal, chatId — ненулевой signed decimal, threadId — положительный decimal либо null. null не равен нулю, единице или любой теме. Особенности General и threaded mode нормализует закреплённый профиль адаптера, без универсального предположения thread=1.

## 2. Транспорт и доверенный контекст

Целевой транспорт — NATS Services service_channels, API subjects v1. У каждого endpoint кроме status есть suffix callerId. Реальная NATS identity через ACL получает доступ только к разрешённым subjects; суффикс не выбирается произвольным payload. Runtime binding связывает callerId с разрешёнными ownerId, sourceId, подключениями и операциями. Полномочия не берутся из полей ownerId, author или actorId.

Вход источника подтверждают Telegram/Hermes-адаптер и NATS. Для входящего сообщения sourceId совпадает с входной привязкой подключения, botId проверяется отдельно. У ответа producer sourceId иной, например hermes_replies: он проверяется как разрешённый источник ответов, а подключение определяется по исходному Resolution. Похожий JSON не даёт права выбрать другой бот. Минимальная bootstrap-привязка транспорта применяется оператором согласованно с подключением; API Каналов не создаёт NATS credentials/ACL и не принимает токены Telegram.

credentialsRef — непрозрачная ссылка на защищённые credentials, не значение секрета, произвольный файловый путь, HTTP URL или NATS subject. Она возвращается административным читателям и авторизованной доставке; в разрешённый контекст сообщения не входит. Заявленный actorId предназначен для происхождения изменения, а не авторизации.

Ошибка NATS Services передаётся заголовками Nats-Service-Error и Nats-Service-Error-Code; JSON тела: {code,message,retryable}. Тексты безопасны и не содержат payload, токены или сведения другого владельца.

## 3. Общие форматы

Все объекты закрытые: неизвестные поля отвергаются, кроме явно выделенного extensions. Необязательные поля ниже имеют указанные defaults; остальные обязательны. Идентификаторы сущностей/результатов/команд — UUID; operationId — непустая строка до 255 символов. ownerId и внешние refs — непустые строки до 255. sourceId/callerId: строчная латиница, цифры и _, начинается с буквы, до 64.

Время — RFC3339 с timezone, не более 6 дробных знаков; ответы UTC. Целые version/expectedVersion — от 1 до 2147483647. Хеш — SHA-256 канонического JSON: ключи объектов сортируются рекурсивно, порядок массивов сохраняется, UTF-8, без добавления пробелов; отсутствие и явный null различаются. JSON с NUL, непарным суррогатом или не конечным числом недопустим.

Типизированные структуры:

| Имя | Поля |
| --- | --- |
| TypeRef | code:string, version:integer |
| TelegramAddress | botId:string, chatId:string, threadId:string или null |
| ConnectionSettings | name:string(1..128), enabled:boolean, credentialsRef:string(1..255), allowedActorIds:string[1..1000], extensions:object по правилам ниже |
| ChannelSettings | name:string(1..128), enabled:boolean, locationRef:string(1..255), allowedActorIds:string[1..1000], rules:Rule[0..100], extensions:object |
| ConnectionVersion | id, ownerId, type, sourceId, botId, version, effectiveFrom, recordedAt, settings |
| ChannelVersion | id, ownerId, connectionId, kind:dialog или topic, address:TelegramAddress, parentId:UUID или null, version, rulesVersion, effectiveFrom, recordedAt, settings |
| FieldValues | categoryRefs?:string[0..100], creatorRef?:{kind:person/contact/agent/external,id:string} или null, title?:string(1..512) или null |
| OperationReceipt | requestId, operation, ownerId, inputHash, committedAt, result, historyEvent |
| Page | items:массив, nextCursor:string или null |

Списки IDs не содержат дублей. allowedActorIds подключения и канала проверяются пересечением; пустой список запрещён, доступ «всем» не предусмотрен. Обязательное имя/ID не может состоять только из пробелов. display-имена не участвуют в сопоставлении.

extensions — объект с ключами namespace по шаблону code.namespace; не более 8 KiB UTF-8 JSON, глубина до 8. Значения — JSON-данные. Расширения не дают прав, не запускают операции и не переопределяют стандартные поля. Секреты в extensions запрещены. Для включения нового действующего поля нужна зарегистрированная типизированная схема профиля; неизвестные task-параметры можно сохранить как расширение, но нельзя автоматически применять.

## 4. Операции

Во всех строках subject начинается с brai.channels.v1.; {callerId} — защищённая привязка вызывающего. Форматы обозначены по разделам 3–8. Операции ниже — обязательства будущей реализации, не уже существующий API.

| Операция / suffix subject | Запрос | Ответ и эффект |
| --- | --- | --- |
| types.list.{callerId} | {limit?:1..100=50,cursor?:string=null} | Page<TypeDescriptor>; чтение разрешённых профилей |
| types.get.{callerId} | {type:TypeRef} | TypeDescriptor с кодом/версией, capabilities, схемами настроек и sourceRef |
| connections.create.{callerId} | {requestId,ownerId,actorId:string или null,reason:string(1..512),type,sourceId,botId,settings:ConnectionSettings} | OperationReceipt с result:ConnectionVersion версии 1; создание подключения |
| connections.publish.{callerId} | {requestId,ownerId,actorId,reason,connectionId,expectedVersion,settings:ConnectionSettings} | OperationReceipt с новой полной ConnectionVersion |
| connections.get.{callerId} | {ownerId,connectionId,version?:integer} | Указанная ConnectionVersion; без version — последняя |
| connections.list.{callerId} | {ownerId,limit?:1..100=50,cursor?:string=null} | Page<ConnectionVersion> последних версий |
| channels.create.{callerId} | {requestId,ownerId,actorId,reason,connectionId,kind,address,parentId:UUID или null,settings:ChannelSettings} | OperationReceipt с ChannelVersion версии 1 |
| channels.publish.{callerId} | {requestId,ownerId,actorId,reason,channelId,expectedVersion,settings:ChannelSettings} | OperationReceipt с новой полной ChannelVersion; правила меняются атомарно с ней |
| channels.get.{callerId} | {ownerId,channelId,version?:integer} | Указанная ChannelVersion; без version — последняя |
| channels.list.{callerId} | {ownerId,connectionId?:UUID,limit?:1..100=50,cursor?:string=null} | Page<ChannelVersion> последних версий |
| resolve.{callerId} | ResolveRequest, раздел 5 | Resolution; чтение версий и атомарная фиксация результата |
| delivery.check.{callerId} | DeliveryCheckRequest, раздел 6 | DeliveryPermission; проверка текущего права, без отправки |
| operations.get.{callerId} | {ownerId,requestId} | OperationReceipt ранее committed изменения; чужое/отсутствующее — NOT_FOUND |
| status | {} | {ready:boolean,database:boolean,configuration:boolean,contractVersion:"1"} |

TypeDescriptor: {type:TypeRef,name,capabilities:{messageIncoming:true,messageReply:true,genericEvents:false,channelKinds:["dialog","topic"]},connectionSettingsSchema,channelSettingsSchema,sourceRefSchema}. Схемы — JSON Schema Draft-07 конкретной версии профиля. В v1 миграция поставляет telegram/1; API регистрации произвольного типа, кода или схемы нет.

Ротация credentialsRef, включение/отключение, переименование и редактирование правил выполняются publish, без отдельных неоднозначных patch/enable/update операций. Физического удаления и переноса объекта между owner нет. get/list не обращаются к Telegram и не проверяют работоспособность token; это отдельная обязанность оператора/адаптера при настройке.

Пагинация возвращает не более limit элементов и останавливается раньше по пределу ответа; nextCursor указывает продолжение после последнего возвращённого элемента. Публикация не принимает конфигурацию, которая не помещается в предельный read/resolve ответ.

Пагинация использует непрозрачный защищённый cursor с привязкой к caller/owner/фильтрам, порядок по стабильному id. Cursor не является полномочием и не может быть перенесён в другой scope. List не обещает транзакционный снимок всех страниц при конкурентных изменениях.

## 5. Resolve: вход, результат и исторические правила

ResolveRequest имеет поля:

| Поле | Тип / значение |
| --- | --- |
| operationId | Устойчивый ключ конкретного разрешения; для первого Приёма packetId + "/channel" |
| packetId | UUID зарегистрированного пакета |
| ownerId | Доверенный владелец из Приёма, проверяемый по binding caller |
| sourceId | Подтверждённый источник данного события: Telegram-адаптер для входа, Hermes producer для ответа |
| asOf | receivedAt регистрации брокером, сохранённое Приёмом; не occurredAt отправителя |
| eventType | message.incoming или message.outgoing |
| direction | incoming либо outgoing, согласованное с eventType |
| sourceRef | TelegramAddress, без произвольных raw updates |
| author | {kind:human или agent,id:string}; human для входа, agent для ответа |
| facts | {hasText:boolean,contentKinds:массив уникальных text/image/audio/video/document} |
| initialFields | FieldValues; default {} |
| replyTo | null для входа; {packetId:UUID,resolutionId:UUID} для ответа |

hasText означает непустой основной текст либо подпись; contentKinds включает text тогда и только тогда, когда hasText=true. Остальные виды определяет адаптер по объявленной модальности вложений, без скачивания в Каналах. Пустые facts без текста и модальностей не соответствуют message-профилю.

Для входа Каналы проверяют подключение, историческую доступность, точный channel address и отправителя. Ответ не проходит по human allowlist: его автор — агент, а основание — проверенная связь с прежним входом. Инициативная отправка без исходного разрешённого сообщения в этот первый профиль не входит. Она потребует отдельной согласованной возможности, а не выдачи channelId в обход проверки.

Для нового входа выбираются версии на asOf: интервал [version.effectiveFrom,nextVersion.effectiveFrom), у последней версии правая граница отсутствует. После выбора версии применяются правила. Если вообще нет адреса — CHANNEL_NOT_FOUND; если он известен, но версии на asOf нет — HISTORICAL_CONTEXT_UNAVAILABLE. Текущие настройки не подставляются вместо отсутствующей истории.

Resolution имеет ровно следующие поля:

- resolutionId: UUID, packetId, ownerId, sourceId, asOf, policyAsOf;
- type:TypeRef, connectionId, connectionVersion, channelId, channelVersion, rulesVersion;
- locationRef:string и destination:{transport:"telegram",connectionId,botId,chatId,threadId};
- processing:{mode:"temporal",scenario:"incoming.v1" либо "outgoing.v1"};
- assignments:FieldValues и fieldOrigins: объект происхождения значений;
- appliedRules:[{ruleId:string,priority:integer,rulesVersion:string}];
- basedOnResolutionId: UUID либо null;
- snapshot:{connection:{name:string,type:TypeRef},channel:{name:string,extensions:object},rules:полный массив Rule}.

rulesVersion — канонический SHA-256 полного массива rules. Snapshot не содержит credentialsRef, token, ACL, файлов или текста сообщения. Он вместе с фактическими assignments/fieldOrigins позволяет объяснить результат. Исторические версии не удаляются v1 автоматически. Постоянные внешние refs — ссылки без FK на чужие БД.

Для ответа Каналы загружают прежнее Resolution по replyTo.resolutionId и сверяют owner, packetId, направление входа, подключение и address. Caller и producer sourceId ответа должны иметь явный доступ к этому подключению; sourceId ответа не обязан совпадать с sourceId входного Telegram-адаптера. destination и locationRef берутся из исходного контекста, правила — из его зафиксированной версии; условия пересчитываются для фактов ответа. policyAsOf равен исходному времени политики, asOf — времени нового ответа, basedOnResolutionId — исходному resolutionId. Изменение нынешних правил не перенаправляет ответ.

Ключ resolve: (callerId,ownerId,operationId). Вход хешируется целиком после применения объявленных defaults. Тот же ключ/хеш возвращает тот же Resolution; другой input — REQUEST_ID_CONFLICT. Результат и ключ сохраняются в одной транзакции. Непринятый запрос не резервирует успешную квитанцию. Проверка прав caller выполняется и при повторе. Read-доступ к историческому снимку сам по себе не даёт разрешения отправить сообщение. Вместе с квитанцией сохраняется минимальный нормализованный запрос, включая исходного human actor, для проверки отзыва доступа; полного сообщения и raw update там нет.

Новое разрешение для отключённого сейчас подключения/канала возвращает DISABLED; успешный прежний resolve при точном повторе возвращает сохранённый снимок. Уже принятая обработка не аннулируется молча. Прекращение её вычислений относится к сценарию, а отправка всегда проверяется заново по разделу 6.

В v1 resolve принимает только историческую политику поступления. Пересчёт по новым правилам не маскируется сменой asOf/operationId: для него нужен отдельный будущий контракт с явным основанием и effective snapshot.

## 6. Текущее право доставки

DeliveryCheckRequest: {ownerId,resolutionId,destinationHash}. Hash вычисляется от полного сохранённого destination по правилу раздела 3. Запрос принимает только caller с правом доставки; caller не может подставить другой destination.

Положительный ответ: {allowed:true,resolutionId,destinationHash,checkedAt,connectionVersion,channelVersion,credentialsRef}. Версии здесь текущие, а destination остаётся из Resolution. credentialsRef доступна только этому доверенному порту и не добавляется в inbox/снимок.

Проверяются текущие enabled подключения/канала, разрешение caller, сохранённая идентичность bot/address и соответствие hash. Дополнительно исходный human actor из входного Resolution должен по-прежнему входить в оба текущих allowedActorIds; author=agent у ответа не обходит отзыв прав инициатора. Отрицательный результат — явная ошибка DISABLED, FORBIDDEN или DESTINATION_CONFLICT; ответа allowed:false с неясным эффектом нет.

Разрешение не является долговечным разрешительным token: его нельзя кешировать или считать квитанцией отправки. Доставка делает проверку непосредственно перед каждой фактической отправкой/порцией набора. Таймаут — отсутствие разрешения; автоматического обхода нет. Отзыв не может отменить HTTP-запрос, уже отправленный Telegram. Каналы не гарантируют атомарность проверки с чужим внешним API и не разрешают повтор неизвестной доставки.

## 7. Административные версии и повторы

Create/publish сначала проверяют права и полный DTO. Ключ (callerId,ownerId,requestId) общий для всех мутирующих операций; хеш включает имя операции и весь нормализованный запрос. Точный повтор возвращает первоначальную квитанцию до проверки текущего expectedVersion. Тот же requestId с иной операцией/содержимым — REQUEST_ID_CONFLICT.

Publish имеет сравнение expectedVersion с последней committed версией. Конкурирующие изменения дают одного победителя и VERSION_CONFLICT второму; номер новой версии = previous+1. Данные, новая версия, исходная квитанция и факт изменения фиксируются в одной транзакции. Потеря ответа после COMMIT не создаёт следующую версию при повторе.

В v1 публикация вступает в силу немедленно: effectiveFrom и recordedAt назначает БД внутри сериализованной транзакции публикации. Версия становится видимой только после COMMIT. Сериализация публикации и первого resolve одного ресурса должна исключать неоднозначный выбор версии. Задним числом менять effectiveFrom и редактировать payload прежней версии нельзя; effectiveTo выводится из следующего effectiveFrom. Планирование будущего включения отложено: оно не должно помешать немедленному отзыву доступа.

Адреса каналов уникальны внутри owner/подключения; sourceId и внешний бот однозначно связаны с подключением. Создать вторую активную интерпретацию того же адреса запрещено. sourceId нельзя переиспользовать для другого владельца/бота после отключения: это новая идентичность.

Настройки правил и канала публикуются одним полным ChannelSettings, чтобы resolve не увидел половину обновления. Имена, порядок правил и расширения являются частью нормализованного input; сервер не переставляет массивы молча. Канонический список allowedActorIds нормализуется сортировкой до хеширования, как множество; это единственное специальное правило нормализации списков.

## 8. Детерминированные правила

Rule: {id:string(1..64),priority:integer(-100000..100000),when:Condition[0..16],assign:Assignment[1..32]}. IDs уникальны в наборе; rulesVersion версионирует весь набор. Все when объединяются AND; пустой when означает безусловное правило.

Condition: {field,op,value}. Поля: eventType,direction,author.kind,author.id,facts.hasText,facts.contentKinds. Операции:

- equals — равенство scalar допустимого типа, не применяется к массиву contentKinds;
- in — непустой массив до 100 значений правильного типа; для scalar — принадлежность, для contentKinds — непустое пересечение;
- exists — boolean value; проверяет наличие, отсутствие и null, не истинность значения.

Неизвестное поле, неверный тип, вложенное выражение, произвольный путь, JS/SQL/regex или сетевой вызов отклоняются. При равном priority правила с разными полями сохраняют порядок массива; конфликт одного поля уже запрещён. Условия читают первоначальные facts, а не значения, изменённые предыдущим правилом.

Assignment: {field:categoryRefs/creatorRef/title,mode:fill_missing/override,value:тип соответствующего поля FieldValues}. Одно правило назначает поле один раз. Порядок — priority по возрастанию; более высокий override применяется позже. На одном priority два назначения одного поля запрещены при публикации даже при кажущихся взаимоисключающими условиях. Скрытого выбора по ID нет.

fill_missing действует только для отсутствующего поля. Явный null — сохранённое неизвестное значение, оно меняется только override. categoryRefs заменяется целым массивом: неявного слияния нет. appliedRules перечисляет правила, реально выполнившие хотя бы одно присваивание, в порядке исполнения.

fieldOrigins содержит запись для каждого присутствующего поля assignments:
{source:"input",ruleId:null,rulesVersion:null,mode:null} для сохранённого initialFields либо
{source:"rule",ruleId,rulesVersion,mode} для итогового назначения. Сведения до override остаются в оригинале поступления и исходной версии правил; оригинал не переписывается.

Правила не назначают owner, source, автора сообщения, credentials, destination или mode/scenario. creatorRef описывает создателя материала отдельно от фактического отправителя. Параметры задач, новые разделы, JEV hints и выбор иных сценариев потребуют типизированного расширения контракта; сохранение extensions не означает поддержку их исполнения.

## 9. Факты изменений и История

Каждая административная квитанция содержит сохранённый historyEvent для source=service_channels, scope=user/ownerId, object_type=channel_connection либо channel, object_id=id, actor_id=заявленный actorId. type_id=101 для создания и 1301 для публикации версии; occurred_at фиксируется вместе с фактом, UUID не меняется при повторе. data содержит только operation,requestId,version,previousVersion и список изменённых имён полей; без credentialsRef, allowedActorIds, raw запроса и содержания правил.

historyEvent имеет точный append DTO {id,type_id,occurred_at,actor_id,scope_type,scope_id,object_type,object_id,data}; recorded_at назначит История. Схема History определяется её владельцем; source назначается авторизованным subject append.service_channels и не передаётся в append DTO. Настройка enabled — изменение конфигурации, а не обещание фактического connect/disconnect с Telegram.

Административный координатор обязан сохранять команду долговечно и доставлять historyEvent существующему API Истории с тем же ID/содержимым до окончательного подтверждения своей операции. Temporal может вести этот короткий административный сценарий вне Каналов. OperationReceipt означает COMMIT у Каналов, а не запись в Историю; утраченный ответ восстанавливается повтором или operations.get. Пока такого координатора нет, API изменения не подключается к внешнему UI как «полностью завершённая операция».

У Каналов нет собственного scheduler/outbox-dispatcher и ложного обещания атомарности с чужой БД. Resolve, get/list и status не создают отдельные факты Истории на каждое чтение; назначение правил уже фиксируется поступлением Приёма. Прямой NATS-вызов управления без долговечного координатора не обеспечивает гарантию доставки аудита.

## 10. Ошибки и пределы

| Code | NATS-Service-Error-Code | Повтор |
| --- | --- | --- |
| INVALID_ARGUMENT | 400 | Исправить запрос |
| FORBIDDEN | 403 | Не повторять автоматически |
| NOT_FOUND | 404 | Чужое и отсутствующее для чтения неразличимы |
| CHANNEL_NOT_FOUND | 404 | Настроить допустимый маршрут |
| AMBIGUOUS_CHANNEL | 409 | Исправить конфигурацию; не выбирать случайно |
| DISABLED | 409 | Явное вмешательство, не автоматический успех |
| VERSION_CONFLICT / REQUEST_ID_CONFLICT / DESTINATION_CONFLICT | 409 | Разобрать конфликт; прежний ключ не менять молча |
| HISTORICAL_CONTEXT_UNAVAILABLE | 409 | Отдельное решение о пересчёте |
| INVALID_RULE_SET / UNSUPPORTED_PROFILE | 422 | Исправить настройки/профиль |
| REQUEST_TOO_LARGE / RESPONSE_TOO_LARGE | 413 | Сократить данные; resolve не фиксирует непередаваемый ответ |
| BUSY / NOT_READY | 503 | Технический повтор с прежним ключом |

Вход ≤64 KiB, ответ ≤128 KiB UTF-8. До 8 активных запросов на процесс, без собственной ожидающей очереди; перегрузка BUSY. Серверный deadline 5 секунд включает SQL; слот освобождается после фактической остановки SQL, не по одному таймеру. Клиентский таймаут не откатывает COMMIT. Вызов Приёма может ожидать до его текущих 15 секунд; повтор выполняет Temporal с тем же operationId.

Status и NATS PING различаются: PING отвечает экземпляр, ready требует доступной собственной БД, схемы и валидной конфигурации caller/profile. Temporal, Telegram, Контакты и Входящие не являются зависимостями readiness Каналов. Временная недоступность Каналов не разрешает Приёму подставить синтетический маршрут.

## 11. Связка с Приёмом

Ранее кандидат 41799f1 передавал общий конверт channel. Адаптер в общей невыпущенной области заменяет его узким ResolveRequest; старый конверт новый API не принимает.

Адаптер Приёма выполняет следующие требования:
1. Построить ResolveRequest из проверенных source/owner, сохранённого receivedAt, eventType/author/sourceRef и фактов содержимого. Текст, байты файлов и лишние данные не передавать.
2. Для ответа взять исходный resolutionId из сохранённого контекста родительского пакета и передать replyTo; не доверять произвольному replyContext из нового события.
3. Провалидировать полный Resolution по owner-схеме и связать packetId/owner/source/asOf, версию, адрес, mode/scenario с ожиданиями.
4. Сохранить полный Resolution неизменяемо как context; сохранить фактические assignments/fieldOrigins отдельно от оригинала и передать их Входящим/Пониманию. initialFields текущего профиля сообщения = {}, пока эти поля не появятся в его собственном контракте.
5. Сохранить предметные коды ошибок: для Каналов сохраняются безопасный предметный code и retryable в dependencyFailure пакета, без копирования текста payload. Прочие порты сохраняют общее преобразование ошибок.
6. Для доставки добавить обязательный delivery.check у исполнителя. Сам Приём не отправляет Telegram и не владеет его токеном.

Существующие входящие/исходящие message workflows сохраняют фиксированные temporal/incoming.v1 и temporal/outgoing.v1. event.recorded идёт через JetStream без resolve. Каналы v1 не могут изменить это записью в БД: универсальный выбор режима/получателя требует отдельной доработки до фиксации routing decision. Снимок правил сам по себе не означает, что downstream уже умеет применять новые поля.

Проверка интеграции: реальный resolve с Приёмом на изолированном стенде; смена правил между receivedAt и обработкой; точный повтор после lost response; ответ после смены назначения; отключение до отправки; два бота/чата/топика; конкурирующие publish; атомарность receipt/version; минимальные права; отсутствие секретов. После этого — общий Telegram-комплект и отдельная приёмка включения. Самостоятельный выпуск Приёма или переключение рабочего Telegram этим контрактом не разрешаются.

## 12. Пример первого входа и правила

Синтетический ResolveRequest от Приёма:

~~~json
{
  "operationId": "11111111-1111-4111-8111-111111111111/channel",
  "packetId": "11111111-1111-4111-8111-111111111111",
  "ownerId": "owner_example",
  "sourceId": "telegram_bot_1",
  "asOf": "2026-10-31T00:00:00Z",
  "eventType": "message.incoming",
  "direction": "incoming",
  "sourceRef": {"botId":"123456","chatId":"654321","threadId":"17"},
  "author": {"kind":"human","id":"654321"},
  "facts": {"hasText":true,"contentKinds":["text"]},
  "initialFields": {},
  "replyTo": null
}
~~~

Ответ при пустом наборе правил:

~~~json
{
  "resolutionId": "22222222-2222-4222-8222-222222222222",
  "packetId": "11111111-1111-4111-8111-111111111111",
  "ownerId": "owner_example",
  "sourceId": "telegram_bot_1",
  "asOf": "2026-10-31T00:00:00Z",
  "policyAsOf": "2026-10-31T00:00:00Z",
  "type": {"code":"telegram","version":1},
  "connectionId": "33333333-3333-4333-8333-333333333333",
  "connectionVersion": 1,
  "channelId": "44444444-4444-4444-8444-444444444444",
  "channelVersion": 1,
  "rulesVersion": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "locationRef": "space:example",
  "destination": {
    "transport":"telegram",
    "connectionId":"33333333-3333-4333-8333-333333333333",
    "botId":"123456","chatId":"654321","threadId":"17"
  },
  "processing": {"mode":"temporal","scenario":"incoming.v1"},
  "assignments": {},
  "fieldOrigins": {},
  "appliedRules": [],
  "basedOnResolutionId": null,
  "snapshot": {
    "connection":{"name":"Пример бота","type":{"code":"telegram","version":1}},
    "channel":{"name":"Входящие","extensions":{}},
    "rules":[]
  }
}
~~~

Ответ Hermes получит собственные packetId/operationId, sourceId=hermes_replies и author.kind=agent, а replyTo={packetId исходного входа,resolutionId исходного разрешения}. Даже после переназначения топика destination и locationRef останутся связанными с этим входом. Перед Telegram-доставкой выполняется отдельная текущая проверка разрешения.

Пример назначения категории входящим изображениям:

~~~json
{
  "id":"incoming_images",
  "priority":10,
  "when":[
    {"field":"direction","op":"equals","value":"incoming"},
    {"field":"facts.contentKinds","op":"in","value":["image"]}
  ],
  "assign":[
    {"field":"categoryRefs","mode":"fill_missing","value":["category:images"]}
  ]
}
~~~

Включение этого правила в массив rules изменит rulesVersion. Строки category:images и space:example — внешние refs, не обращения Каналов к чужой БД.

~~~mermaid
sequenceDiagram
    participant I as Приём
    participant C as Каналы
    participant B as Входящие / Понимание
    participant D as Доставка
    I->>C: resolve: source, receivedAt, признаки, operationId
    C->>C: Исторические версии + правила + квитанция
    C-->>I: Неизменяемый Resolution
    I->>I: Сохранить context и происхождение назначений
    I->>B: Оригинал, ссылки, снимок и назначения
    D->>C: delivery.check сохранённого назначения
    C-->>D: Текущее разрешение или явный отказ
~~~

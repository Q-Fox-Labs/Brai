# Личные данные после Telegram identity cutover

Политика `brai-personal-v1` отделяет новые History, Timer, Alerts и Goals от
смешанного старого технического владельца. Физический scope равен
`brai-personal-v1:` + SHA256 UTF-8 JSON.stringify([`brai-personal-v1`, profileId]).
profileId берётся только из проверенного Auth principal или root registry.
Все профили, включая первоначального администратора, получают новый scope.
Канонические Auth userId и Artifacts ownerId остаются прежними.

Hermes server runtime и Web server выводят scope одним публичным helper.
Модель, HTTP body, query и header не выбирают scope. Header expectedUserId
продолжает проверять канонический аккаунт; SSE подписан на физический scope.
Смена profileId завершает старый SSE. Старые события, отложенные outbox и
повторы JetStream остаются в старом scope без преобразования владельца.

Alerts в этом зарезервированном namespace читает только собственные user
notifications. Старые system/global записи и null-сигналы не выдаются.
Глобальные уведомления нового epoch требуют отдельного удостоверенного
producer-контракта; timestamp нового ingestion не доказывает новое происхождение.
Старые записи и streams сохраняются как операторский архив. Автоматического
переноса неоднозначных записей нет.

Local AI сохраняет канонический owner: он проверяет Artifacts тем же owner.
Durable operations.get читает только installation_operations, без результатов
inference. При cutover оператор повторно проверяет отсутствие старых записей
и активных операций; ненулевой ledger блокирует квитанцию и требует отдельной
атрибуции. Остановка старого producer очищает неперсистентные invocation jobs.

Квитанция активации содержит epoch, hashes helper/policy/operator, accounts,
7 уникальных user/profile/scope bindings (SHA256 от исходной UTF-8 строки),
счётчики read-only исходников и время не раньше freeze. Любая смена политики,
accounts или программных байтов требует повторной проверки.

GameCore пока недоступен в Telegram identity через Web и Hermes: существующий
контракт использует один owner для графа и проверки канонических Artifacts.
Нужен удостоверенный actor/data-scope контракт перед подключением. Общий сервис
и прежний email-режим продолжают работать. Прямые HTTP API также закрыты.
Local AI History facts продолжают публиковаться в канонический scope и остаются
в архиве; новые вычисления и канонические Artifacts работают.

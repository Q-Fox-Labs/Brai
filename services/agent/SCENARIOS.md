# Сценарии agent

Прикладное ядро находится в `src/application.ts`, владелец состояния — в `src/state.ts`, ограниченная история — в `src/history.ts`. Ядро получает `CodexPort` и явный список проектов. Оно не импортирует транспорт, NATS или пользовательский интерфейс.

## API приложения

```ts
createApplication({
  codex: CodexPort,
  projects: ProjectDefinition[],
  allowedModels?: string[],
  onObservation?: (event, session, state) => void,
  onResync?: (session) => void,
})
```

Фабрика возвращает методы `projects()`, `status()`, `threads(request)`, `thread(request)`, `history(request)`, `threadCreate(request)`, `turnStart(request)`, `turnSteer(request)`, `turnInterrupt(request)`, `requestRespond(request)` и `close()`. Типы `request` берутся из `contracts/index.d.mts`. Результаты проверяются `validateDto` перед возвратом.

`projects` задаёт `projectId`, `name` и абсолютный `cwd`; `available: false` скрывает недоступный проект. `allowedModels` отсутствует по умолчанию. Если список передан, ядро проверяет фактическую `model` из ответа `thread/start` или `thread/resume` до `turn/start`. Отклонённая модель даёт `UNSUPPORTED`, и ядро не подбирает замену.

Для нового пустого треда `threadCreate` вызывает `thread/start` с `allowProviderModelFallback: false` и не запускает ход. Открытие существующего треда проверяет исходные `threadId` и `cwd`, вызывает `thread/resume` только по явному ID с `excludeTurns: true` и повторно передаёт ожидающие формы через подписку Codex. Открытие и чтение истории не начинают ход.

У `thread/resume` и `turn/start` нет поддерживаемого параметра, отключающего fallback модели у провайдера. Ядро не добавляет для этого неизвестную настройку. Для существующего треда оно проверяет сообщённую модель, но не обещает отключить внутренний fallback провайдера.

## Состояние и история

`createState()` единолично хранит загруженные сеансы, активные ходы, формы, проекционные сообщения и трассу, поколения, эпохи потока, последовательность и журнал операций. Публичные методы состояния дают проекции ограниченные операции записи; `onObservation(event, session, state)` передаёт наблюдение для следующей стадии без второго владельца данных.

Пределы состояния: 16 загруженных сеансов, 4 активных хода, 64 ожидающие формы суммарно и 128 KiB их параметров, 32 KiB на форму, 4096 записей журнала операций. Журнал не вытесняет старые операции. LRU вытесняет только неактивный сеанс без незавершённого открытия и вызывает `onResync`.

`history(request)` читает по одной ограниченной странице элементов. Курсор связывает `projectId`, `threadId` и выбор явного хода; он продолжает страницу элементов, затем страницы ходов. Порядок и upstream ID элементов сохраняются. История не загружает полный тред. Она возвращает reasoning summary без raw reasoning content, ограничивает текстовые поля 500 UTF-8 bytes и итоговый DTO 768 KiB.

Повторное применение одной операции с тем же `generation`, `operationId` и содержимым возвращает сохранённый Promise или результат. Повтор ID с другим содержимым даёт `OPERATION_CONFLICT`. Неопределённый исход мутации остаётся в журнале и автоматически не повторяется. Ошибки можно передать в `toErrorResponse(error, generation, operationId?)`, который возвращает безопасный `ErrorResponse` и HTTP status.

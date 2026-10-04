# Сценарии

`threads` читает настроенный cwd. `create` передаёт явные newThread настройки и возвращает native id. `open` подключает existing thread и объединяет native snapshot с уже полученными observations. `turns/items` читают сохранённую историю с native cursor.

`start` резервирует один активный ход и передаёт text/images. До эффекта проверяет закрытые data URLs, суммарные decoded bytes, MIME signatures и поддержку изображений выбранной моделью. При not-sent резерв снимается; unknown требует чтения состояния. `steer` проверяет expectedTurnId и поддержку image моделью активного хода, `interrupt` — текущий turnId. `answer` проверяет исходный request и native answer schema до claim; второй ответ получает stale request.

Обрыв соединения меняет generation и инвалидирует формы. Повторное подключение не повторяет мутацию; `open` восстанавливает доступное состояние через native API. Web переподключается только для чтения. App server может потерять выполнение при собственном рестарте; продолжение такого процесса не обещается.


`start` явно выбирает native default/plan с моделью и effort внутри collaboration settings. Default после plan снимает его встроенные инструкции. `start(agentMode=goal)` задаёт default settings и новую native цель; goal/set сам начинает ход. Предыдущая цель удаляется, чтобы новое задание не наследовало бюджет и счётчики. Default/plan задание при активной цели сначала приостанавливает её продолжения.

`goalGet` восстанавливает сохранённую native цель; notifications updated/cleared имеют приоритет над запоздавшим чтением. `goalSet(status=active)` снимает plan mode и возобновляет native цель, сохраняя бюджет и счётчики. Pause/clear дополнительно прерывают подтверждённый текущий ход. Если первый этап принят, а interrupt/settings/set следующего этапа завершился ошибкой, исход всей операции unknown: повтор не выполняет её заново, клиент читает состояние.

Native plan item проходит started→delta→completed; завершённый текст authoritative и доступен из native истории. Turn progress существует отдельно, восстановление списком истории не обещается: холодное состояние unavailable, прежний live список после потери соединения stale. Сокращённые материалы явно помечены.

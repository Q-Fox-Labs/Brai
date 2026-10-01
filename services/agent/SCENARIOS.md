# Сценарии

`threads` читает настроенный cwd. `create` передаёт явные newThread настройки и возвращает native id. `open` подключает existing thread и объединяет native snapshot с уже полученными observations. `turns/items` читают сохранённую историю с native cursor.

`start` резервирует один активный ход и передаёт text. При not-sent резерв снимается; unknown требует чтения состояния. `steer` проверяет expectedTurnId, `interrupt` — текущий turnId. `answer` проверяет исходный request и native answer schema до claim; второй ответ получает stale request.

Обрыв соединения меняет generation и инвалидирует формы. Повторное подключение не повторяет мутацию; `open` восстанавливает доступное состояние через native API. Web переподключается только для чтения. App server может потерять выполнение при собственном рестарте; продолжение такого процесса не обещается.

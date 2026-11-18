# ABOUTME: Сериализует команды и проверку передачи живой браузерной сессии.
# ABOUTME: Не переносит данные браузера и не восстанавливает состояние после перезапуска.
"""Защитный механизм для будущего адаптера переключения браузеров."""

import asyncio


class UncertainBrowserState(RuntimeError):
    """Результат команды неизвестен; повтор или переключение запрещены."""


class BrowserSession:
    """Удерживать владельца новой сессии до проверенной передачи другому браузеру.

    Экземпляр создаётся только при создании новой логической сессии. Он не
    восстанавливает состояние после перезапуска: для этого нужен отдельный
    надёжный журнал. Все операции с браузером обязаны проходить через execute.
    """

    def __init__(self, backend, session):
        if not backend or not session:
            raise ValueError('Browser and session are required')
        self._backend = backend
        self._session = session
        self._unknown = False
        self._lock = asyncio.Lock()

    @property
    def backend(self):
        """Вернуть текущего владельца сессии без изменения её состояния."""
        return self._backend

    async def execute(self, operation):
        """Выполнить одну команду; ошибка или отмена оставляют результат неизвестным."""
        async with self._lock:
            if self._unknown:
                raise UncertainBrowserState('Previous browser operation has an unknown result')
            # AIDEV-NOTE: Потерянный ответ не доказывает, что сайт не выполнил действие.
            self._unknown = True
            result = await operation(self._backend, self._session)
            self._unknown = False
            return result

    async def switch(self, target, verify):
        """Сменить владельца только после подтверждения сохранности всей сессии.

        Доверенный verify получает прежний браузер, новый браузер и идентификатор
        сессии. Проверка не должна выполнять действия сайта и должна подтвердить
        возможность продолжения без повторения команд; одних cookies недостаточно.
        Исходный браузер не останавливается.
        """
        if not target:
            raise ValueError('Target browser is required')
        async with self._lock:
            if self._unknown:
                raise UncertainBrowserState('Previous browser operation has an unknown result')
            if target == self._backend:
                return True
            self._unknown = True
            verified = await verify(self._backend, target, self._session)
            self._unknown = False
            if verified is not True:
                return False
            self._backend = target
            return True

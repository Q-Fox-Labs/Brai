# ABOUTME: Создаёт отдельный публичный egress для личности процесса Kitesurf.
# ABOUTME: Изоляцию процесса, защиту каталога сокета и запуск обеспечивает установщик.
"""Не подключённый к пользовательскому runtime адаптер публичного egress."""

from . import egress


async def start_server(socket_path, registry_loader, config_loader, authorize,
                       *, browser_uid, owner_uid, user_id, profile_id, dial=egress._dial):
    """Открыть сокет для одного браузерного UID с правами указанного профиля.

    Реестр и соответствие UID должны поступать из доверенной конфигурации.
    Установщик обязан выделить каждому профилю уникальный UID браузера и
    отдельное сетевое пространство, не соединённое с личным CDP Chrome.
    Каталог сокета должен исключать его подмену. Вызывающий обязан остановить
    все соединения до удаления сокета и отзыва соответствия UID профилю.
    """
    if (type(browser_uid) is not int or browser_uid <= 0 or type(owner_uid) is not int
            or owner_uid <= 0 or browser_uid == owner_uid
            or not isinstance(user_id, str) or not user_id
            or not isinstance(profile_id, str) or not profile_id):
        raise ValueError('Invalid browser identity')

    def browser_registry():
        registry = registry_loader()
        owner = egress._profile(registry, owner_uid)
        profiles = registry['profiles']
        if (str(browser_uid) in profiles or owner['userId'] != user_id
                or owner['profileId'] != profile_id):
            raise egress.Rejected(403)
        return {'version': 1, 'profiles': {str(browser_uid): owner}}

    async def browser_authorize(uid):
        if uid != browser_uid:
            return False
        try:
            browser_registry()
            allowed = await authorize(owner_uid)
            browser_registry()
            return allowed is True
        except egress.Rejected:
            return False

    return await egress.start_server(socket_path, browser_registry, config_loader,
                                     browser_authorize, dial=dial, public_only=True)

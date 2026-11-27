# ABOUTME: Задаёт подключение штатного генератора Hermes к защищённому шлюзу Brai.
# ABOUTME: Личный процесс получает только адрес шлюза и несекретный маркер.


def shared_provider_credentials():
    """Вернуть несекретные параметры штатного локального шлюза."""
    return 'profile-image-proxy-not-a-secret', 'http://127.0.0.1:18080/image'

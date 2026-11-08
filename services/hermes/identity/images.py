# ABOUTME: Подключает штатный image provider Hermes к общему подписочному шлюзу.
# ABOUTME: В личном процессе остаётся только несекретный адрес; credential читает trusted egress.
"""Сохраняет native генерацию и редактирование изображений без общего auth.json."""
import importlib


def install_shared_provider():
    """Связать закреплённый native provider с локальным relay до обнаружения инструментов."""
    from tools.image_generation_tool import _get_plugin_provider
    provider = _get_plugin_provider('openai-codex')
    if provider is None:
        raise RuntimeError('Native image provider unavailable')
    module = importlib.import_module(type(provider).__module__)
    if not callable(getattr(module, '_read_codex_credential', None)):
        raise RuntimeError('Native image provider contract changed')
    # AIDEV-NOTE: Замена действует только внутри личного процесса. Исходники общего
    # provider и его протокол не меняются; bearer никогда не возвращается worker.
    module._read_codex_credential = lambda: (
        'profile-image-proxy-not-a-secret', 'http://127.0.0.1:18080/image')

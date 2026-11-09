# ABOUTME: Передаёт запрос входа доверенному ingress без секретов в worker.
# ABOUTME: Получатель и личный Telegram-контекст определяются доверенной стороной.
"""Минимальный агентский порт входа поверх существующего peer RPC."""

from .ipc import RpcError

async def send_login(peer):
    """Запросить доставку; результат не содержит кода или адреса."""
    try:
        result = await peer.call('send_login', {})
    except (ConnectionError, TimeoutError, RpcError):
        return {'status': 'unknown'}
    if not isinstance(result, dict) or set(result) != {'status'} or result['status'] not in ('sent', 'denied', 'failed', 'unknown', 'unavailable'):
        return {'status': 'unknown'}
    return result

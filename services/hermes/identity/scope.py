# ABOUTME: Сохраняет доверенный допуск доставки в native async tasks и executor context.
# ABOUTME: Фоновая работа не наследует чужое право текущего разговора.
"""Nonce назначает ingress, а не модель или пользовательский текст."""
from contextvars import ContextVar

delivery_scope = ContextVar('brai_identity_delivery_scope', default=None)
UNSCOPED = object()
request_scope = ContextVar('brai_identity_request_scope', default=UNSCOPED)

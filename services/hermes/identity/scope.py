# ABOUTME: Сохраняет доверенный допуск доставки в native async tasks и executor context.
# ABOUTME: Фоновая работа не наследует чужое право текущего разговора.
"""Nonce назначает ingress, а не модель или пользовательский текст."""
from contextvars import ContextVar

# AIDEV-NOTE: Задачи native наследуют ID исходного durable input, включая final send.
input_delivery = ContextVar('brai_input_delivery', default=None)

delivery_scope = ContextVar('brai_identity_delivery_scope', default=None)
UNSCOPED = object()
request_scope = ContextVar('brai_identity_request_scope', default=UNSCOPED)

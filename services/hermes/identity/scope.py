# ABOUTME: Сохраняет доверенный допуск доставки в native async tasks и executor context.
# ABOUTME: Фоновая работа не наследует чужое право текущего разговора.
"""Nonce назначает ingress, а не модель или пользовательский текст."""
from contextvars import ContextVar

# AIDEV-NOTE: Задачи native наследуют ID исходного durable input, включая final send.
input_delivery = ContextVar('brai_input_delivery', default=None)
continuation_turn = ContextVar('brai_continuation_turn', default=False)
ephemeral_input = ContextVar('brai_ephemeral_input', default=None)
final_text_session = ContextVar('brai_final_text_session', default=None)
prepared_response = ContextVar('brai_prepared_response', default=None)
prepared_voice = ContextVar('brai_prepared_voice', default=None)

delivery_scope = ContextVar('brai_identity_delivery_scope', default=None)
UNSCOPED = object()
request_scope = ContextVar('brai_identity_request_scope', default=UNSCOPED)

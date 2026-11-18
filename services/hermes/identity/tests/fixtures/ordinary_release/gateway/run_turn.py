# Закреплённый метод native Hermes для проверки доставки финала.
class GatewayTurnMixin:
    @staticmethod
    def _run_agent_stream_confirmed_final_delivery(consumer, final_text: str, *, previewed: bool = False) -> bool:
        """True only when the actual final reply reached the user: a finalize call may carry only the
        last preview snapshot, so reconcile against the recorded payload — a demonstrable mismatch
        (False) overrides the flag; None keeps legacy trust."""
        if consumer is None:
            return False
        if getattr(consumer, "final_response_sent", False):
            matcher = getattr(consumer, "delivered_final_matches", None)
            if callable(matcher):
                with suppress(Exception):
                    if matcher(final_text) is False:
                        return False
            return True
        # Exact-text match against what the consumer DURABLY delivered (commentary, segments, and the
        # visible prefix only once a real send landed) — safe without the ``previewed`` flag. The codex
        # app-server bridge delivers the final agentMessage through the commentary path and never sets
        # response_previewed (#74248 / #80519); gating on the flag re-sent every such reply. Mismatching
        # commentary still returns False, so a distinct final answer is never suppressed (#65919). Draft
        # frames are ephemeral and must not count: after draft streaming + a failed finalize send this
        # predicate must stay False so the fallback final send still fires (#51828 / #33793).
        has_delivered_text = getattr(consumer, "has_durably_delivered_text", None)
        if callable(has_delivered_text):
            try:
                return bool(has_delivered_text(final_text))
            except Exception:
                return False
        return False

    async def _run_agent_deliver_first_response(
        self, turn_ctx: TurnContext, adapter: Any, response: Any, result: Any, stream_task: Any,
    ) -> None:
        """Deliver the first response before a queued follow-up runs, unless streaming already did."""
        if turn_ctx.mute_notification_reply:
            return
        session_key = turn_ctx.session_key
        _sc = turn_ctx.stream_consumer_holder[0]
        if _sc and stream_task:
            try:
                await self._await_stream_task(stream_task, timeout=125.0 if turn_ctx.source.platform == Platform.TELEGRAM else 5.0)
            except Exception as e:
                logger.debug("Stream consumer wait before queued message failed: %s", e)
        # Delivery uses the finalized task result (empty/failure normalization), not raw ``result``.
        _delivery_result = response if isinstance(response, dict) else (result or {})
        first_response = _delivery_result.get("final_response", "")
        _already_streamed = self._run_agent_stream_confirmed_final_delivery(
            _sc, first_response, previewed=bool(_delivery_result.get("response_previewed")),
        )
        # Same silence predicate as the normal path, else this branch leaks the literal marker.
        if self._is_intentional_silence(_delivery_result, first_response):
            if silence_allowed(turn_ctx.persist_user_display_kind, turn_ctx.reply_expected):
                logger.info(
                    "Queued follow-up for session %s: suppressing intentional silence marker before continuing.",
                    session_key or "?",
                )
                first_response = ""
            else:
                logger.warning(
                    "Queued follow-up for session %s: replacing a human-turn silence marker.",
                    session_key or "?",
                )
                first_response = _unexpected_silence_reply()
                _already_streamed = False
        # Failed turns deliver their text but never their attachments (completed-turn parity).
        _deliver_media = not _delivery_result.get("failed")
        if first_response:
            logger.info(
                "Queued follow-up for session %s: final text delivery confirmed; delivering explicit media before continuing."
                if _already_streamed else
                "Queued follow-up for session %s: final stream delivery not confirmed; sending first response before continuing.",
                session_key or "?",
            )
            try:
                _text_delivered = await self._deliver_queued_first_response(
                    first_response, source=turn_ctx.source, adapter=adapter,
                    metadata=turn_ctx._status_thread_metadata, event_message_id=turn_ctx.event_message_id,
                    text_already_delivered=_already_streamed,
                    deliver_media=_deliver_media, stream_consumer=_sc,
                    # The text send records a delivery-ledger obligation under this key, keyed on
                    # the raw inbound id (the anchor above is only the reply target).
                    session_key=session_key, inbound_message_id=turn_ctx.inbound_message_id,
                )
            except Exception as e:
                logger.warning("Failed to send first response before queued message: %s", e)
            else:
                # One source of truth for "this turn's final already reached the chat": the normal
                # completion path (`_hmwa_deliver_turn_response`) consults ``already_sent`` on the
                # result the queued lane hands back. Every early `return result` after this point
                # (follow-up text refused, stale goal continuation) otherwise re-sends the text the
                # fallback just delivered — the #81052 duplicate. A REFUSED send reports False, and
                # the completion send stays the fallback so the user is not left with nothing.
                if _text_delivered and isinstance(result, dict):
                    result["already_sent"] = True
                    # The queued lane already uploaded this response's MEDIA: attachments; without
                    # this the completion path's already_sent rescan uploads every file twice.
                    result["media_already_delivered"] = _deliver_media
        # Release deferred bg-review notifications: pop (no double-fire in base.py's finally) and call.
        _bg_cb = self._pop_post_delivery_callback(adapter, session_key, turn_ctx.run_generation)
        if callable(_bg_cb):
            with suppress(Exception):
                _bg_result = _bg_cb()
                if inspect.isawaitable(_bg_result):
                    await _bg_result

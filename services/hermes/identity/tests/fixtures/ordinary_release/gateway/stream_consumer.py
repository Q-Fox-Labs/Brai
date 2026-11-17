# Закреплённый метод native Hermes для проверки доставки финала.
class GatewayStreamConsumer:
    def has_durably_delivered_text(self, text: str) -> bool:
        """``has_delivered_text`` restricted to deliveries that outlive the turn: commentary and
        finalized segments always count; the visible prefix only once ``_already_sent`` (a draft frame
        sets ``_last_sent_text`` but is ephemeral — a failed finalize send after it must still fall
        back to the gateway's real final send, same gate as ``delivered_final_matches``)."""
        target = self._clean_for_display(text or "").strip()
        seen = [*self._delivered_commentary_texts, *self._delivered_segment_texts]
        if self._already_sent:
            seen.append(self._visible_prefix())
        return bool(target) and any(sent.strip() == target for sent in seen)

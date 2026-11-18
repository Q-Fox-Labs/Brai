class CodexAppServerSession:
    def _absorb_notification(
        self, result: TurnResult, projector: CodexEventProjector, note: dict
    ) -> tuple[ProjectionResult, bool]:
        """Fan one in-scope notification out to display, accounting, file-change tracking and the projector.

        Returns (projection, aborted); aborted = agent text carried a terminal ``<turn_aborted>`` marker.
        """
        if self._on_event is not None:
            try:
                self._on_event(note)
            except Exception:  # pragma: no cover - display callback
                logger.debug("on_event callback raised", exc_info=True)
        _apply_accounting_notification(result, note)
        self._track_pending_file_change(note)
        projection = projector.project(note)
        if projection.messages:
            result.projected_messages.extend(projection.messages)
        if projection.is_tool_iteration:
            result.tool_iterations += 1
        aborted = False
        if projection.final_text is not None:
            # Multiple agentMessage items per turn: the last one is canonical.
            result.final_text = projection.final_text
            aborted = _has_turn_aborted_marker(projection.final_text)
            if aborted:
                result.interrupted = True
                result.error = result.error or "codex reported turn_aborted"
        return projection, aborted

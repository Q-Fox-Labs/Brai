def make_codex_app_server_event_bridge(agent) -> Callable[[dict], None]:
    """Build the ``on_event`` callback for ``CodexAppServerSession(on_event=...)``.

    Tool items fire ``tool_progress_callback`` plus the stable-ID ``tool_start_callback`` /
    ``tool_complete_callback`` card hooks; deltas go to ``_fire_stream_delta`` / ``_fire_reasoning_delta``;
    a completed agentMessage goes to ``_emit_interim_assistant_message`` (the gateway's ``already_streamed``
    check dedupes against streamed deltas). Current-turn progress refreshes the activity clock even
    without display hooks. Every callback is guarded so a buggy display hook cannot tear down the turn loop."""
    # item_id -> (tool_name, args, started_monotonic); duration even when codex omits durationMs.
    started: dict[str, tuple[str, dict, float]] = {}

    def agent_cb(attr: str, fail_msg: str, *fail_args: Any, args: tuple = (), kwargs: dict | None = None) -> None:
        _call_guarded(getattr(agent, attr, None), fail_msg, *fail_args, args=args, kwargs=kwargs)

    def _fire_tool_started(item: dict) -> None:
        item_id, name = item.get("id") or "", _codex_item_to_tool_name(item)
        args = _codex_item_to_args(item)
        if item_id:
            started[item_id] = (name, args, time.monotonic())
        agent_cb("tool_progress_callback", "tool_progress_callback raised on tool.started for %s", name,
                 args=("tool.started", name, _codex_item_to_preview(item), args))
        # Stable-ID tool card (TUI/desktop) fires alongside the progress bubble.
        agent_cb("tool_start_callback", "tool_start_callback raised for %s", name,
                 args=(_stable_call_id(item, name), name, args))

    def _fire_tool_completed(item: dict) -> None:
        name = _codex_item_to_tool_name(item)
        prior = started.pop(item_id, None) if (item_id := item.get("id") or "") else None
        # Prefer codex's durationMs; else our started timestamp; else None (some codex
        # versions only emit completed for fast items).
        codex_ms = item.get("durationMs")
        has_codex_ms = isinstance(codex_ms, (int, float)) and codex_ms >= 0
        duration: Any = codex_ms / 1000.0 if has_codex_ms else (time.monotonic() - prior[2] if prior else None)
        result, is_error = _codex_item_completion_payload(item)
        agent_cb("tool_progress_callback", "tool_progress_callback raised on tool.completed for %s", name,
                 args=("tool.completed", name, None, None),
                 kwargs={"duration": duration, "is_error": is_error, "result": result})
        args = prior[1] if prior is not None else _codex_item_to_args(item)
        agent_cb("tool_complete_callback", "tool_complete_callback raised for %s", name,
                 args=(_stable_call_id(item, name), name, args, result))

    def _fire_delta(params: dict, attr: str) -> None:
        text = _delta_text(params)
        # Single-writer guard (#65991): a superseded stream must not pollute the turn's accumulated text
        # (which also feeds the interim-visible-text de-dup comparison), even when a caller reaches this
        # directly (the tool-suppressed content path) rather than through _fire_stream_delta.
        if text:
            agent_cb(attr, f"{attr} raised", args=(text,))

    def _fire_agent_message_completed(item: dict) -> None:
        text = item.get("text") or ""
        # display.show_commentary=false keeps mid-turn narration off the interim path too (codex_responses contract).
        if isinstance(text, str) and text.strip() and getattr(agent, "show_commentary", True):
            agent_cb("_emit_interim_assistant_message", "_emit_interim_assistant_message raised",
                     args=({"role": "assistant", "content": text},))
        # Each agentMessage item is its own delivered message: the completed item was just compared
        # against ITS deltas, so drop them before the next item's deltas arrive. Otherwise the buffer
        # holds "commentary + final", the final agentMessage no longer prefix-matches, and it is
        # re-delivered with already_streamed=False as a second copy (#74248 boundary 2).
        agent._current_streamed_assistant_text = ""

    def _on_item(params: dict, completed: bool) -> None:
        item = params.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type") or ""
        if item_type in _CODEX_TOOL_ITEM_TYPES:
            (_fire_tool_completed if completed else _fire_tool_started)(item)
        elif completed and item_type == "agentMessage":
            _fire_agent_message_completed(item)
    handlers: dict[str, Callable[[dict], None]] = {
        method: functools.partial(_fire_delta, attr=attr) for method, attr in _CODEX_TEXT_DELTA_METHODS
    }
    handlers["item/started"] = lambda p: _on_item(p, completed=False)
    handlers["item/completed"] = lambda p: _on_item(p, completed=True)

    def on_event(note: dict) -> None:
        if not isinstance(note, dict):
            return
        method = note.get("method") or ""
        params = note.get("params")
        params = params if isinstance(params, dict) else {}
        # The session has already filtered foreign thread/turn notifications. Count
        # progress even without UI callbacks (or when commentary is hidden), but
        # never let empty deltas or transport keepalives mask a stalled turn.
        item = params.get("item")
        is_delta = method in _CODEX_PROGRESS_DELTA_METHODS and bool(_delta_text(params))
        is_item = (
            method in {"item/started", "item/completed"} and isinstance(item, dict)
            and item.get("type") in _CODEX_PROGRESS_ITEM_TYPES
        )
        if is_delta or is_item:
            agent_cb("_touch_activity", "_touch_activity raised", args=(f"codex app-server: {method}",))
        handler = handlers.get(method)
        if handler is not None:
            handler(params)
    return on_event


def _consume_user_interrupt(agent, active: bool = True) -> tuple[bool, Any]:
    """(user_interrupted, interrupt_message); clears the agent-level interrupt so a hard
    stop cannot poison the next turn (mirrors the conversation-loop finalizer)."""
    interrupted = bool(active and getattr(agent, "_interrupt_requested", False))
    message = getattr(agent, "_interrupt_message", None) if interrupted else None
    if interrupted:
        agent.clear_interrupt()
    return interrupted, message


def run_codex_app_server_turn(agent, *, user_message: str, original_user_message: Any, messages: list[dict[str, Any]],
                              effective_task_id: str, should_review_memory: bool = False) -> dict[str, Any]:
    """Hand the turn to a ``codex app-server`` subprocess and project its events into ``messages``.
    Returns the chat_completions result shape. The user message is ALREADY in ``messages`` — never append it again."""
    # Defense in depth for compression.checkpoint_required: agent init refuses the combination, but
    # api_mode is mutable. Explicit-True check matches compress_context().
    if getattr(agent, "compression_checkpoint_required", False) is True:
        from agent.conversation_compression import _checkpoint_blocked
        raise _checkpoint_blocked("codex_app_server owns the authoritative thread and compacts it "
                                  "without a truthful pre-compaction transcript boundary")
    _ensure_codex_session(agent, messages)
    try:
        _start_codex_thread(agent)
        wire_model = _codex_wire_model(agent, getattr(agent, "_codex_session_model_provider", None))
        turn = agent._codex_session.run_turn(
            user_input=user_message,
            model=wire_model, reasoning_effort=_codex_turn_effort(agent, wire_model),
            service_tier=_codex_turn_service_tier(agent))
    except Exception as exc:
        logger.exception("codex app-server turn failed")
        _close_codex_session(agent)
        return _turn_result(
            _consume_user_interrupt(agent), messages, api_calls=0, completed=False, error=str(exc),
            final_response=f"Codex app-server turn failed: {exc}. Fall back to default runtime with `/codex-runtime auto`.",
        )
    interrupt = _consume_user_interrupt(agent, turn.interrupted)
    # Wedged client (turn deadline blown, OAuth refresh died, subprocess exited): retire it. Post-tool
    # silence alone no longer retires — it only logs a warning (#112928).
    if getattr(turn, "should_retire", False):
        logger.warning("codex app-server session retired (turn error: %s)", turn.error)
        _close_codex_session(agent)
    # The binding is published only once the transcript it belongs to is durable, and never for a
    # retired thread (the next agent would only resume into the same wedge).
    if _persist_projected_messages(agent, turn, messages) and not getattr(turn, "should_retire", False):
        _store_codex_thread_id(agent, turn.thread_id)
    usage_result = _finish_codex_turn(
        agent, turn, messages, original_user_message=original_user_message, should_review_memory=should_review_memory,
    )
    return _turn_result(
        interrupt, messages, api_calls=1, completed=not turn.interrupted and turn.error is None, error=turn.error,
        # We flushed the projected rows ourselves (agent_persisted); the gateway must skip its own DB write.
        final_response=turn.final_text, agent_persisted=True, codex_thread_id=turn.thread_id, codex_turn_id=turn.turn_id,
        **usage_result,
    )


def _turn_result(interrupt: tuple[bool, Any], messages: list[dict[str, Any]], *, api_calls: int, completed: bool,
                 error: Any, final_response: Any, **extra: Any) -> dict[str, Any]:
    """Result shape shared with the chat_completions path (``partial`` == ``not completed``)."""
    user_interrupted, interrupt_message = interrupt
    return {
        "final_response": final_response, "messages": messages, "api_calls": api_calls,
        "completed": completed, "partial": not completed, "interrupted": user_interrupted,
        **({"interrupt_message": interrupt_message} if interrupt_message else {}),
        "error": error, **extra,
    }

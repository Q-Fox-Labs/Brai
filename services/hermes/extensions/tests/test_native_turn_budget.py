# ABOUTME: Проверяет общий бюджет на точных исходниках закреплённого native Hermes.
# ABOUTME: Патчит только временную копию; сеть, рабочие службы и HOME не использует.
"""Поведенческая приёмка: BRAI_NATIVE_SOURCE указывает read-only pinned engine."""

import ast
import asyncio
import contextlib
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor
import hashlib
import inspect
import socket
import importlib.util
import logging
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from typing import Any
from collections.abc import Iterator

EXTENSIONS = Path(__file__).resolve().parents[1]
SOURCE = os.environ.get("BRAI_NATIVE_SOURCE", "/opt/brai-identity/dev/software/release-fb5e7fb91bee427182e4da0f56466b3a/engine")
SOURCE = SOURCE if Path(SOURCE).is_dir() else None
HASHES = {
    "agent/auxiliary_client.py": "a91d1922271172fb884d3f3c27f927c27f49c6e924d9f0e1d5049bcd866cbc16",
    "agent/turn_api_call.py": "2897575995d8dcbe94bba666ef66043a64c52a6c99e72c45e7da64a5fbdf576b",
    "agent/turn_recovery.py": "693236ce4d7d1a5785f00e6614aad3b3afbbc3cc7f1ec8d9794c31968e8ac067",
    "agent/turn_finalizer.py": "856c43abf03f7e0b24b3682f27ce1da373d896a16e2c91e2a55be84ec90de36c",
    "agent/chat_completion_nonstream.py": "34d4afad0a0c7228a0518eed4a2521ba1a340f509c83784c74abceb56f1becb7",
    "agent/conversation_compression.py": "c2a8f9c20db70d017b9b9ce8fce52b6a2fe48d3f6af54f37481c8b7ca8f15277",
    "agent/relay_llm.py": "97aecd95e90df447399102a49f5e59df20988ee41250347b988dbf4bd31caa34",
    "agent/conversation_loop.py": "a8e0d8236b4563cf62fdfad50b1833fc3e0dd0904776aa50467c9d2cef8eb1bd",
    "agent/codex_runtime.py": "22e21d75d95a2b308b551dc01a8532146ab4f423bd4360a7011e7563e2ccd930",
    "agent/context_compressor.py": "7bdf3e07ebda122342c33964a00cf38aa62c07ba0a9b6857ffed8d62159cd18b",
}


def native_nodes(root, path, names, **namespace):
    """Выполнить реальные AST узлы с явными подменами внешних зависимостей."""
    tree = ast.parse((root / path).read_text())
    nodes = [node for node in ast.walk(tree)
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
             and node.name in names]
    if len(nodes) != len(names):
        raise AssertionError((path, names, [node.name for node in nodes]))
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])),
                 path, "exec"), namespace)
    return types.SimpleNamespace(**namespace)



class PortableTurnBudgetTests(unittest.TestCase):
    """Проверить shipped новый модуль без установленного Hermes или сети."""

    def setUp(self):
        section = (EXTENSIONS / "patches/turn-request-budget.patch").read_text().split(
            "diff --git a/agent/brai_turn_budget.py b/agent/brai_turn_budget.py", 1)[1].split("diff --git ", 1)[0]
        source = "\n".join(line[1:] for line in section.splitlines()
                           if line.startswith("+") and not line.startswith("+++")) + "\n"
        self.budget = types.ModuleType("portable_brai_budget")
        exec(compile(source, "agent/brai_turn_budget.py", "exec"), self.budget.__dict__)
        self.state = self.budget.TurnRequestBudget()
        self.token = self.budget._current.set(self.state)
        self.policy_env = patch.dict(os.environ, {"HERMESCUSTOM_ROOT": str(EXTENSIONS)})
        self.policy_env.start()

    def tearDown(self):
        self.budget._current.reset(self.token)
        self.policy_env.stop()

    def test_shared_extra_limit_without_native_dependency(self):
        physical = Mock(side_effect=ConnectionError("synthetic"))
        for request_id in ("1", "1", "2", "3"):
            callback = self.budget.physical_callback(physical, {"api_request_id": request_id})
            with self.assertRaises((ConnectionError, self.budget.TurnRequestBudgetExhausted)):
                callback({})
        self.assertEqual(physical.call_count, 3)
        self.assertEqual(self.state.spent, 2)

    def test_nested_worker_does_not_reset_budget(self):
        @self.budget.turn_budget
        def nested():
            return self.budget._current.get()
        with ThreadPoolExecutor(max_workers=1) as pool:
            self.assertIs(pool.submit(contextvars.copy_context().run, nested).result(), self.state)

    def test_original_deadline_is_retained(self):
        with patch.object(self.budget.time, "monotonic", return_value=0):
            first = self.state.start({"api_request_id": "1"})
            deadline = self.budget.logical_deadline(10, request_id="1")
            first.finish(failed=True)
        with patch.object(self.budget.time, "monotonic", return_value=8):
            self.state.start({"api_request_id": "2"})
            self.assertEqual(self.budget.logical_deadline(20, request_id="2"), deadline)

    def test_partial_commentary_blocks_another_physical_call(self):
        attempt = self.state.start({"api_request_id": "1"})
        attempt.observe({"type": "response.output_item.done", "item": {
            "type": "message", "phase": "commentary",
            "content": [{"type": "output_text", "text": "visible"}]}})
        attempt.finish(failed=True)
        with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
            self.state.start({"api_request_id": "2"})



    def test_logs_correlate_retries_without_request_or_error_payload(self):
        secret = "SENSITIVE_FIXTURE_PAYLOAD"
        callback = Mock(side_effect=ConnectionError(secret))
        with self.assertLogs(self.budget.logger, level="INFO") as captured:
            for _ in range(3):
                with self.assertRaises((ConnectionError, self.budget.TurnRequestBudgetExhausted)):
                    self.budget.physical_callback(callback, {"api_request_id": "api:retry"})({"content": secret})
        self.assertTrue(all("turn_id=" + self.state.turn_id in line for line in captured.output))
        self.assertTrue(all("request_id=api:retry" in line for line in captured.output))
        self.assertIn("reason=retry_limit", captured.output[-1])
        self.assertIn("stage=exhausted", captured.output[-1])
        self.assertNotIn(secret, "\n".join(captured.output))
        self.assertEqual(callback.call_count, 3)
        self.assertEqual(callback.call_args.args, ({"content": secret},))

    def test_fresh_standalone_turns_have_distinct_log_ids(self):
        states = []
        @self.budget.turn_budget
        def standalone():
            state = self.budget._current.get()
            states.append(state)
            self.budget.physical_callback(lambda request: None, {"api_request_id": "api:fresh"})({})
        token = self.budget._current.set(None)
        try:
            with self.assertLogs(self.budget.logger, level="INFO") as captured:
                standalone()
                standalone()
        finally:
            self.budget._current.reset(token)
        self.assertNotEqual(states[0].turn_id, states[1].turn_id)
        self.assertEqual(len(states[0].turn_id), 32)
        for state in states:
            self.assertTrue(any("turn_id=" + state.turn_id in line for line in captured.output))



    def test_policy_allows_existing_1800_wire_and_1200_overrides(self):
        self.assertEqual(self.budget.transport_timeout_policy(), (1800.0, 1860.0))
        self.budget.validate_client_timeouts(
            1800.0, {"first_event": 1200.0, "idle": 1200.0, "wall": float("inf")},
            operation="primary")
        # Отключённые watchdogs оставляют SDK read1800; wall deadline не урезается.
        self.budget.validate_client_timeouts(1800.0, {"disabled": float("inf")}, operation="primary")

    def test_policy_rejects_unsupported_wire_override(self):
        with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
            self.budget.validate_client_timeouts(
                1801.0, {"first_event": 3600.0, "idle": float("inf")}, operation="primary")

    def test_policy_requires_absolute_root(self):
        with patch.dict(os.environ, {"HERMESCUSTOM_ROOT": "relative"}):
            with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                self.budget.transport_timeout_policy()



    def test_native_policy_schema_matches_network_integer_contract(self):
        with tempfile.TemporaryDirectory(prefix="brai-policy-fixture-") as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config/network-timeouts.json").write_text(
                '{"version":1,"max_client_silence_seconds":1800.5,"transport_idle_grace_seconds":60}')
            with patch.dict(os.environ, {"HERMESCUSTOM_ROOT": str(root)}):
                with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                    self.budget.transport_timeout_policy()


@unittest.skipUnless(SOURCE, "BRAI_NATIVE_SOURCE points to the exact read-only pinned engine")
class NativeTurnBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Проверить bytes источника и применить shipped patch в изолированной копии."""
        cls.temp = tempfile.TemporaryDirectory(prefix="brai-native-budget-")
        cls.engine = Path(cls.temp.name)
        for path, expected in HASHES.items():
            source = Path(SOURCE) / path
            if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
                raise AssertionError("Pinned source changed: " + path)
            target = cls.engine / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        checked = subprocess.run(["git", "apply", "--check", str(EXTENSIONS / "patches/turn-request-budget.patch")],
                                 cwd=cls.engine, capture_output=True, text=True)
        if checked.returncode:
            raise AssertionError(checked.stderr)
        subprocess.run(["git", "apply", str(EXTENSIONS / "patches/turn-request-budget.patch")],
                       cwd=cls.engine, check=True, capture_output=True, text=True)
        for source in (cls.engine / "agent").glob("*.py"):
            compile(source.read_text(), str(source), "exec")
        spec = importlib.util.spec_from_file_location("brai_budget_fixture", cls.engine / "agent/brai_turn_budget.py")
        cls.budget = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.budget)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.state = self.budget.TurnRequestBudget()
        self.token = self.budget._current.set(self.state)
        self.policy_env = patch.dict(os.environ, {"HERMESCUSTOM_ROOT": str(EXTENSIONS)})
        self.policy_env.start()

    def tearDown(self):
        self.budget._current.reset(self.token)
        self.policy_env.stop()

    def metadata(self, request="api:1", role="primary"):
        return {"api_request_id": request, "call_role": role, "api_mode": "codex_responses"}

    def relay(self, **extra):
        namespace = dict(
            physical_callback=self.budget.physical_callback,
            physical_async_callback=self.budget.physical_async_callback,
            _ManagedAttempt=types.SimpleNamespace(resolve=lambda *a, **kw: None),
            _jsonable=lambda value: value, _namespace=lambda value: value,
            _complete_logical=lambda *a, **kw: None,
            logger=logging.getLogger("native-fixture"),
            contextlib=contextlib, asyncio=asyncio, Iterator=Iterator, Any=Any,
        )
        namespace.update(extra)
        return native_nodes(self.engine, "agent/relay_llm.py",
                            {"execute", "execute_async", "ManagedLlmStream"}, **namespace)

    def failed_call(self, request="api:1", role="primary"):
        relay = self.relay()
        callback = Mock(side_effect=ConnectionError("synthetic failure"))
        with self.assertRaises((ConnectionError, self.budget.TurnRequestBudgetExhausted)):
            relay.execute({}, callback, name="fixture", model_name="fixture",
                          metadata={**self.metadata(request, role), "api_mode": "chat_completions"})
        return callback

    def test_retry_layers_and_changed_api_ids_share_two_extras(self):
        for request, role in (("api:1", "primary"), ("api:1", "primary"),
                              ("api:2", "fallback"), ("api:3", "primary")):
            self.failed_call(request, role)
        self.assertEqual(self.state.physical, 3)
        self.assertEqual(self.state.spent, 2)

    def test_successful_tool_iterations_do_not_reset_spent_credit(self):
        self.failed_call()
        relay = self.relay()
        for request in ("api:1", "api:2"):
            relay.execute({}, lambda req: object(), name="fixture", model_name="fixture",
                          metadata={**self.metadata(request), "api_mode": "chat_completions"})
        self.failed_call("api:3")
        self.failed_call("api:3")
        blocked = self.failed_call("api:4")
        blocked.assert_not_called()
        self.assertEqual(self.state.spent, 2)

    def test_compression_and_primary_use_same_extra_credit(self):
        self.failed_call()
        self.failed_call("compression:1", "auxiliary:compression")
        self.failed_call("compression:2", "auxiliary:compression")
        self.assertEqual(self.state.spent, 1)
        self.failed_call("api:2")
        blocked = self.failed_call("compression:3", "auxiliary:compression")
        blocked.assert_not_called()
        self.assertEqual(self.state.physical, 4)

    def test_async_native_execute_uses_same_physical_guard(self):
        async def fail(request):
            raise ConnectionError("synthetic failure")
        relay = self.relay()
        for _ in range(4):
            with self.assertRaises((ConnectionError, self.budget.TurnRequestBudgetExhausted)):
                asyncio.run(relay.execute_async({}, fail, name="fixture", model_name="fixture",
                                                metadata=self.metadata()))
        self.assertEqual(self.state.physical, 3)

    def test_retry_origin_is_not_reset_on_new_api_id(self):
        first = self.state.start(self.metadata())
        first.finish(failed=True)
        with patch.object(self.budget.time, "monotonic", return_value=first.origin + 100):
            second = self.state.start(self.metadata("api:2", "fallback"))
        self.assertEqual(first.origin, second.origin)

    def test_standalone_next_user_turn_has_fresh_budget(self):
        seen = []
        @self.budget.turn_budget
        def turn():
            seen.append(self.budget._current.get())
            for _ in range(3):
                self.failed_call()
        standalone = self.budget._current.set(None)
        try:
            turn()
            turn()
        finally:
            self.budget._current.reset(standalone)
        self.assertIsNot(seen[0], seen[1])
        self.assertEqual([state.physical for state in seen], [3, 3])
        self.assertIs(self.budget._current.get(), self.state)

    def test_native_public_turn_entry_installs_scope(self):
        module = native_nodes(self.engine, "agent/conversation_loop.py", {"run_conversation"},
                              turn_budget=self.budget.turn_budget)
        # Function object is the real decorated entry; its wrapped function keeps the native signature.
        self.assertTrue(hasattr(module.run_conversation, "__wrapped__"))
        self.assertEqual(module.run_conversation.__name__, "run_conversation")

    def test_unmanaged_native_stream_calls_observer_once_per_event(self):
        relay = self.relay()
        events = [{"type": "response.output_text.delta", "delta": "synthetic"},
                  {"type": "response.completed"}]
        observed = []
        stream = relay.ManagedLlmStream({}, lambda req: iter(events), session_id="", name="fixture",
                                        model_name="fixture", finalizer=lambda: None,
                                        on_chunk=observed.append, metadata=self.metadata())
        self.assertEqual(list(stream), events)
        self.assertEqual(observed, events)
        self.assertEqual(self.state.lanes["primary"].events, 2)
        self.assertFalse(self.state.lanes["primary"].failed)

    def test_delivered_text_then_drop_cannot_replay(self):
        relay = self.relay()
        observed = []
        def raw():
            yield {"type": "response.output_text.delta", "delta": "already delivered"}
            raise ConnectionError("dropped")
        factory = Mock(side_effect=lambda request: raw())
        stream = relay.ManagedLlmStream({}, factory, session_id="", name="fixture", model_name="fixture",
                                        finalizer=lambda: None, on_chunk=observed.append,
                                        metadata=self.metadata())
        with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
            list(stream)
        stream.close()
        with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
            relay.ManagedLlmStream({}, factory, session_id="", name="fixture", model_name="fixture",
                                    finalizer=lambda: None, metadata=self.metadata("api:2"))
        factory.assert_called_once()
        self.assertEqual(len(observed), 1)

    def assembler(self):
        return native_nodes(
            self.engine, "agent/codex_runtime.py",
            {"_CodexResponseAssembler", "_consume_codex_event_stream", "_event_field",
             "_message_phase", "_output_text_of"},
            SimpleNamespace=types.SimpleNamespace, suppress=contextlib.suppress,
            _call_guarded=lambda fn, label, args=(): fn(*args) if fn else None,
            logger=logging.getLogger("native-fixture"),
        )

    def test_native_assembler_rejects_missing_terminal_even_after_text(self):
        assembler = self.assembler()
        with self.assertRaisesRegex(RuntimeError, "terminal"):
            assembler._consume_codex_event_stream(
                [{"type": "response.output_text.delta", "delta": "partial"}], model="fixture")

    def test_partial_tool_call_is_never_returned_to_dispatcher(self):
        assembler = self.assembler()
        call = {"type": "function_call", "id": "call", "name": "terminal", "arguments": "{}"}
        for ending in ([], [{"type": "response.incomplete"}], [{"type": "response.failed"}]):
            with self.subTest(ending=ending), self.assertRaises(RuntimeError):
                assembler._consume_codex_event_stream(
                    [{"type": "response.output_item.added", "item": call},
                     {"type": "response.output_item.done", "item": call}, *ending], model="fixture")
        with self.assertRaises(RuntimeError):
            assembler._consume_codex_event_stream(
                [{"type": "response.output_item.done", "item": call},
                 {"type": "response.incomplete"}], model="fixture")
        response = assembler._consume_codex_event_stream(
            [{"type": "response.output_item.added", "item": call},
             {"type": "response.completed"}], model="fixture")
        self.assertEqual(response.output[0].name, "terminal")

    @contextlib.contextmanager
    def termination_helpers(self):
        """Подключить настоящие native partial/spinner helpers с нейтральными imports."""
        recovery = native_nodes(self.engine, "agent/turn_recovery.py",
                                {"settle_delivered_partial", "_with_delivered_partial"})
        api = native_nodes(self.engine, "agent/turn_api_call.py", {"stop_thinking_spinner"})
        def module(name, **values):
            value = types.ModuleType(name)
            value.__dict__.update(values)
            return value
        modules = {
            "agent": module("agent"),
            "agent.turn_api_call": module("agent.turn_api_call", stop_thinking_spinner=api.stop_thinking_spinner),
            "agent.turn_recovery": module("agent.turn_recovery", **vars(recovery)),
            "agent.turn_truncation": module("agent.turn_truncation", collapse_continuation_trail=lambda *a, **kw: ""),
            "agent.agent_runtime_helpers": module("agent.agent_runtime_helpers", strip_think_blocks=lambda agent, text: text),
        }
        with patch.dict("sys.modules", modules):
            yield

    def test_native_retry_loop_stops_and_finalizes_partial_durably(self):
        generic = Mock(side_effect=AssertionError("generic recovery must not run"))
        def phase(function, agent, state, **kwargs):
            if function is generic:
                function()
            if function == "perform":
                raise self.budget.TurnRequestBudgetExhausted("stopped")
            return types.SimpleNamespace(action="continue")
        native = native_nodes(
            self.engine, "agent/conversation_loop.py", {"_run_api_retry_loop"},
            _run_phase=phase, nous_rate_limit_guard="guard", build_api_request="build",
            perform_api_call="perform", check_api_response="check",
            handle_api_error=generic, TurnRequestBudgetExhausted=self.budget.TurnRequestBudgetExhausted,
        )
        messages = [{"role": "user", "content": "synthetic"}]
        persisted = []
        def persist(rows, history):
            persisted.extend(dict(row) for row in rows)
            agent.inflight = False
        agent = types.SimpleNamespace(
            thinking_callback=Mock(), _current_streamed_assistant_text="already visible",
            max_iterations=10, _save_trajectory=Mock(), _cleanup_task_resources=Mock(),
            _persist_session=persist, inflight=True, _stream_callback=object(),
            context_compressor=types.SimpleNamespace(last_prompt_tokens=0),
            model="fixture", provider="fixture", base_url="", session_id="session",
            _tool_guardrail_halt_decision=None, _drain_pending_steer=Mock(return_value="steer"),
            clear_interrupt=Mock(), _skill_nudge_interval=0, _sync_external_memory_for_turn=Mock(),
            skip_background_review=True,
        )
        state = types.SimpleNamespace(
            retry_count=0, max_retries=3, messages=messages, api_call_count=1,
            thinking_spinner=Mock(), current_turn_user_idx=0,
        )
        with self.termination_helpers():
            self.assertIsNone(native._run_api_retry_loop(agent, state))
        self.assertEqual(state.final_response, "already visible\n\nstopped")
        self.assertTrue(state.failed)
        self.assertEqual(state.thinking_spinner, None)
        generic.assert_not_called()

        # Выполняется весь реальный finalize_turn, включая persist, steer и callback cleanup.
        def module(name, **values):
            value = types.ModuleType(name)
            value.__dict__.update(values)
            return value
        modules = {
            "agent": module("agent"), "hermes_cli": module("hermes_cli"),
            "hermes_cli.observability": module("hermes_cli.observability"),
            "hermes_cli.observability.shared_metrics_harness": module(
                "hermes_cli.observability.shared_metrics_harness", finish_turn=Mock()),
            "agent.conversation_loop": module("agent.conversation_loop", logger=logging.getLogger("fixture"),
                                              _notify_context_engine_turn_complete=Mock()),
            "agent.turn_context": module("agent.turn_context", start_deferred_title_upgrade=Mock()),
            "agent.voice_turn_route": module("agent.voice_turn_route", end_voice_turn_route=Mock()),
        }
        finalizer = native_nodes(
            self.engine, "agent/turn_finalizer.py",
            {"finalize_turn", "_close_transcript_tail", "_recover_final_from_stream", "_guarded_cleanup"},
            suppress=contextlib.suppress, append_message=lambda rows, row: rows.append(row),
            flatten_message_text=lambda text: text or "",
            _resolve_budget_fallback=lambda agent, **kw: (
                kw["final_response"], kw["_turn_exit_reason"], False, kw["interrupted"]),
            exit_reason_failure=lambda reason: None, _rollback_interrupted_preflight_display=Mock(),
            _summarize_user_message_for_log=lambda text: text, _drop_transcript_scaffolding=Mock(),
            apply_llm_output_transform=lambda agent, text, **kw: (text, False, None),
            _log_turn_exit=Mock(), _append_file_mutation_footer=lambda agent, text, logger: text,
            _explain_abnormal_exit=lambda agent, text, *a: text,
            _apply_output_hooks=lambda agent, text, *a, **kw: (text, False, None),
            _sanitize_surrogates=lambda text: text, _last_turn_reasoning=lambda rows: None,
            result_model_fields=lambda agent: {}, _SESSION_TOKEN_KEYS=(), _SESSION_COST_KEYS=(),
            _invoke_hook_safely=Mock(),
        )
        with patch.dict("sys.modules", modules):
            result = finalizer.finalize_turn(
                agent, final_response=state.final_response, api_call_count=1, interrupted=False,
                failed=state.failed, messages=messages, conversation_history=[], effective_task_id="task",
                turn_id="turn", user_message="synthetic", original_user_message="synthetic",
                _should_review_memory=False, _turn_exit_reason=state._turn_exit_reason,
            )
        self.assertEqual(persisted[-1]["content"], "already visible\n\nstopped")
        self.assertFalse(agent.inflight)
        self.assertIsNone(agent._stream_callback)
        self.assertEqual(result["pending_steer"], "steer")
        agent._cleanup_task_resources.assert_called_once()
        self.assertFalse(result["completed"])

    def test_compression_budget_failure_preserves_history(self):
        mod = types.ModuleType("agent.conversation_compression")
        mod._raise_if_stale_attempt = lambda compressor: None
        budget_module = types.ModuleType("agent.brai_turn_budget")
        budget_module.TurnRequestBudgetExhausted = self.budget.TurnRequestBudgetExhausted
        budget_module.validate_client_timeouts = self.budget.validate_client_timeouts
        agent_module = types.ModuleType("agent")
        with patch.dict("sys.modules", {"agent": agent_module,
                                      "agent.conversation_compression": mod,
                                      "agent.brai_turn_budget": budget_module}):
            native = native_nodes(self.engine, "agent/context_compressor.py", {"_on_summary_failure"})
            compressor = types.SimpleNamespace()
            messages = [{"role": "user", "content": "preserved"}]
            self.assertIsNone(native._on_summary_failure(
                compressor, self.budget.TurnRequestBudgetExhausted("stop"), messages, None, ""))
            self.assertTrue(compressor._last_summary_network_failure)
            self.assertEqual(messages, [{"role": "user", "content": "preserved"}])

    def test_deterministic_fallback_marks_degraded(self):
        native = native_nodes(self.engine, "agent/context_compressor.py", {"_fallback_summary_for_window"})
        compressor = types.SimpleNamespace(
            quiet_mode=True, _last_summary_overload_degraded=False, _last_summary_error=None,
            _build_static_fallback_summary=lambda *args, **kwargs: "recoverable anchors",
            _strip_summary_prefix=lambda value: value,
        )
        telemetry = {}
        summary = native._fallback_summary_for_window(compressor, telemetry, [], 2, False)
        self.assertTrue(telemetry["degraded"])
        self.assertTrue(telemetry["fallback_used"])
        self.assertIn("not a model summary", summary)

    def test_empty_request_ids_after_success_are_new_baselines(self):
        for _ in range(8):
            attempt = self.state.start({})
            attempt.finish()
        self.assertEqual(self.state.spent, 0)
        self.assertEqual(self.state.physical, 8)

    def test_nested_turn_and_copied_worker_share_budget(self):
        @self.budget.turn_budget
        def nested():
            return self.budget._current.get()
        with ThreadPoolExecutor(max_workers=1) as pool:
            state = pool.submit(contextvars.copy_context().run, nested).result()
        self.assertIs(state, self.state)

    def test_interrupt_is_not_replaced_with_budget_error(self):
        self.state.spent = 2
        callback = self.budget.physical_callback(
            Mock(side_effect=InterruptedError("cancelled")), self.metadata())
        with self.assertRaises(InterruptedError):
            callback({})

    def test_native_watchdog_deadline_is_original_and_enforced(self):
        budget_module = types.ModuleType("agent.brai_turn_budget")
        budget_module.logical_deadline = self.budget.logical_deadline
        budget_module.TurnRequestBudgetExhausted = self.budget.TurnRequestBudgetExhausted
        budget_module.validate_client_timeouts = self.budget.validate_client_timeouts
        ticks = [0.0]
        h = types.SimpleNamespace(
            time=types.SimpleNamespace(time=lambda: ticks[0], monotonic=lambda: ticks[0]),
            _RequestClientRegistry=lambda agent: object(),
            _resolve_nonstream_watchdogs=lambda agent, kwargs: types.SimpleNamespace(
                stale_timeout=10.0, codex=False, idle_requires_progress=False,
                ttfb_enabled=False, idle_enabled=False, progress_timeout=0.0,
                idle_timeout=300.0, ttfb_timeout=900.0),
            _context_thread_target=lambda target: target,
        )
        agent = types.SimpleNamespace(api_mode="chat_completions", _current_api_request_id="api:1",
                                      _resolved_api_call_timeout=lambda: 1800.0,
                                      _touch_activity=Mock(), _interrupt_requested=False)
        modules = {"agent": types.ModuleType("agent"), "agent.brai_turn_budget": budget_module}
        with patch.dict("sys.modules", modules), patch.object(self.budget.time, "monotonic", lambda: ticks[0]):
            native = native_nodes(self.engine, "agent/chat_completion_nonstream.py", {"_NonStreamRequest"},
                                  h=h, wn=types.SimpleNamespace(WaitNoticeState=object))
            first = native._NonStreamRequest(agent, {})
            self.state.start(self.metadata()).finish(failed=True)
            ticks[0] = 8.0
            agent._current_api_request_id = "api:2"
            second = native._NonStreamRequest(agent, {})
            self.assertEqual(first.logical_deadline, 10.0)
            self.assertEqual(second.logical_deadline, first.logical_deadline)
            class Worker:
                def __init__(self, **kwargs):
                    pass
                def start(self):
                    pass
                def is_alive(self):
                    return True
                def join(self, **kwargs):
                    ticks[0] += 3
            h.threading = types.SimpleNamespace(Thread=Worker)
            second._emit_wait_notice = Mock()
            second._codex_watchdog_snapshot = lambda: (None, None, None, second.call_start)
            second._stale_kill = Mock(side_effect=lambda elapsed: second.result.update(error=TimeoutError()))
            with self.assertRaises(TimeoutError):
                second.run()
            second._stale_kill.assert_called_once()
            self.assertEqual(ticks[0], 11.0)
            # The remaining original budget was 2s; another nominal 10s is never granted.
            blocked = native._NonStreamRequest(agent, {})
            with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                blocked.run()
            with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                self.state.start(self.metadata("api:2"))

    def test_native_compression_fence_does_not_extend_original_deadline(self):
        budget_module = types.ModuleType("agent.brai_turn_budget")
        budget_module.logical_deadline = self.budget.logical_deadline
        clock = types.SimpleNamespace(monotonic=Mock(return_value=0.0))
        modules = {"agent": types.ModuleType("agent"), "agent.brai_turn_budget": budget_module}
        with patch.dict("sys.modules", modules), patch.object(self.budget.time, "monotonic", clock.monotonic):
            native = native_nodes(self.engine, "agent/conversation_compression.py", {"CompressionCommitFence"},
                                  threading=threading, time=clock)
            first = native.CompressionCommitFence(10)
            self.state.start(self.metadata("compression:1", "auxiliary:compression")).finish(failed=True)
            clock.monotonic.return_value = 8.0
            retry = native.CompressionCommitFence(20)
            self.assertEqual(retry.deadline_monotonic, 10.0)
            first.set_total_ceiling_seconds(99)
            self.assertEqual(first.deadline_monotonic, 10.0)
            clock.monotonic.return_value = 11.0
            self.assertTrue(retry.deadline_exceeded)

    def test_native_network_timeout_classification_preserves_history(self):
        kind_type = lambda **kwargs: types.SimpleNamespace(**kwargs)
        native = native_nodes(
            self.engine, "agent/context_compressor.py", {"_classify_summary_failure"},
            _exc_status_code=lambda error: None, CODEX_STREAM_STALL_MARKER="fixture-stall",
            _SummaryFailureKind=kind_type, _is_connection_error=lambda error: False,
            classify_api_error=lambda error: types.SimpleNamespace(reason=None),
            FailoverReason=types.SimpleNamespace(overloaded=object()),
            json=__import__("json"), _TRUNCATED_SUMMARY_MARKER="fixture-truncated",
        )
        kind = native._classify_summary_failure(TimeoutError("synthetic timeout"))
        self.assertTrue(kind.streaming_closed)

    def test_primary_codex_execute_counts_only_actual_inner_stream(self):
        relay = self.relay()
        def native_dispatch(request):
            stream = relay.ManagedLlmStream(
                {}, lambda req: iter([{"type": "response.completed"}]),
                session_id="", name="fixture", model_name="fixture", finalizer=lambda: None,
                metadata=self.metadata())
            return list(stream)
        relay.execute({}, native_dispatch, name="fixture", model_name="fixture", metadata=self.metadata())
        self.assertEqual(self.state.physical, 1)
        self.assertEqual(self.state.spent, 0)

    def test_typed_unmanaged_chunks_feed_finalizer_as_json_like_managed_path(self):
        def jsonable(value):
            return vars(value) if isinstance(value, types.SimpleNamespace) else value
        relay = self.relay(_jsonable=jsonable)
        raw = [types.SimpleNamespace(type="response.output_text.delta", delta="complete"),
               types.SimpleNamespace(type="response.completed")]
        observed = []
        finalize = lambda: self.assembler()._consume_codex_event_stream(observed, model="fixture")
        stream = relay.ManagedLlmStream(
            {}, lambda request: iter(raw), session_id="", name="fixture", model_name="fixture",
            finalizer=finalize, on_chunk=observed.append, metadata=self.metadata())
        self.assertEqual(list(stream), raw)
        self.assertEqual(observed, [vars(chunk) for chunk in raw])
        self.assertEqual(finalize().output_text, "complete")

    def test_next_successful_nonstream_iteration_has_its_own_deadline(self):
        clock = Mock(return_value=0.0)
        with patch.object(self.budget.time, "monotonic", clock):
            first = self.state.start(self.metadata("api:1"))
            self.assertEqual(self.budget.logical_deadline(10, request_id="api:1"), 10)
            first.finish()
            clock.return_value = 8.0
            self.state.start(self.metadata("api:2"))
            self.assertEqual(self.budget.logical_deadline(10, request_id="api:2"), 18)

    def test_commentary_done_without_delta_cannot_replay(self):
        delivered = []
        event = {"type": "response.output_item.done", "item": {
            "type": "message", "phase": "commentary",
            "content": [{"type": "output_text", "text": "already visible"}]}}
        def raw():
            yield event
            raise ConnectionError("drop")
        factory = Mock(side_effect=lambda request: raw())
        for _ in range(2):
            with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                stream = self.budget.physical_callback(factory, self.metadata(), streaming=True)({})
                self.assembler()._consume_codex_event_stream(
                    stream, model="fixture", on_commentary_message=delivered.append)
        factory.assert_called_once()
        self.assertEqual(delivered, ["already visible"])
        self.assertEqual(self.state.physical, 1)

    def test_native_consumer_interrupt_is_explicit_interruption(self):
        with self.assertRaises(InterruptedError):
            self.assembler()._consume_codex_event_stream(
                [{"type": "response.output_text.delta", "delta": "partial"}],
                model="fixture", interrupt_check=lambda: True)

    def test_native_outer_loop_reaches_finalize_after_budget_stop(self):
        tree = ast.parse((self.engine / "agent/conversation_loop.py").read_text())
        owner = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name == "_run_conversation_turn")
        loop_index = next(index for index, node in enumerate(owner.body) if isinstance(node, ast.While))
        body = owner.body[loop_index:]
        wrapper = ast.FunctionDef(
            name="run_boundary", args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="agent"), ast.arg(arg="s")],
                                                     kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=body, decorator_list=[])
        state = types.SimpleNamespace(
            api_call_count=0, api_start_time=None, retry_count=0, max_retries=3,
            turn_id="turn", _compression_timeout_exhausted=False,
            final_response="visible\n\nstopped", failed=True, messages=[{"role": "user", "content": "synthetic"}],
        )
        downstream = Mock(side_effect=AssertionError("no restart or provider request after budget stop"))
        finalized = []
        def finalizer(agent, *, final_response, failed, messages):
            finalized.append((final_response, failed))
            return {"final_response": final_response, "messages": messages}
        def retry(agent, state):
            state._request_budget_error = "stopped"
            state._request_budget_delivered = "visible"
            return None
        namespace = {
            "inspect": inspect, "time": __import__("time"), "_prelude_action": "fallthrough",
            "_run_phase": lambda function, *a: types.SimpleNamespace(action="fallthrough"),
            "_run_api_retry_loop": retry, "finalize_turn": finalizer,
            "TurnRetryState": types.SimpleNamespace,
            "begin_iteration": "begin", "prepare_iteration": "prepare", "assemble_api_request": "assemble",
            "run_preflight_gate": "preflight", "announce_api_call": "announce",
            "apply_retry_restarts": downstream,
        }
        exec(compile(ast.fix_missing_locations(ast.Module(body=[wrapper], type_ignores=[])),
                     "agent/conversation_loop.py", "exec"), namespace)
        agent = types.SimpleNamespace(max_iterations=10, iteration_budget=types.SimpleNamespace(remaining=10),
                                      _budget_grace_call=False, _api_max_retries=3)
        result = namespace["run_boundary"](agent, state)
        self.assertEqual(finalized, [("visible\n\nstopped", True)])
        self.assertEqual(result["error"], "stopped")
        self.assertTrue(result["partial"])
        self.assertNotEqual(result["final_response"], result["error"])
        self.assertEqual(result["brai_delivered_partial"], "visible")
        downstream.assert_not_called()

    @contextlib.contextmanager
    def native_policy_modules(self):
        module = types.ModuleType("agent.brai_turn_budget")
        module.validate_client_timeouts = self.budget.validate_client_timeouts
        module.logical_deadline = self.budget.logical_deadline
        module.TurnRequestBudgetExhausted = self.budget.TurnRequestBudgetExhausted
        providers = types.ModuleType("hermes_cli.providers")
        providers.is_actual_route = lambda *args: False
        helpers = types.ModuleType("agent.agent_runtime_helpers")
        with patch.dict("sys.modules", {"agent": types.ModuleType("agent"),
                                       "agent.brai_turn_budget": module,
                                       "agent.agent_runtime_helpers": helpers,
                                       "hermes_cli": types.ModuleType("hermes_cli"),
                                       "hermes_cli.providers": providers}):
            yield helpers

    def auxiliary_guard(self):
        return native_nodes(
            self.engine, "agent/auxiliary_client.py",
            {"_CodexStreamGuard", "_aux_stream_total_ceiling", "_CodexCompletionsAdapter"},
            time=__import__("time"), threading=threading,
            _AUX_STREAM_NO_PROGRESS_TIMEOUT_SECONDS=60.0,
            _AUX_STREAM_CEILING_FLOOR_SECONDS=600.0, _AUX_STREAM_CEILING_MULTIPLIER=4.0,
            _current_aux_stream_deadline=lambda: None,
            _aux_interrupt_protected=lambda: False,
            _evict_cached_client_instance=Mock(),
            _close_quietly=lambda client, note: client.close() if client else None,
            logger=logging.getLogger("guard-fixture"),
        )

    def test_primary_policy_is_checked_before_starting_provider_worker(self):
        sdk = Mock()
        wd = types.SimpleNamespace(
            stale_timeout=float("inf"), codex=False, idle_requires_progress=False,
            idle_enabled=True, idle_timeout=1200.0, ttfb_enabled=True, ttfb_timeout=1200.0,
            progress_timeout=0.0,
        )
        h = types.SimpleNamespace(
            _RequestClientRegistry=lambda agent: object(), _resolve_nonstream_watchdogs=lambda *args: wd,
            time=__import__("time"), _dispatch_nonstreaming_api_request=sdk,
        )
        native = native_nodes(self.engine, "agent/chat_completion_nonstream.py", {"_NonStreamRequest"},
                              h=h, wn=types.SimpleNamespace(WaitNoticeState=object))
        agent = types.SimpleNamespace(api_mode="chat_completions", _current_api_request_id="api:policy",
                                      _resolved_api_call_timeout=lambda: 1800.0)
        with self.native_policy_modules():
            allowed = native._NonStreamRequest(agent, {})
            self.assertEqual(allowed.wd.idle_timeout, 1200.0)
            self.assertEqual(allowed.wd.stale_timeout, float("inf"))
            agent._resolved_api_call_timeout = lambda: 1801.0
            with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                native._NonStreamRequest(agent, {}).run()
        sdk.assert_not_called()

    def test_compression_policy_rejects_override_before_sdk_create(self):
        native = self.auxiliary_guard()
        sdk = types.SimpleNamespace(responses=types.SimpleNamespace(create=Mock()), base_url="fixture")
        adapter = native._CodexCompletionsAdapter(sdk, "fixture")
        adapter._build_responses_kwargs = Mock(return_value=({"timeout": 1801}, "fixture", 1801))
        with self.native_policy_modules():
            with self.assertRaises(self.budget.TurnRequestBudgetExhausted):
                adapter.create(timeout=1801, no_progress_timeout=3600)
            allowed = native._CodexStreamGuard(sdk, 1200, no_progress_timeout=1200)
        self.assertEqual(allowed.no_progress_timeout, 1200)
        sdk.responses.create.assert_not_called()

    def test_genuinely_hung_auxiliary_socket_is_shutdown_by_native_guard(self):
        native = self.auxiliary_guard()
        ready, finished = threading.Event(), threading.Event()
        pair = socket.socketpair()
        closed, errors = [], []
        class Client:
            def close(self):
                pair[0].close()
                closed.append(True)
        def owner():
            guard = native._CodexStreamGuard(Client(), 1.0, no_progress_timeout=0.02)
            try:
                guard.start()
                ready.set()
                pair[0].recv(1)
            except BaseException as error:
                errors.append(error)
            finally:
                guard.finish()
                finished.set()
        with self.native_policy_modules() as helpers:
            def shutdown(client):
                pair[0].shutdown(socket.SHUT_RDWR)
                return 1
            helpers.force_close_tcp_sockets = shutdown
            worker = threading.Thread(target=owner, daemon=True)
            worker.start()
            self.assertTrue(ready.wait(1))
            self.assertTrue(finished.wait(2))
            worker.join(1)
        pair[1].close()
        self.assertEqual(errors, [])
        self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()

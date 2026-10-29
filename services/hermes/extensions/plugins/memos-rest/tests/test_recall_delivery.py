# ABOUTME: Проверяет явные ошибки памяти и завершение запоздавшего поиска Hermes.
# ABOUTME: Использует native MemoryManager и синтетический provider без сети и данных пользователя.
import threading
import unittest
from types import SimpleNamespace

from agent.memory_manager import MemoryManager
from agent.memory_provider import RecallStatus
from agent.turn_context import _memory_turn_start_and_prefetch


class Provider:
    """Предоставить управляемое завершение и результат для проверки native API."""

    name = 'fixture-memory'
    prefetch_timeout_seconds = 0.03

    def __init__(self):
        self.release = threading.Event()
        self.calls = 0
        self.status = None

    def get_tool_schemas(self):
        return []

    def on_turn_start(self, *args, **kwargs):
        pass

    def prefetch(self, query, *, session_id=''):
        self.calls += 1
        self.release.wait(timeout=2)
        self.status = RecallStatus('Fixture', 1)
        return 'Verified synthetic memory.'

    def recall_status(self):
        return self.status


class RecallDeliveryTests(unittest.TestCase):
    def test_real_turn_dispatch_emits_failure_notice_and_preserves_model_status(self):
        provider = Provider()
        def failure(*args, **kwargs):
            raise ConnectionError('synthetic transport failure')
        provider.prefetch = failure
        manager = MemoryManager()
        manager.add_provider(provider)
        emitted = []
        agent = SimpleNamespace(_memory_manager=manager, _user_turn_count=1,
                                session_id='synthetic-turn', _emit_status=emitted.append)
        text = _memory_turn_start_and_prefetch(agent, 'Find the earlier massage report')
        self.assertEqual(emitted, [manager.describe_recall()])
        self.assertIn('Память не прочитана', emitted[0])
        self.assertIn('retrieval failed for this turn', text)

    def test_timeout_running_and_late_completion_cannot_claim_success(self):
        provider = Provider()
        manager = MemoryManager()
        manager.add_provider(provider)
        try:
            text = manager.prefetch_all('first question')
            self.assertIn('истекло время ожидания', manager.describe_recall())
            self.assertIn('retrieval failed for this turn', text)
            text = manager.prefetch_all('next question')
            self.assertIn('предыдущий поиск ещё выполняется', manager.describe_recall())
            self.assertEqual(provider.calls, 1)
            provider.release.set()
            for thread in manager._external_prefetch_threads.values():
                thread.join(timeout=1)
            self.assertNotIn('recalled 1 memory', manager.describe_recall())
            self.assertIn('Verified synthetic memory', manager.prefetch_all('new question'))
            self.assertIn('recalled 1 memory', manager.describe_recall())
            self.assertNotIn('Память не прочитана', manager.describe_recall())
        finally:
            provider.release.set()

    def test_exception_details_are_not_exposed_to_user_or_model(self):
        provider = Provider()
        def failure(*args, **kwargs):
            raise ValueError('private-token-must-not-escape')
        provider.prefetch = failure
        manager = MemoryManager()
        manager.add_provider(provider)
        text = manager.prefetch_all('question')
        notice = manager.describe_recall()
        self.assertIn('Память не прочитана', notice)
        self.assertIn('retrieval failed for this turn', text)
        self.assertNotIn('private-token', text + notice)

    def test_invalid_provider_budget_reports_failure_before_starting_work(self):
        provider = Provider()
        provider.prefetch_timeout_seconds = float('nan')
        manager = MemoryManager()
        manager.add_provider(provider)
        self.assertIn('retrieval failed for this turn', manager.prefetch_all('question'))
        self.assertEqual(provider.calls, 0)
        self.assertIn('Память не прочитана', manager.describe_recall())

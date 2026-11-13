# ABOUTME: Удерживает новые native источники перед штатным переключением поколения.
# ABOUTME: Не меняет паузы, согласия, очереди и recovery; неизвестное состояние запрещает restart.
"""Операционный барьер конкретной версии immutable Hermes engine."""
import asyncio
from collections.abc import Mapping
from contextlib import asynccontextmanager
import re


class NativeRelease:
    """Сериализовать один release; готовность означает отсутствие живой работы."""

    def __init__(self, worker):
        self.worker = worker
        self.operation = None
        self.open = asyncio.Event()
        self.open.set()
        self.completions_open = asyncio.Event()
        self.completions_open.set()
        self.sources = 0
        self.tasks = set()
        self.fence = None

    def _owner(self, operation):
        if not isinstance(operation, str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.:-]*', operation):
            raise ValueError('RELEASE_OPERATION_REQUIRED')
        if self.operation not in (None, operation):
            raise ValueError('RELEASE_OPERATION_CHANGED')

    def install(self, runner):
        """Подключить hooks до запуска native recovery, ticker и watchers."""
        runner._brai_release_source = self.source
        runner._brai_release_completion = self.completion
        runner._brai_release_track = self.track
        if not hasattr(runner, '_deferred_agent_workers'):
            runner._deferred_agent_workers = {}
        original = getattr(runner, '_spawn_supervised', None)
        if not callable(original):
            return
        def supervised(factory, name, **kwargs):
            task = original(factory, name, **kwargs)
            if name.startswith('process_watcher:'):
                self.track(task)
            return task
        runner._spawn_supervised = supervised

    def track(self, task):
        """Держать finite native handoff/process-notification до фактического завершения."""
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    @asynccontextmanager
    async def source(self):
        """Войти в scan/claim только до release; принятый scan закончится полностью."""
        await self.open.wait()
        # Между Event.wait и счётчиком нет await: release.begin не пересекает допуск.
        self.sources += 1
        try:
            yield
        finally:
            self.sources -= 1

    @asynccontextmanager
    async def completion(self):
        """Позволить завершениям уже запущенной работы опустошить native очереди."""
        await self.completions_open.wait()
        self.sources += 1
        try:
            yield
        finally:
            self.sources -= 1

    async def begin(self, operationId):
        """Удержать будущие source scans; существующая работа продолжает исполнение."""
        self._owner(operationId)
        self.operation = operationId
        self.open.clear()
        return await self.status(operationId)

    def _busy(self):
        worker, runner, adapter = self.worker, self.worker.runner, self.worker.adapter
        if worker.lifecycle_error is not None or worker.exited.is_set():
            raise RuntimeError('NATIVE_LIFECYCLE_FAILED')
        if self.sources or any(not task.done() for task in self.tasks):
            return True
        if worker.active or any(worker.chat_dispatches.values()) or any(worker.chat_interactive.values()):
            return True
        # Неинициализированный bootstrap не запускал recovery/ticker/watchers.
        if not worker.activation.is_set():
            return False
        if not worker.operational.is_set() or not worker.policy_ready.is_set() or worker.policy_error is not None:
            raise RuntimeError('NATIVE_STARTUP_NOT_SETTLED')
        if getattr(runner, '_brai_release_protocol', None) != 1:
            raise RuntimeError('NATIVE_RELEASE_HOOK_REQUIRED')
        if getattr(runner, '_brai_release_cron_supported', None) is not True:
            raise RuntimeError('NATIVE_SCHEDULER_UNSUPPORTED')
        for owner, name in ((runner, '_running_agents'), (runner, '_queued_events'),
                (adapter, '_pending_messages'), (adapter, '_active_sessions'),
                (adapter, '_pending_text_batches'), (adapter, '_text_debounce')):
            value = getattr(owner, name)
            if not isinstance(value, Mapping):
                raise RuntimeError('NATIVE_QUEUE_UNAVAILABLE')
            if any(value.values()):
                return True
        for name in ('_session_tasks', '_pending_text_batch_tasks'):
            tasks = getattr(adapter, name)
            if not isinstance(tasks, dict):
                raise RuntimeError('NATIVE_TASKS_UNAVAILABLE')
            if any(not task.done() for task in tasks.values()):
                return True
        for owner in (runner, adapter):
            tasks = getattr(owner, '_background_tasks')
            if not isinstance(tasks, set):
                raise RuntimeError('NATIVE_BACKGROUND_UNAVAILABLE')
            if any(not task.done() and not getattr(task, '_hermes_supervised_watcher', False) for task in tasks):
                return True
        deferred = getattr(runner, '_deferred_agent_workers')
        if not isinstance(deferred, dict):
            raise RuntimeError('NATIVE_DEFERRED_UNAVAILABLE')
        if any(not task.done() for task in deferred):
            return True
        # Эти реальные readers бросают ошибку вместо старого best-effort нуля.
        from cron.scheduler import get_running_job_ids
        from tools.async_delegation import active_count
        from tools.process_registry import process_registry
        if (get_running_job_ids() or active_count() or process_registry.has_any_active()
                or process_registry.pending_watchers or not process_registry.completion_queue.empty()):
            return True
        # Worker поддерживает ровно один Telegram adapter; новый API listener запрещает proof.
        if len(runner.adapters) != 1 or next(iter(runner.adapters.values())) is not adapter:
            raise RuntimeError('NATIVE_ADAPTER_SET_CHANGED')
        return False

    async def status(self, operationId):
        """Не выдавать idle по недоступному reader, несовместимому hook или startup."""
        self._owner(operationId)
        if self.operation != operationId:
            raise ValueError('RELEASE_NOT_BEGUN')
        result = {'operationId': operationId, 'state': 'draining', 'reason': 'native_work'}
        try:
            # Уже принятый async turn может ещё создавать дочерние units: сначала ждём его.
            if self._busy():
                return result
            if self.worker.activation.is_set():
                from hermes_cli.backend_retirement import retirement
                hold = getattr(retirement, 'brai_hold', None)
                if not callable(hold):
                    raise RuntimeError('NATIVE_RELEASE_HOOK_REQUIRED')
                # Сначала атомарно закрываем thread sources. Активный scan не обрываем.
                if not hold(operationId):
                    return result
                self.fence = retirement
            if self._busy():
                return result
        except Exception:
            return {**result, 'state': 'blocked', 'reason': 'native_state_unavailable'}
        # После пустого снимка не даём следующему completion scan пересечь proof.
        # Между снимком и закрытием нет await; durable completions останутся до запуска.
        self.completions_open.clear()
        return {**result, 'state': 'ready', 'reason': None}

    async def resume(self, operationId):
        """Снять только свой fence; повтор после потерянного ответа безопасен."""
        self._owner(operationId)
        if self.fence is not None:
            self.fence.brai_resume(operationId)
            self.fence = None
        self.completions_open.set()
        self.open.set()
        self.operation = None
        return {'operationId': operationId, 'state': 'resumed', 'reason': None}

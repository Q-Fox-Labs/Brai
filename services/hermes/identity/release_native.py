# ABOUTME: Удерживает новые native источники перед штатным переключением поколения.
# ABOUTME: Не меняет паузы, согласия, очереди и recovery; неизвестное состояние запрещает restart.
"""Операционный барьер конкретной версии immutable Hermes engine."""
import asyncio
import hashlib
import os
from pathlib import Path
import uuid
from collections.abc import Mapping
from contextlib import asynccontextmanager
import re

_STARTUP_HOLD = ('BRAI_IDENTITY_RELEASE_HOLD_OPERATION', 'BRAI_IDENTITY_RELEASE_HOLD_SOURCE_SHA256')
_PROCESS_METADATA = ('INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID')


class NativeRelease:
    """Сериализовать один release; готовность означает отсутствие живой работы."""

    def __init__(self, worker):
        self.worker = worker
        self.operation = None
        self.last_resumed = None
        self.open = asyncio.Event()
        self.open.set()
        self.completions_open = asyncio.Event()
        self.completions_open.set()
        self.recovery_open = asyncio.Event()
        self.recovery_done = asyncio.Event()
        self.sources = 0
        self.tasks = set()
        self.fence = None
        self.cold_start = False
        self.attempt = None

    def bootstrap(self, source):
        """Root-bound cold startup closes both sources before native construction."""
        operation = os.environ.get('BRAI_IDENTITY_RELEASE_HOLD_OPERATION')
        digest = os.environ.get('BRAI_IDENTITY_RELEASE_HOLD_SOURCE_SHA256')
        held = operation is not None or digest is not None
        if held and (not operation or not digest or str(uuid.UUID(operation)) != operation
                or not re.fullmatch('[a-f0-9]{64}', digest)
                or Path(source) != Path('/opt/brai-profile/runtime/services/hermes/identity/worker.py')
                or hashlib.sha256(Path(source).read_bytes()).hexdigest() != digest):
            raise RuntimeError('Root startup release binding unavailable')
        # The startup-only values must not leak into executable tool environments.
        # /proc/<pid>/environ retains the original systemd binding for Root checks.
        for name in (*_STARTUP_HOLD, *_PROCESS_METADATA):
            os.environ.pop(name, None)
        if not held:
            return
        from hermes_cli.backend_retirement import retirement
        if not callable(getattr(retirement, 'brai_hold', None)) or not retirement.brai_hold(operation):
            raise RuntimeError('Root startup release fence unavailable')
        self.fence = retirement
        self.operation = operation
        self.cold_start = True
        self.open.clear()
        self.completions_open.clear()

    def _owner(self, operation):
        if not isinstance(operation, str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.:-]*', operation):
            raise ValueError('RELEASE_OPERATION_REQUIRED')
        if self.operation not in (None, operation):
            raise ValueError('RELEASE_OPERATION_CHANGED')

    def install(self, runner):
        """Подключить hooks до запуска native recovery, ticker и watchers."""
        runner._brai_release_cold = self.cold_start
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

    def _profile_binding(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime):
        for value in (operationId, attemptId, profileId):
            if not isinstance(value, str) or str(uuid.UUID(value)) != value:
                raise ValueError('RELEASE_IDENTITY_REQUIRED')
        if (profileId != os.environ.get('BRAI_IDENTITY_PROFILE_ID') or type(workerPid) is not int
                or workerPid != os.getpid() or not isinstance(workerStartTime, str)
                or not isinstance(targetPayloadHash, str) or not re.fullmatch('[a-f0-9]{64}', targetPayloadHash)):
            raise ValueError('RELEASE_BINDING_CHANGED')
        stat = Path('/proc/self/stat').read_text()
        observed = stat.rsplit(')', 1)[1].split()[19]
        if observed != workerStartTime:
            raise ValueError('RELEASE_BINDING_CHANGED')
        return (operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime)

    async def try_hold(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime):
        """Закрыть источники только если уже свободны, сохранив решение exact attempt."""
        binding = self._profile_binding(operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime)
        self._owner(operationId)
        if self.attempt is not None:
            old, result = self.attempt
            if binding == old:
                return self._attempt_receipt(binding)
            if old[0] == operationId:
                if old[2:] != binding[2:] or result['state'] != 'busy':
                    raise ValueError('RELEASE_ATTEMPT_CHANGED')
            elif (self.operation is not None or (result['state'] != 'busy'
                  and self.last_resumed != old[0])):
                raise ValueError('RELEASE_ATTEMPT_CHANGED')
        if self.operation is not None:
            raise ValueError('RELEASE_ALREADY_ACTIVE')
        result = {'operationId': operationId, 'attemptId': attemptId, 'profileId': profileId,
                  'state': 'busy', 'reason': 'native_work'}
        try:
            if not self.worker.activation.is_set() or self._busy():
                self.attempt = (binding, dict(result))
                return result
            from hermes_cli.backend_retirement import retirement
            hold, resume = getattr(retirement, 'brai_hold', None), getattr(retirement, 'brai_resume', None)
            if not callable(hold) or not callable(resume):
                raise RuntimeError('NATIVE_RELEASE_HOOK_REQUIRED')
            self.fence = retirement
            if not hold(operationId):
                resume(operationId)
                self.fence = None
                self.attempt = (binding, dict(result))
                return result
            if self._busy():
                resume(operationId)
                self.fence = None
                self.attempt = (binding, dict(result))
                return result
            self.operation = operationId
            self.open.clear()
            self.completions_open.clear()
            result = {**result, 'state': 'ready', 'reason': None}
        except Exception:
            if self.fence is not None:
                self.operation = operationId
                self.open.clear()
                self.completions_open.clear()
            result = {**result, 'state': 'blocked', 'reason': 'native_state_unavailable'}
        self.attempt = (binding, dict(result))
        return result

    def _attempt_receipt(self, binding):
        operationId, attemptId, profileId = binding[:3]
        unknown = {'operationId': operationId, 'attemptId': attemptId, 'profileId': profileId,
                   'state': 'unknown', 'reason': 'attempt_unavailable'}
        if self.attempt is None or self.attempt[0] != binding:
            return unknown
        result = self.attempt[1]
        if result['state'] == 'ready' and self.operation != operationId:
            return unknown
        if result['state'] == 'busy' and not self._sources_unfenced():
            return unknown
        return dict(result)

    def _sources_unfenced(self):
        if (self.operation is not None or self.fence is not None
                or not self.open.is_set() or not self.completions_open.is_set()):
            return False
        try:
            from hermes_cli.backend_retirement import retirement
            with retirement._lock:
                return (retirement._brai_release_owner is None and not retirement._preparing
                        and retirement._token is None and not retirement._committed)
        except Exception:
            return False

    async def try_status(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime):
        binding = self._profile_binding(operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime)
        return self._attempt_receipt(binding)

    async def reject_attempt(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime):
        """Record ingress-busy without closing native sources or taking the fence."""
        binding = self._profile_binding(operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime)
        self._owner(operationId)
        if self.attempt is not None:
            old, result = self.attempt
            if old == binding:
                return self._attempt_receipt(binding)
            if old[0] == operationId:
                if old[2:] != binding[2:] or result['state'] != 'busy':
                    raise ValueError('RELEASE_ATTEMPT_CHANGED')
            elif self.operation is not None or (result['state'] != 'busy' and self.last_resumed != old[0]):
                raise ValueError('RELEASE_ATTEMPT_CHANGED')
        if not self._sources_unfenced():
            raise ValueError('RELEASE_ALREADY_ACTIVE')
        result = {'operationId': operationId, 'attemptId': attemptId, 'profileId': profileId,
                  'state': 'busy', 'reason': 'ingress_work'}
        self.attempt = (binding, dict(result))
        return result

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
            if self.operation is None and self.last_resumed == operationId:
                return {'operationId': operationId, 'state': 'resumed', 'reason': None}
            raise ValueError('RELEASE_NOT_BEGUN')
        result = {'operationId': operationId, 'state': 'draining', 'reason': 'native_work'}
        if self.cold_start and self.recovery_open.is_set():
            if self.worker.policy_error is not None:
                return {**result, 'state': 'blocked', 'reason': 'native_state_unavailable'}
            return {**result, 'reason': 'native_recovery'}
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

    def finish_cold_recovery(self):
        """Open all admissions only after the one owned recovery completed."""
        if not self.cold_start or not self.recovery_open.is_set():
            raise RuntimeError('Cold recovery is not released')
        if self.fence is not None:
            self.fence.brai_resume(self.operation)
            self.fence = None
        self.completions_open.set()
        self.open.set()
        self.last_resumed = self.operation
        self.operation = None
        self.cold_start = False
        if self.worker.runner is not None:
            self.worker.runner._brai_release_cold = False

    async def resume(self, operationId):
        """Снять свой hold; cold recovery завершается до открытия источников."""
        self._owner(operationId)
        if self.operation is None:
            if self.last_resumed != operationId:
                raise ValueError('RELEASE_NOT_BEGUN')
            return {'operationId': operationId, 'state': 'resumed', 'reason': None}
        if self.cold_start:
            if (not self.worker.operational.is_set() or not self.worker.policy_ready.is_set()
                    or self.worker.policy_error is not None or self.worker.policy_stopping):
                raise RuntimeError('Cold policy is not ready')
            self.recovery_open.set()
            if self.worker.cold_recovery_task is None:
                try:
                    self.finish_cold_recovery()
                finally:
                    self.recovery_done.set()
            await self.recovery_done.wait()
            if self.worker.policy_error is not None or self.last_resumed != operationId:
                raise RuntimeError('Cold recovery failed')
            return {'operationId': operationId, 'state': 'resumed', 'reason': None}
        if self.fence is not None:
            self.fence.brai_resume(operationId)
            self.fence = None
        self.completions_open.set()
        self.open.set()
        self.last_resumed = self.operation
        self.operation = None
        return {'operationId': operationId, 'state': 'resumed', 'reason': None}

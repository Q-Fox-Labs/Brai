# ABOUTME: Исполняет постоянные задания Auth внутри существующего root broker.
# ABOUTME: Продлевает lease; при потере полномочий завершает собственный Ansible.
"""Последовательная подготовка и остановка личного Hermes без новой службы."""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import signal
import uuid


async def terminate(child):
    """Дать entrypoint закрыть Ansible-группу; затем завершить свой процесс."""
    if child.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        child.send_signal(signal.SIGTERM)
    try:
        await asyncio.wait_for(child.wait(), 12)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        await child.wait()


class LifecycleRunner:
    """Получать только доверенные Auth-задания, не параметры личного worker."""

    def __init__(self, control, command, *, interval=2, renew_interval=10):
        if (not isinstance(command, list) or not command
                or not all(isinstance(value, str) and value for value in command)
                or not Path(command[0]).is_absolute()):
            raise ValueError('Invalid lifecycle command')
        self.control, self.command = control, command
        self.interval, self.renew_interval = interval, renew_interval
        self.worker_id = 'broker-' + uuid.uuid4().hex

    async def renew(self, operation):
        """Отказ или недоступность Auth означают потерю права продолжать работу."""
        while True:
            await asyncio.sleep(self.renew_interval)
            reply = await self.control.call('identity.lifecycle-renew', {
                'operationId': operation['id'], 'leaseToken': operation['leaseToken']}, timeout=12)
            if reply.get('accepted') is not True:
                raise PermissionError('Lifecycle lease lost')

    async def execute(self, operation):
        """Ограничить длительность и передать user только через stdin root entrypoint."""
        if operation.get('kind') not in ('prepare', 'stop') or not isinstance(operation.get('user'), dict):
            raise ValueError('Invalid lifecycle operation')
        child = await asyncio.create_subprocess_exec(*self.command, '--action', operation['kind'],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
            env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'})
        renewal = asyncio.create_task(self.renew(operation))
        work = asyncio.create_task(child.communicate(json.dumps({'user': operation['user']}).encode()))
        try:
            done, _ = await asyncio.wait({work, renewal}, timeout=630,
                                        return_when=asyncio.FIRST_COMPLETED)
            if renewal in done:
                await renewal
                raise PermissionError('Lifecycle lease lost')
            if work not in done:
                raise TimeoutError('Lifecycle timeout')
            await work
            # AIDEV-NOTE: Повторная проверка закрывает окно между health и завершением.
            renewed = await self.control.call('identity.lifecycle-renew', {
                'operationId': operation['id'], 'leaseToken': operation['leaseToken']}, timeout=12)
            if renewed.get('accepted') is not True:
                raise PermissionError('Lifecycle lease lost')
            return child.returncode == 0
        finally:
            renewal.cancel()
            await asyncio.gather(renewal, return_exceptions=True)
            await terminate(child)
            await asyncio.gather(work, return_exceptions=True)

    async def once(self):
        """Захватить одно задание; неизвестный результат завершения сверяется через Auth."""
        response = await self.control.call('identity.lifecycle-claim', {'workerId': self.worker_id}, timeout=12)
        operation = response.get('operation')
        if operation is None:
            return False
        try:
            success = await self.execute(operation)
            error_code = None if success else 'PROFILE_FAILED'
        except asyncio.CancelledError:
            raise
        except PermissionError:
            # Отменённая операция освобождает собственный lease после остановки child.
            await self.control.call('identity.lifecycle-complete', {
                'operationId': operation['id'], 'leaseToken': operation['leaseToken'],
                'success': False, 'errorCode': 'PROFILE_FAILED'}, timeout=12)
            return True
        except Exception:
            success, error_code = False, 'PROFILE_FAILED'
        await self.control.call('identity.lifecycle-complete', {
            'operationId': operation['id'], 'leaseToken': operation['leaseToken'],
            'success': success, **({'errorCode': error_code} if error_code else {})}, timeout=12)
        return True

    async def run(self):
        """Опросить постоянное состояние; сетевой отказ не теряет поручение."""
        while True:
            try:
                processed = await self.once()
            except asyncio.CancelledError:
                raise
            except Exception:
                processed = False
            await asyncio.sleep(0 if processed else self.interval)

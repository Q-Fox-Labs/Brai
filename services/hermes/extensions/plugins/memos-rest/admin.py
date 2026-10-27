# ABOUTME: Ограничивает обслуживание MemOS точным владельцем и профилем.
# ABOUTME: Сохраняет блокировки, подтверждение очистки и fencing прежних сессий.
"""Explicit profile/owner/cube-scoped maintenance; never invoked automatically."""
import fcntl
import json
import os
import sqlite3
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from utils import atomic_json_write
from .client import Client, MemOSError
from .router import Catalog, stable_id


@contextmanager
def file_lock(path, timeout=120):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('a') as handle:
        os.chmod(path, 0o600)
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise MemOSError('Writer lock timeout; memory remains frozen') from None
                time.sleep(.05)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def json_file(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return {} if default is None else default
    except (OSError, ValueError):
        raise MemOSError('Memory control file unreadable; fail closed') from None


class Admin:
    def __init__(self, home, api=None):
        self.home = Path(home)
        self.root = self.home / 'memos-rest'
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.config_path = self.home / 'memos-rest.json'
        self.api = api

    def config(self):
        """Прочитать настроенную tenant identity; управляющего root alias нет."""
        config = json_file(self.config_path)
        owner = config.get('user_id')
        profile = config.get('scope_profile', 'default')
        if (not config.get('base_url') or not isinstance(owner, str) or not owner.strip()
                or not isinstance(profile, str) or not profile.strip()):
            raise ValueError('Maintenance requires configured owner and scope profile')
        Client(config)
        return config

    def scope(self, scope):
        """Проверить точный профиль, tenant owner и полный набор управляемых кубов."""
        config = self.config()
        if (scope.get('profile') != config.get('scope_profile', 'default')
                or scope.get('user_id') != config['user_id']
                or sorted(scope.get('managed_cubes', [])) != sorted(Catalog(self.home).cubes)):
            raise ValueError('Maintenance scope must explicitly match configured profile/owner/all managed cubes')
        return Catalog(self.home).cubes

    def write(self, config):
        atomic_json_write(self.config_path, config, mode=0o600, fsync_dir=True)

    def prepare(self, scope, router=None, memory_epoch=None):
        self.scope(scope)
        with file_lock(self.root / 'admin.lock'), file_lock(self.root / 'submit.lock'):
            config = self.config()
            if config.get('deployment_phase') == 'production':
                raise ValueError('Prepare cannot demote production')
            config.update(routing_enabled=True, deployment_phase='setup',
                          memory_epoch=config.get('memory_epoch') or memory_epoch or uuid.uuid4().hex,
                          generation=config.get('generation', 1), enabled=True, frozen=True, suspended=False)
            if router is not None:
                config['router'] = router
            if not (self.home / 'memos-catalog.json').exists():
                atomic_json_write(self.home / 'memos-catalog.json', Catalog(self.home).data, mode=0o600, fsync_dir=True)
            self.write(config)
        return self.status()

    def status(self):
        """Вернуть состояние настроенной области без подмены tenant identity."""
        config = self.config()
        return {key: config.get(key) for key in ('routing_enabled', 'deployment_phase', 'memory_epoch',
                'generation', 'enabled', 'frozen', 'suspended', 'bulk_clear_locked', 'backend_write_paused')} | {'profile': config.get('scope_profile', 'default'), 'user_id': config['user_id'],
                'managed_cubes': Catalog(self.home).cubes,
                'admin_operation': json_file(self.root / 'admin-state.json').get('status')}

    def freeze(self, scope, timeout=120):
        self.scope(scope)
        with file_lock(self.root / 'admin.lock'), file_lock(self.root / 'submit.lock'):
            config = self.config()
            config['frozen'] = True
            self.write(config)
        # No submission can pass the frozen boundary; wait for the in-flight writer.
        with file_lock(self.root / 'delivery.lock', timeout):
            pass
        return self.status()

    def resume(self, scope):
        self.scope(scope)
        with file_lock(self.root / 'admin.lock'), file_lock(self.root / 'submit.lock'):
            state = json_file(self.root / 'admin-state.json')
            if state.get('status') == 'in_progress':
                raise ValueError('Purge/handoff must complete before resume')
            config = self.config()
            if config.get('backend_write_paused') is True:
                raise ValueError('Запись в базе данных приостановлена. Сначала требуется отдельно разрешённое восстановление прав записи и проверка нового адаптера.')
            if not config.get('memory_epoch') or config.get('deployment_phase') not in ('setup', 'production'):
                raise ValueError('Prepare is required before resume')
            config.update(frozen=False, suspended=False, enabled=True)
            self.write(config)
        return self.status()

    def purge(self, scope, confirmation, new_epoch=None, timeout=120):
        return self._clean(scope, confirmation, 'setup', new_epoch, timeout)

    def handoff(self, scope, confirmation, new_epoch=None, timeout=120):
        return self._clean(scope, confirmation, 'production', new_epoch, timeout)

    def handoff_empty(self, scope, new_epoch, timeout=120):
        """Передать только пустую frozen область в production без удаления и разблокировки.

        Требуются точные owner/profile/all managed cubes, свежий epoch, пустые
        backend, pending и receipts. Interrupted exact operation можно продолжить;
        при отказе до проверки пустоты config, fence и state не меняются.
        """
        self.scope(scope)
        if not isinstance(new_epoch, str) or not new_epoch.strip() or len(new_epoch) > 128:
            raise ValueError('Empty handoff requires a fresh explicit epoch')
        with file_lock(self.root / 'admin.lock', timeout), file_lock(self.root / 'delivery.lock', timeout), file_lock(self.root / 'submit.lock', timeout):
            cubes = self.scope(scope)
            config = self.config()
            if config.get('frozen') is not True or config.get('bulk_clear_locked') is not True:
                raise ValueError('Empty handoff requires frozen memory and bulk clear lock')
            state_path = self.root / 'admin-state.json'
            state = json_file(state_path)
            matching = (state.get('empty_only') is True and state.get('profile') == scope['profile']
                        and state.get('user_id') == scope['user_id'] and state.get('cubes') == cubes
                        and state.get('phase') == 'production' and state.get('new_epoch') == new_epoch)
            if config.get('memory_epoch') == new_epoch and matching and state.get('status') == 'complete':
                return self.status()
            if state.get('status') == 'in_progress' and not matching:
                raise ValueError('Resume the exact interrupted maintenance operation')
            if config.get('memory_epoch') == new_epoch and not (matching and state.get('status') == 'in_progress'):
                raise ValueError('Empty handoff requires a fresh explicit epoch')
            for folder in ('pending', 'receipts'):
                path = self.root / folder
                if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
                    raise MemOSError('Empty handoff requires empty native pending and receipts')
            api = self.api or Client(config)
            for cube in cubes:
                scoped = Client({**config, 'cube_id': cube})
                scoped.request = api.request
                if scoped.get({}):
                    raise MemOSError('Empty handoff requires zero owner memories in every managed cube')
            if not (matching and state.get('status') == 'in_progress'):
                state = {'status': 'in_progress', 'phase': 'production', 'cubes': cubes,
                         'profile': scope['profile'], 'user_id': scope['user_id'], 'empty_only': True,
                         'old_epoch': config.get('memory_epoch'), 'new_epoch': new_epoch,
                         'started_at': time.time(), 'generation': config.get('generation', 1) + 1}
            # AIDEV-NOTE: Переход не удаляет данные; _clean и очистку очередей здесь вызывать нельзя.
            fence_path = self.root / 'session-fence.json'
            fence = json_file(fence_path)
            revoked = set(fence.get('revoked', [])) | set(fence.get('sessions', {}))
            db = self.home / 'state.db'
            if db.exists():
                try:
                    with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as conn:
                        revoked.update(stable_id(str(r[0])) for r in conn.execute('SELECT id FROM sessions WHERE started_at <= ?', (state['started_at'],)))
                except sqlite3.Error:
                    raise MemOSError('Cannot fence pre-handoff Hermes sessions; memory remains frozen') from None
            fence.update(revoked=sorted(revoked), cutoff=state['started_at'], sessions={})
            atomic_json_write(state_path, state, mode=0o600, fsync_dir=True)
            atomic_json_write(fence_path, fence, mode=0o600, fsync_dir=True)
            config.update(routing_enabled=True, deployment_phase='production', memory_epoch=new_epoch,
                          generation=state['generation'], frozen=True, enabled=False, suspended=False)
            self.write(config)
            state['status'] = 'complete'
            atomic_json_write(state_path, state, mode=0o600, fsync_dir=True)
        return self.status()

    def _destructive_config(self, scope):
        """Перепроверить исходную default/root область, включая чтение после ожидания lock."""
        config = self.config()
        if (config['user_id'] != 'root' or config.get('scope_profile', 'default') != 'default'
                or 'profiles' in self.home.parts or scope.get('profile') != 'default'
                or scope.get('user_id') != 'root'
                or sorted(scope.get('managed_cubes', [])) != sorted(Catalog(self.home).cubes)):
            raise ValueError('Destructive maintenance requires default/root scope')
        return config

    def _clean(self, scope, confirmation, phase, new_epoch, timeout):
        cubes = self.scope(scope)
        # AIDEV-NOTE: Разрушительное обслуживание остаётся только в исходной области default/root.
        self._destructive_config(scope)
        if confirmation != 'PURGE default/root managed':
            raise ValueError('Explicit purge confirmation is required')
        with file_lock(self.root / 'admin.lock', timeout):
            with file_lock(self.root / 'submit.lock', timeout):
                config = self._destructive_config(scope)
                if config.get('bulk_clear_locked') is True:
                    raise ValueError('Защита массовой очистки включена. Нужны отдельное подтверждение владельца и явное разрешение разблокировки; обычной просьбы недостаточно.')
                config['frozen'] = True
                self.write(config)
            with file_lock(self.root / 'delivery.lock', timeout), file_lock(self.root / 'submit.lock', timeout):
                state_path = self.root / 'admin-state.json'
                state = json_file(state_path)
                if state.get('status') == 'in_progress':
                    if state.get('phase') != phase or state.get('cubes') != cubes or (new_epoch and new_epoch != state['new_epoch']):
                        raise ValueError('Resume the exact interrupted maintenance operation')
                else:
                    if new_epoch and new_epoch == config.get('memory_epoch'):
                        if state.get('status') == 'complete' and state.get('new_epoch') == new_epoch and state.get('phase') == phase:
                            return self.status()
                        raise ValueError('Purge/handoff requires a fresh epoch')
                    state = {'status': 'in_progress', 'phase': phase, 'cubes': cubes,
                             'old_epoch': config.get('memory_epoch'), 'new_epoch': new_epoch or uuid.uuid4().hex,
                             'started_at': time.time(), 'generation': config.get('generation', 1) + 1}
                    atomic_json_write(state_path, state, mode=0o600, fsync_dir=True)
                # Session fence survives queue/receipt destruction; contains hashes, not dialogue.
                fence_path = self.root / 'session-fence.json'
                fence = json_file(fence_path)
                revoked = set(fence.get('revoked', [])) | set(fence.get('sessions', {}))
                db = self.home / 'state.db'
                if db.exists():
                    try:
                        with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as conn:
                            revoked.update(stable_id(str(r[0])) for r in conn.execute('SELECT id FROM sessions WHERE started_at <= ?', (state['started_at'],)))
                    except sqlite3.Error:
                        raise MemOSError('Cannot fence pre-handoff Hermes sessions; memory remains frozen') from None
                fence.update(revoked=sorted(revoked), cutoff=state['started_at'], sessions={})
                atomic_json_write(fence_path, fence, mode=0o600, fsync_dir=True)
                api = self.api or Client(config)
                for cube in cubes:
                    scoped = Client({**config, 'cube_id': cube})
                    scoped.request = api.request
                    ids = sorted({r['id'] for r in scoped.get({})})
                    scoped.delete(ids)
                    if scoped.get({}):
                        raise MemOSError('Managed cube purge read-back failed; memory remains frozen')
                for folder in ('pending', 'receipts'):
                    path = self.root / folder
                    if path.exists():
                        for item in path.glob('*.json'):
                            item.unlink()
                        directory = os.open(path, os.O_DIRECTORY)
                        try:
                            os.fsync(directory)
                        finally:
                            os.close(directory)
                config.update(routing_enabled=True, deployment_phase=phase, memory_epoch=state['new_epoch'],
                              generation=state['generation'], frozen=True, enabled=True, suspended=False)
                self.write(config)
                state['status'] = 'complete'
                atomic_json_write(state_path, state, mode=0o600, fsync_dir=True)
        return self.status()

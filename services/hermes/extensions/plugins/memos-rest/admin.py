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
from .client import Client, MemOSError, business_private, fact_fields, memory_text
from .router import Catalog, SemanticRouter, stable_id, QUALITY_VERSION


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

    def quality_plan(self, scope, restore_plan_id=None):
        """Проверить факты без изменения MemOS, сохранив обратимый план в профиле.

        Источники и копии проверяются по owner/home/epoch. Пользовательские данные
        плана остаются в закрытом runtime-каталоге и не попадают в вывод CLI.
        """
        cubes = self.scope(scope)
        config = self.config()
        catalog = Catalog(self.home)
        router = SemanticRouter(config.get('router', {}), catalog)
        api = self.api or Client(config)
        clients = {cube: Client({**config, 'cube_id': cube}) for cube in cubes}
        for client in clients.values():
            client.request = api.request
        rows = [row for client in clients.values() for row in client.get({})
                if self._quality_allowed(row, config)]
        restore = {}
        if restore_plan_id is not None:
            if not isinstance(restore_plan_id, str) or uuid.UUID(restore_plan_id).hex != restore_plan_id:
                raise ValueError('Invalid restoration plan ID')
            previous_path = self.root / 'quality' / (restore_plan_id + '.json')
            previous = json_file(previous_path)
            previous_state = json_file(previous_path.with_suffix('.progress.json'))
            if (previous.get('complete') is not True or previous_state.get('complete') is not True
                    or previous.get('scope') != scope or previous.get('epoch') != config['memory_epoch']
                    or previous.get('home_scope') != stable_id(str(self.home.resolve()))
                    or previous_state.get('plan_sha') != stable_id(previous)):
                raise ValueError('Restoration requires a completed matching historical snapshot')
            for item in previous['items']:
                if item.get('accepted'):
                    restore[item['logical_id']] = (previous['version'], memory_text(item['before'][0]))
        sources = {}
        groups = {}
        for row in rows:
            meta, info = row['metadata'], row['metadata']['info']
            key = (info['hermes_author_id'], meta.get('session_id'))
            if info.get('hermes_kind') in ('turn', 'native', 'explicit'):
                sources.setdefault(key, {})[info['hermes_event_id']] = info.get('hermes_messages', [])
            elif info.get('hermes_kind') == 'fact':
                groups.setdefault(key, {}).setdefault(info['hermes_logical_id'], []).append(row)
        directory = self.root / 'quality'
        directory.mkdir(mode=0o700, exist_ok=True)
        plan_id = uuid.uuid4().hex
        plan = {'version': QUALITY_VERSION, 'id': plan_id, 'scope': scope,
                'epoch': config['memory_epoch'], 'home_scope': stable_id(str(self.home.resolve())),
                'items': []}
        path = directory / (plan_id + '.json')
        for key, logical in groups.items():
            events = sources.get(key, {})
            context = [m['content'] if m.get('role') == 'user' else '[assistant historical source]\n' + m['content']
                       for event in events.values() for m in event if m.get('role') in ('user', 'assistant')]
            candidates, items = [], []
            for logical_id, copies in logical.items():
                info = copies[0]['metadata']['info']
                quote = info.get('hermes_source', {}).get('quote', '')
                role = info.get('hermes_source', {}).get('role')
                grounded = bool(quote) and any(quote in m.get('content', '') and m.get('role') == role
                    for m in events.get(info.get('hermes_source_event'), []))
                content = memory_text(copies[0])
                restored_from = None
                if logical_id in restore:
                    version, original_text = restore[logical_id]
                    exact_transition = all(r['metadata']['info'].get('hermes_event_id')
                        == stable_id([version, logical_id, r['_cube_id']]) for r in copies)
                    if exact_transition and original_text != content:
                        content, restored_from = original_text, restore_plan_id
                item = {'logical_id': logical_id, 'before': copies, 'text': content, 'accepted': False,
                        'grounded': grounded, 'memberships': [], 'restored_from': restored_from}
                items.append(item)
                if grounded:
                    candidates.append({'_logical_id': logical_id, 'text': content,
                        'source': info['hermes_source'], 'status': info.get('hermes_status', 'unknown'),
                        'spheres': info.get('hermes_spheres', []), 'projects': info.get('hermes_projects', []),
                        'memberships': info.get('hermes_memberships', [])})
            accepted = {}
            from .router import evidence_context
            for start in range(0, len(candidates), 20):
                batch = candidates[start:start + 20]
                for fact in router.review(batch, evidence_context(context, batch)):
                    accepted[fact['_logical_id']] = fact
            rejected = [fact for fact in candidates if fact['_logical_id'] not in accepted]
            for start in range(0, len(rejected), 20):
                batch = rejected[start:start + 20]
                for fact in router.review(batch, evidence_context(context, batch), conservative=True):
                    accepted[fact['_logical_id']] = fact
            for item in items:
                if item['logical_id'] in accepted:
                    fact = accepted[item['logical_id']]
                    item.update(accepted=True, memberships=fact['memberships'], spheres=fact['spheres'],
                                reason=fact.get('_review_reason', 'Reviewed useful fact'))
                plan['items'].append(item)
            atomic_json_write(path, plan, mode=0o600, fsync_dir=True)
        plan['complete'] = True
        atomic_json_write(path, plan, mode=0o600, fsync_dir=True)
        return self.quality_summary(plan) | {'plan_id': plan_id, 'plan_sha': stable_id(plan)}

    def _quality_allowed(self, row, config):
        """Отобрать только обычную память текущего профиля, без Business-приватных строк."""
        meta = row.get('metadata') or {}
        info = meta.get('info') or {}
        return (meta.get('user_id') == config['user_id'] and not business_private(row)
                and info.get('hermes_home_scope') == stable_id(str(self.home.resolve()))
                and info.get('hermes_memory_epoch') == config['memory_epoch']
                and row.get('_cube_id') in Catalog(self.home).cubes
                and info.get('hermes_cube') == row.get('_cube_id'))

    @staticmethod
    def quality_summary(plan):
        """Вернуть только счётчики плана, без содержимого воспоминаний."""
        items = plan['items']
        return {'facts_reviewed': len(items), 'rejected': sum(not i['accepted'] for i in items),
                'retained': sum(i['accepted'] for i in items),
                'rerouted': sum(i['accepted'] and set(i['memberships']) !=
                    {r['_cube_id'] for r in i['before']} for i in items),
                'ungrounded': sum(not i['grounded'] for i in items),
                'restored': sum(i['accepted'] and bool(i.get('restored_from')) for i in items),
                'changed': sum(not i['accepted'] or set(i['memberships']) != {r['_cube_id'] for r in i['before']}
                    or i['text'] != memory_text(i['before'][0]) for i in items)}

    def quality_apply(self, scope, plan_id, plan_sha, timeout=120):
        """Применить согласованный точный план под locks, сохраняя исходники и logical ID.

        Требует frozen профиль. Новые копии подтверждаются до удаления старых.
        План содержит исходные записи; журнал позволяет продолжить тот же переход.
        Никакие purge/handoff, epoch, SQL-права или bulk_clear_locked не меняются.
        """
        self.scope(scope)
        if not isinstance(plan_id, str) or uuid.UUID(plan_id).hex != plan_id:
            raise ValueError('Invalid quality plan ID')
        path = self.root / 'quality' / (plan_id + '.json')
        plan = json_file(path)
        if (stable_id(plan) != plan_sha or plan.get('version') != QUALITY_VERSION or plan.get('complete') is not True
                or plan.get('scope') != scope or plan.get('id') != plan_id
                or plan.get('home_scope') != stable_id(str(self.home.resolve()))):
            raise ValueError('Quality plan identity/digest mismatch')
        state_path = path.with_suffix('.progress.json')
        with file_lock(self.root / 'admin.lock', timeout), file_lock(self.root / 'delivery.lock', timeout), file_lock(self.root / 'submit.lock', timeout):
            self.scope(scope)
            config = self.config()
            if config.get('frozen') is not True or config['memory_epoch'] != plan['epoch']:
                raise ValueError('Quality apply requires frozen matching epoch')
            if config.get('bulk_clear_locked') is True:
                raise ValueError('Memory protection is locked; reviewed plan needs separate owner authorization for one-time application')
            if any((self.root / 'pending').glob('*.json')):
                raise ValueError('Drain pending deliveries before quality apply')
            state = json_file(state_path, {'plan_sha': plan_sha, 'items': {}})
            if state.get('plan_sha') != plan_sha:
                raise ValueError('Quality progress belongs to another plan')
            api = self.api or Client(config)
            def client(cube):
                if cube not in scope['managed_cubes']:
                    raise ValueError('Quality target cube is unmanaged')
                value = Client({**config, 'cube_id': cube}); value.request = api.request
                return value
            def save():
                atomic_json_write(state_path, state, mode=0o600, fsync_dir=True)
            # AIDEV-NOTE: Проверить весь исходный набор до первого изменения.
            current = {(cube, row['id']): row for cube in scope['managed_cubes'] for row in client(cube).get({})}
            seen = set()
            for item in plan['items']:
                logical = item['logical_id']
                if logical in seen or not item['before']:
                    raise ValueError('Invalid duplicate/empty quality item')
                if (not isinstance(item.get('text'), str) or not item['text'].strip()
                        or type(item.get('accepted')) is not bool
                        or item['accepted'] and (not item.get('grounded') or not item.get('memberships'))):
                    raise ValueError('Quality item lacks canonical text or grounded approval')
                seen.add(logical)
                for row in item['before']:
                    info = row.get('metadata', {}).get('info', {})
                    if (not self._quality_allowed(row, config) or info.get('hermes_kind') != 'fact'
                            or info.get('hermes_logical_id') != logical):
                        raise ValueError('Quality snapshot crosses memory scope')
                    actual = current.get((row['_cube_id'], row['id']))
                    started = logical in state['items']
                    if actual is not None and stable_id(actual) != stable_id(row):
                        raise ValueError('Quality snapshot changed; prepare a fresh plan')
                    if actual is None and not started:
                        raise ValueError('Quality snapshot missing before apply')
                if any(c not in scope['managed_cubes'] for c in item['memberships']):
                    raise ValueError('Quality membership is unmanaged')
            for item in plan['items']:
                logical = item['logical_id']
                progress = state['items'].setdefault(logical, {'units': {}, 'done': False})
                if progress['done']:
                    continue
                save()
                original = item['before'][0]
                info = original['metadata']['info']
                if (item['accepted'] and set(item['memberships']) == {r['_cube_id'] for r in item['before']}
                        and set(item['spheres']) == set(info.get('hermes_spheres', []))
                        and item['text'] == memory_text(original)):
                    progress['done'] = True
                    save()
                    continue
                kept = []
                if item['accepted']:
                    for cube in item['memberships']:
                        if cube not in progress['units']:
                            updated = {**info, **fact_fields(item['text']),
                                'hermes_event_id': stable_id([QUALITY_VERSION, logical, cube]),
                                'hermes_quality_version': QUALITY_VERSION, 'hermes_spheres': item['spheres'],
                                'hermes_cube': cube, 'hermes_primary_cube': item['memberships'][0],
                                'hermes_memberships': item['memberships']}
                            updated['hermes_payload_hash'] = stable_id({k:v for k,v in updated.items() if k != 'hermes_payload_hash'})
                            progress['units'][cube] = {'body': {'session_id': original['metadata']['session_id'],
                                'messages': [{'role': 'user', 'content': item['text']}], 'info': updated}}
                            save()
                        kept.extend(client(cube).execute(progress['units'][cube], lambda _: save()))
                for row in item['before']:
                    if row['id'] not in kept:
                        client(row['_cube_id']).delete([row['id']])
                progress['done'] = True
                save()
            # AIDEV-NOTE: Квитанции явного remember/повтора не должны ссылаться
            # на удалённые копии; исходный event ID при переклассификации сохраняется.
            by_event, facts_by_event = {}, {}
            for cube in scope['managed_cubes']:
                for row in client(cube).get({}):
                    if not self._quality_allowed(row, config):
                        continue
                    info = row['metadata']['info']
                    event = info.get('hermes_source_event') if info.get('hermes_kind') == 'fact' else info.get('hermes_event_id')
                    by_event.setdefault(event, set()).add(row['id'])
                    if info.get('hermes_kind') == 'fact':
                        facts_by_event.setdefault(event, set()).add(info['hermes_logical_id'])
            events = {item['before'][0]['metadata']['info'].get('hermes_source_event') for item in plan['items']}
            for event in events:
                if not isinstance(event, str) or len(event) != 64 or any(c not in '0123456789abcdef' for c in event):
                    raise ValueError('Invalid source event in quality plan')
                receipt_path = self.root / 'receipts' / (event + '.json')
                receipt = json_file(receipt_path)
                if receipt:
                    if receipt.get('event_id') != event:
                        raise ValueError('Source receipt identity changed')
                    receipt.update(memory_ids=sorted(by_event.get(event, set())), fact_count=len(facts_by_event.get(event, set())),
                                   quality_version=QUALITY_VERSION, quality_plan_id=plan_id)
                    atomic_json_write(receipt_path, receipt, mode=0o600, fsync_dir=True)
            state['complete'] = True
            save()
        return self.quality_summary(plan) | {'complete': True, 'plan_id': plan_id}

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

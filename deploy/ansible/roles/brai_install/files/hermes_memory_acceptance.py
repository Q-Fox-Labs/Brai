# ABOUTME: Проверяет настоящую native MemOS запись, restart, replay и точную уборку.
# ABOUTME: Всегда замораживает writer; proof создаёт лишь после полного успешного цикла.
"""Однократная bounded приёмка после own auth; пользовательский gateway выключен."""
import argparse
import importlib
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import sys
import time
import types
import urllib.request

import native_hermes
memos = None
SPEC = None

RUN_STATE = Path('/etc/brai/hermes/memos/functional-run.json')
THIS = Path(__file__).resolve()
SYNTHETIC_PREFIX = 'Синтетический технический маркер приёмки моей памяти: '


def require(value):
    """Не раскрывать IDs, память и ответы моделей через сообщения ошибок."""
    memos.require(value, 'HERMES_MEMOS_FUNCTIONAL_CHECK_FAILED')


def native_provider():
    """Загрузить именно installed native plugin, без второго memory provider."""
    from plugins.memory import load_memory_provider
    provider = load_memory_provider('memos-rest', register_skills=False)
    require(provider is not None)
    package = '_brai_memos_acceptance_native'
    namespace = types.ModuleType(package)
    namespace.__path__ = [str(memos.PROFILE / 'plugins/memos-rest')]
    sys.modules[package] = namespace
    admin = importlib.import_module(package + '.admin')
    router = importlib.import_module(package + '.router')
    client = importlib.import_module(package + '.client')
    return provider, admin.Admin(memos.PROFILE), router.Catalog(memos.PROFILE), client.Client


def native_receipt(event_id, wait=0):
    """Прочитать только native verified receipt; writer принадлежит native provider."""
    require(isinstance(event_id, str) and len(event_id) == 64
            and all(ch in '0123456789abcdef' for ch in event_id))
    path = memos.RECEIPTS / (event_id + '.json')
    deadline = time.monotonic() + wait
    identity = memos.account()
    while True:
        if path.exists() or path.is_symlink():
            receipt = memos.protected_json(path, identity.pw_uid, identity.pw_gid)
            if not (memos.PENDING / (event_id + '.json')).exists():
                return receipt
        require(time.monotonic() < deadline)
        time.sleep(.2)


def scoped_rows(config, catalog, client):
    """Прочитать все managed cubes только configured owner через native Client."""
    return [(cube, row) for cube in catalog.cubes
            for row in client({**config, 'cube_id': cube}).get({})]


def check_created(rows, run):
    """Разрешить уборку только точных ID с session/event/epoch/home/author provenance."""
    from hashlib import sha256
    home_scope = sha256(json.dumps(str(memos.PROFILE.resolve()), ensure_ascii=False,
                                  sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(0 < len(run['memory_ids']) <= 32 and len(run['memory_ids']) == len(set(run['memory_ids'])))
    require({row['id'] for _, row in rows} == set(run['memory_ids']) and len(rows) == len(run['memory_ids']))
    for _, row in rows:
        meta = row.get('metadata', {})
        info = meta.get('info', {})
        require(meta.get('user_id') == run['ownerId'] and meta.get('session_id') == run['session']
                and info.get('hermes_memory_epoch') == run['memoryEpoch']
                and info.get('hermes_home_scope') == home_scope
                and info.get('hermes_author_id') == run['ownerId']
                and (info.get('hermes_event_id') == run['event_id']
                     or info.get('hermes_source_event') == run['event_id']))


def native_worker(stage, run):
    """Выполнить одну стадию в отдельном installed Python процессе runtime owner."""
    provider, admin, catalog, client = native_provider()
    config = admin.config()
    require(config['user_id'] == run['ownerId'] and config.get('scope_profile') == memos.SCOPE_PROFILE
            and config.get('bulk_clear_locked') is True)
    scope = {'profile': memos.SCOPE_PROFILE, 'user_id': config['user_id'], 'managed_cubes': catalog.cubes}
    if stage == 'handoff':
        admin.handoff_empty(scope, run['memoryEpoch'], timeout=120)
        require(admin.config()['memory_epoch'] == run['memoryEpoch'])
        return {'handoff': True}
    require(config['memory_epoch'] == run['memoryEpoch'] and config['deployment_phase'] == 'production')
    if stage == 'cleanup':
        require(config.get('frozen') is True)
        rows = scoped_rows(config, catalog, client)
        check_created(rows, run)
        for cube in catalog.cubes:
            ids = [row['id'] for row_cube, row in rows if row_cube == cube]
            if ids:
                client({**config, 'cube_id': cube}).delete(ids)
        require(not scoped_rows(config, catalog, client))
        return {'cleanup': True}
    admin.resume(scope)
    try:
        provider.initialize(run['session'], hermes_home=str(memos.PROFILE), user_id=run['ownerId'],
                            platform='cli', agent_context='primary')
        args = {'content': run['content'], 'operation_id': run['operation_id']}
        if stage == 'read-replay':
            before = scoped_rows(config, catalog, client)
            check_created(before, run)
            before_receipt = native_receipt(run['event_id'])
            for memory_id in run['memory_ids']:
                result = json.loads(provider.handle_tool_call('memos_read', {'memory_id': memory_id,
                                                'include_transcript': True}))
                require(result.get('status') == 'ok' and result.get('transcript'))
                require(any(run['nonce'] in row.get('content', '') for row in result['transcript']))
        result = json.loads(provider.handle_tool_call('memos_remember', args))
        event = result.get('event_id')
        require(isinstance(event, str) and bool(event))
        receipt = native_receipt(event, wait=60)
        require(receipt.get('fact_count') == 1 and receipt.get('epoch') == run['memoryEpoch']
                and receipt.get('event_id') == event and receipt.get('verified_at'))
        ids = receipt.get('memory_ids')
        require(isinstance(ids, list) and 0 < len(ids) <= 32)
        current = {**run, 'event_id': event, 'memory_ids': ids}
        rows = scoped_rows(config, catalog, client)
        check_created(rows, current)
        for memory_id in ids:
            result = json.loads(provider.handle_tool_call('memos_read', {'memory_id': memory_id,
                                            'include_transcript': True}))
            require(result.get('status') == 'ok' and any(current['nonce'] in row.get('content', '')
                                                      for row in result.get('transcript', [])))
        require(not any(memos.PENDING.glob('*.json'))
                and len(list(memos.RECEIPTS.glob('*.json'))) == 1)
        if stage == 'read-replay':
            require(event == run['event_id'] and ids == run['memory_ids'] and receipt == before_receipt
                    and {row['id'] for _, row in rows} == {row['id'] for _, row in before})
        return {'event_id': event, 'memory_ids': ids, 'nativeReceipt': True, 'read': True}
    finally:
        # AIDEV-NOTE: Сначала fence/freeze и ожидание delivery lock, затем остановка writer.
        try:
            admin.freeze(scope, timeout=120)
        finally:
            provider.shutdown()


def own_environment():
    """Проверить installed single-auth proof, затем выбрать собственный native venv."""
    identity = memos.account()
    environment = dict(native_hermes.environment(SPEC), PYTHONPATH=SPEC['software']['core'],
                       BRAI_HERMES_NATIVE_DESCRIPTOR_JSON=json.dumps(SPEC))
    return Path(native_hermes.python_runtime(SPEC)), environment, identity


def call_worker(stage, run, runtime):
    """Вызвать bounded child; никогда не печатать его память, IDs или stderr."""
    interpreter, environment, identity = runtime
    result = subprocess.run([str(interpreter), str(THIS), '--worker', stage],
                            input=json.dumps(run), text=True, capture_output=True, timeout=300,
                            env=environment, user=identity.pw_uid, group=identity.pw_gid, extra_groups=[])
    require(result.returncode == 0)
    result = json.loads(result.stdout)
    require(isinstance(result, dict))
    return result


def restart_memos():
    """Перезапустить только MemOS container service, не gateway/DB/bridge/models."""
    result = subprocess.run(['/usr/bin/systemctl', 'restart', 'brai-hermes-production-memos.service'],
                            text=True, capture_output=True, timeout=90)
    require(result.returncode == 0)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with opener.open('http://127.0.0.1:19371/openapi.json', timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError('HERMES_MEMOS_RESTART_HEALTH_FAILED')


def freeze_profile():
    """Безусловно оставить штатный profile disabled/frozen при любом исходе child."""
    identity = memos.account()
    profile = memos.profile_state(identity.pw_uid, identity.pw_gid)
    profile.update(enabled=False, frozen=True)
    memos.write_profile(memos.PROFILE_CONFIG, profile, identity.pw_uid, identity.pw_gid)


def _accept():
    """Один synthetic write→read→restart→read/replay→exact cleanup; без auto retry."""
    require(os.geteuid() == 0)
    require(native_hermes.run(['/usr/bin/systemctl','is-active','--quiet','brai-hermes-production.service'], optional=True).returncode != 0)
    memos.verify()
    runtime = own_environment()
    identity = runtime[2]
    require(not any(memos.PENDING.iterdir()) and not any(memos.RECEIPTS.iterdir()))
    for path in (RUN_STATE, memos.ACCEPTANCE):
        require(not path.exists() and not path.is_symlink())
    profile = memos.profile_state(identity.pw_uid, identity.pw_gid)
    require(profile.get('enabled') is False and profile.get('frozen') is True)
    nonce = secrets.token_hex(16)
    run = {'ownerId': profile['user_id'], 'memoryEpoch': 'production-' + secrets.token_hex(16),
           'nonce': nonce, 'operation_id': 'accept-' + secrets.token_hex(16),
           'session': 'accept-' + secrets.token_hex(16),
           'content': SYNTHETIC_PREFIX + nonce + '.',
           'status': 'started'}
    memos.write_once(RUN_STATE, json.dumps(run) + '\n')
    return complete_run(run, runtime, handoff=True)


def complete_run(run, runtime, *, handoff=False):
    """Общий bounded tail; всегда frozen, proof лишь после read/restart/replay/точной уборки."""
    try:
        if handoff:
            require(call_worker('handoff', run, runtime).get('handoff') is True)
        written = call_worker('write', run, runtime)
        require(written.get('nativeReceipt') is True and written.get('read') is True)
        if not handoff:
            require(written.get('event_id') == run['event_id'])
        run.update(written, status='written')
        memos.write_profile(RUN_STATE, run, 0, 0)
        restart_memos()
        replayed = call_worker('read-replay', run, runtime)
        require(replayed == written)
        require(call_worker('cleanup', run, runtime).get('cleanup') is True)
        run['status'] = 'complete'
        memos.write_profile(RUN_STATE, run, 0, 0)
    finally:
        freeze_profile()
    evidence = {'ownerId': run['ownerId'], 'memoryEpoch': run['memoryEpoch'],
                'memosRevision': memos.MEMOS_REVISION, 'customRevision': memos.CUSTOM_REVISION, 'passed': True}
    memos.write_once(memos.ACCEPTANCE, json.dumps(evidence) + '\n')
    memos.acceptance(run['ownerId'], run['memoryEpoch'])
    return {'passed': True, 'frozen': True, 'syntheticRowsRemoved': True,
            'nativeOutboxVerified': True, 'restart': 'memos-only'}


def configure(spec):
    """Подключить production descriptor к существующему native acceptance lifecycle."""
    global SPEC, memos
    SPEC = native_hermes.validate(spec)
    memos = native_hermes.memory(SPEC)


def accept(spec):
    """Принять память только по реальной native write/read/restart/replay/cleanup."""
    configure(spec)
    return _accept()


if __name__ == '__main__':
    try:
        configure(json.loads(os.environ['BRAI_HERMES_NATIVE_DESCRIPTOR_JSON']))
        require(os.geteuid() == memos.account().pw_uid)
        require(len(sys.argv) == 3 and sys.argv[1] == '--worker'
                and sys.argv[2] in ['handoff','write','read-replay','cleanup'])
        print(json.dumps(native_worker(sys.argv[2], json.load(sys.stdin))))
    except Exception:
        print('HERMES_MEMOS_FUNCTIONAL_CHECK_FAILED', file=sys.stderr)
        raise SystemExit(1)

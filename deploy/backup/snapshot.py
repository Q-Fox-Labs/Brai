#!/usr/bin/python3
# ABOUTME: Удерживает штатный ingress/worker drain Brai и останавливает объявленных писателей снимка.
# ABOUTME: Возвращает только свои изменения по durable journal; пользовательскую паузу не использует.
import argparse
import json
import os
import re
import socket
import stat
import struct
import sys
import time
from common import js, run, write_json
from recovery import CONFIG, ROOT, absolute, protected, require


def rpc(path, method, operation, ingress_uid):
    """Вызвать native ingress control с проверкой закреплённого ingress UID и совпадения JSON-RPC ID."""
    require(type(ingress_uid) is int and ingress_uid >= 0, 'RECOVERY_INGRESS_UID_INVALID')
    path = absolute(path)
    info = path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == ingress_uid and not info.st_mode & 0o077, 'RECOVERY_INGRESS_SOCKET_UNTRUSTED')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o002, 'RECOVERY_INGRESS_PARENT_UNTRUSTED')
        if info.st_mode & 0o020:
            require(parent == path.parent, 'RECOVERY_INGRESS_PARENT_UNTRUSTED')
            acl = os.getxattr(parent, 'system.posix_acl_access')
            require(len(acl) >= 4 and struct.unpack_from('<I', acl)[0] == 2 and (len(acl) - 4) % 8 == 0, 'RECOVERY_INGRESS_ACL_UNTRUSTED')
            entries = {struct.unpack_from('<HHI', acl, offset) for offset in range(4, len(acl), 8)}
            require(entries == {(1,7,4294967295),(2,7,ingress_uid),(4,0,4294967295),(16,7,4294967295),(32,0,4294967295)}, 'RECOVERY_INGRESS_ACL_UNTRUSTED')
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(path))
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(uid == ingress_uid, 'RECOVERY_INGRESS_PEER_CHANGED')
        connection.sendall(json.dumps({'jsonrpc': '2.0', 'id': operation, 'method': method, 'params': {'operationId': operation}}).encode() + b'\n')
        with connection.makefile('rb') as stream:
            response = json.loads(stream.readline())
    require(response.get('jsonrpc') == '2.0' and response.get('id') == operation and 'error' not in response, 'RECOVERY_INGRESS_REJECTED')
    result = response['result']
    require(result.get('operationId') == operation, 'RECOVERY_INGRESS_OPERATION_CHANGED')
    return result


def unit_state(unit):
    """Прочитать реальное ActiveState службы или таймера."""
    return run(['systemctl', 'show', unit, '--property=ActiveState', '--value']).decode().strip()


def enter(value, operation):
    """Дождаться native ready, затем остановить только явно объявленных активных писателей."""
    journal = ROOT / 'adapter-journal.json'
    require(not journal.exists(), 'RECOVERY_ADAPTER_RESUME_REQUIRED')
    policy = value['snapshot']
    units, containers = policy['units'], policy['containers']
    require(not {'brai-client-backup.service', 'brai-client-backup.timer'}.intersection(units), 'RECOVERY_SELF_STOP_FORBIDDEN')
    require(len(set(units)) == len(units) and all(re.fullmatch(r'[A-Za-z0-9_.@-]+\.(service|timer)', name) for name in units), 'RECOVERY_WRITER_UNITS_INVALID')
    require(len(set(containers)) == len(containers) and all(re.fullmatch(r'[A-Za-z0-9_.-]+', name) for name in containers), 'RECOVERY_WRITER_CONTAINERS_INVALID')
    databases = {c['container'] for component in value['components'].values() for c in component.get('postgres', [])}
    require(not databases.intersection(containers), 'RECOVERY_DATABASE_STOP_FORBIDDEN')
    for unit in units:
        for prop in ('RequiredBy', 'BoundBy'):
            dependents = set(run(['systemctl', 'show', unit, '--property=' + prop, '--value']).decode().split())
            require(dependents.issubset(set(units)), 'RECOVERY_STOP_HAS_EXTERNAL_DEPENDENTS')
        require(unit_state(unit) in ('active', 'inactive', 'failed'), 'RECOVERY_WRITER_TRANSITIONING')
    state = {'operation_id': operation, 'ingress_socket': policy['ingress_socket'], 'ingress_uid': policy['ingress_uid'], 'resume': [], 'native': True}
    write_json(journal, state)
    result = rpc(policy['ingress_socket'], 'release.begin', operation, policy['ingress_uid'])
    while result.get('state') != 'ready':
        require(result.get('state') == 'draining', 'RECOVERY_NATIVE_DRAIN_BLOCKED')
        time.sleep(0.5)
        result = rpc(policy['ingress_socket'], 'release.status', operation, policy['ingress_uid'])
    for unit in units:
        if unit_state(unit) == 'active':
            state['resume'].append({'kind': 'unit', 'name': unit})
            write_json(journal, state)
            run(['systemctl', 'stop', unit])
            require(unit_state(unit) in ('inactive', 'failed'), 'RECOVERY_WRITER_STILL_ACTIVE')
    for name in containers:
        found = json.loads(run(['docker', 'inspect', name]))[0]['State']
        require(found['Status'] in ('running', 'paused', 'exited', 'created'), 'RECOVERY_WRITER_TRANSITIONING')
        if found['Running'] and not found.get('Paused'):
            state['resume'].append({'kind': 'container', 'name': name})
            write_json(journal, state)
            # Docker -1 означает штатное ожидание без последующего SIGKILL.
            run(['docker', 'stop', '-t', '-1', name])
            require(not json.loads(run(['docker', 'inspect', name]))[0]['State']['Running'], 'RECOVERY_WRITER_STILL_ACTIVE')
    return {'operation_id': operation, 'state': 'quiesced'}


def leave(operation):
    """Идемпотентно вернуть исходно активных писателей и снять собственный native hold."""
    journal = ROOT / 'adapter-journal.json'
    if not journal.exists():
        return {'operation_id': operation, 'state': 'resumed'}
    protected(journal)
    state = js(journal)
    require(state['operation_id'] == operation, 'RECOVERY_ADAPTER_OPERATION_CHANGED')
    for action in reversed(state['resume'][:]):
        if action['kind'] == 'unit':
            # Повтор stop завершает также неизвестный исход прерванной команды перед start.
            run(['systemctl', 'stop', action['name']])
            require(unit_state(action['name']) in ('inactive', 'failed'), 'RECOVERY_WRITER_STOP_UNCONFIRMED')
            run(['systemctl', 'start', action['name']])
            require(unit_state(action['name']) == 'active', 'RECOVERY_WRITER_START_UNCONFIRMED')
        else:
            found = json.loads(run(['docker', 'inspect', action['name']]))[0]['State']
            require(not found.get('Paused'), 'RECOVERY_WRITER_PAUSE_CHANGED')
            run(['docker', 'stop', '-t', '-1', action['name']])
            require(not json.loads(run(['docker', 'inspect', action['name']]))[0]['State']['Running'],
                    'RECOVERY_WRITER_STOP_UNCONFIRMED')
            run(['docker', 'start', action['name']])
            require(json.loads(run(['docker', 'inspect', action['name']]))[0]['State']['Running'],
                    'RECOVERY_WRITER_START_UNCONFIRMED')
        state['resume'].remove(action)
        write_json(journal, state)
    if state['native']:
        result = rpc(state['ingress_socket'], 'release.resume', operation, state['ingress_uid'])
        require(result.get('state') == 'resumed', 'RECOVERY_NATIVE_RESUME_UNCONFIRMED')
    journal.unlink()
    return {'operation_id': operation, 'state': 'resumed'}


def main():
    """Обработать только свой operation ID из root-only системного job."""
    global CONFIG, ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['enter', 'leave'])
    parser.add_argument('--operation-id', required=True)
    parser.add_argument('--config', type=__import__('pathlib').Path, default=CONFIG)
    parser.add_argument('--state', type=__import__('pathlib').Path, default=ROOT)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'RECOVERY_ROOT_REQUIRED')
    require(re.fullmatch(r'[0-9a-f]{32}', args.operation_id), 'RECOVERY_OPERATION_INVALID')
    CONFIG, ROOT = absolute(str(args.config)), absolute(str(args.state))
    protected(ROOT, directory=True)
    os.umask(0o077)
    if args.action == 'enter':
        protected(CONFIG)
        result = enter(js(CONFIG), args.operation_id)
    else:
        result = leave(args.operation_id)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print('RECOVERY_SNAPSHOT_FAILED', file=sys.stderr)
        raise SystemExit(1)

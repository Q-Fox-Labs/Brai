# ABOUTME: Проверяет полный сбор/шифрование/скачивание/восстановление на настоящих PostgreSQL и Duplicati.
# ABOUTME: Использует только собственные помеченные контейнеры без сети и временные фиктивные данные в /run.
import json
import os
from pathlib import Path
import shutil
import sqlite3
import socket
import threading
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

PROGRAM = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROGRAM))
import recovery
from common import Failure, run
from postgres_store import command, isolated_verify

PG = os.environ.get('BRAI_BACKUP_TEST_POSTGRES_IMAGE', '')
DUPLICATI = 'duplicati/duplicati@sha256:e32e280cc30e98ac5cea8d2b339cd19810b1b39e638fb9d39253786630104de0'


@unittest.skipUnless(os.environ.get('BRAI_BACKUP_NATIVE') == '1', 'explicit isolated acceptance only')
class NativeBackup(unittest.TestCase):
    """Испытание не использует рабочие volumes, порты, Google или настоящие профили."""

    def setUp(self):
        self.assertEqual(os.geteuid(), 0, 'native acceptance requires root for isolated Docker')
        self.assertTrue(PG and '@sha256:' in PG, 'explicit pinned PostgreSQL image required')
        self.identity = uuid.uuid4().hex
        self.temp = tempfile.TemporaryDirectory(prefix='brai-backup-acceptance-', dir='/run')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.base.chmod(0o700)
        self.stage = self.base / 'staging'
        self.stage.mkdir(mode=0o700)
        self.source = self.base / 'source'
        self.source.mkdir(mode=0o700)
        self.profiles, self.artifacts, self.shared = [self.source / name for name in ('profiles', 'artifacts', 'shared')]
        for root in (self.profiles, self.artifacts, self.shared):
            root.mkdir(mode=0o700)
        home = self.profiles / 'person/usercustom/new-project'
        home.mkdir(parents=True)
        self.document = home / 'document.bin'
        self.document.write_bytes(b'exact binary\0\xff: ' + 'уникальный файл'.encode())
        self.document.chmod(0o640)
        os.setxattr(self.document, 'user.fixture', b'exact attributes')
        os.link(self.document, home / 'hardlink.bin')
        (home / 'relative-link').symlink_to('document.bin')
        (home / 'manifest.json').write_text('legitimate user filename')
        os.chown(home, 42042, 42042)
        home.chmod(0o700)
        os.chown(self.document, 42042, 42042)
        (self.artifacts / 'artifact-original.bin').write_bytes(b'artifact original\0\xfe')
        (self.shared / 'signing-key').write_text('SYNTHETIC-NOT-A-REAL-KEY')
        with sqlite3.connect(self.profiles / 'person/state.sqlite') as db:
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT, raw BLOB)')
            db.execute('INSERT INTO messages VALUES(1,?,?)', ('before\0after', b'\0\xff'))
            db.execute('CREATE VIRTUAL TABLE search USING fts5(body)')
            db.execute("INSERT INTO search VALUES ('уникальная память')")
        self.container = 'brai-backup-fixture-' + self.identity
        run(['docker', 'run', '-d', '--pull=never', '--name', self.container,
             '--label', 'brai.backup.fixture=' + self.identity, '--network=none', '--read-only',
             '--tmpfs', '/tmp:rw,exec', '--user', 'postgres', '--entrypoint', '/bin/sh', PG, '-c',
             'initdb -D /tmp/pgdata -U postgres --auth-local=trust --auth-host=reject >/dev/null && '
             'exec postgres -D /tmp/pgdata -c listen_addresses= -c unix_socket_directories=/tmp'])
        self.addCleanup(self.remove_container)
        self.worker = 'brai-backup-writer-' + self.identity
        run(['docker', 'run', '-d', '--pull=never', '--name', self.worker, '--network=none',
             '--read-only', '--user', 'postgres', '--label', 'brai.backup.fixture=' + self.identity,
             '--entrypoint', '/bin/sh', PG, '-c', 'trap "exit 0" TERM INT; sleep infinity & wait'])
        self.addCleanup(self.remove_worker)
        while run(command(self.container, 'postgres', 'pg_isready', '-d', 'postgres'), check=False):
            self.assertTrue(json.loads(run(['docker', 'inspect', self.container]))[0]['State']['Running'])
            time.sleep(0.2)
        self.sql('postgres', 'CREATE DATABASE original;')
        self.sql('postgres', "ALTER SYSTEM SET application_name='synthetic-unique-server-setting';")
        self.sql('original', "ALTER ROLE postgres IN DATABASE original SET timezone TO 'UTC';")
        self.sql('original', """CREATE EXTENSION vector;
            CREATE TABLE notes(id bigserial PRIMARY KEY, body text, embedding vector(3), raw bytea, metadata jsonb);
            INSERT INTO notes(body,embedding,raw,metadata) VALUES
            ('original memory','[0.125,0.25,0.5]',decode('00ff','hex'),'{"source":"exact"}');
            CREATE TABLE receipts(id text PRIMARY KEY, acknowledged boolean);
            INSERT INTO receipts VALUES('completed-operation',true);""")
        self.installed = self.base / 'installed.json'
        self.installed.write_text(json.dumps({'installed': {'client': {'profiles': {}, 'artifacts': {}, 'shared': {}, 'database': {}, 'worker': {}}},
                                              'source_revisions': {'brai': 'a' * 40}}))
        self.installed.chmod(0o600)
        programs = self.base / 'programs'
        programs.mkdir(mode=0o700)
        for code in PROGRAM.glob('*.py'):
            shutil.copyfile(code, programs / code.name)
            (programs / code.name).chmod(0o600)
        control = self.base / 'ingress.sock'
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(control))
        control.chmod(0o600)
        server.listen()
        def ingress():
            with server:
                while True:
                    connection, _ = server.accept()
                    with connection:
                        request = json.loads(connection.makefile('rb').readline())
                        if request.get('stop'):
                            break
                        operation = request['params']['operationId']
                        state = 'resumed' if request['method'] == 'release.resume' else 'ready'
                        connection.sendall(json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                            'result': {'operationId': operation, 'state': state}}).encode() + b'\n')
        thread = threading.Thread(target=ingress, daemon=True)
        thread.start()
        def stop_ingress():
            with socket.socket(socket.AF_UNIX) as connection:
                connection.connect(str(control))
                connection.sendall(b'{"stop":true}\n')
            thread.join()
        self.addCleanup(stop_ingress)
        config = self.base / 'plan.json'
        self.plan = {
            'format': 'brai-client-backup-plan-v1', 'environment': 'client',
            'installation_manifest': str(self.installed),
            'installer': {'repository': 'https://example.invalid/installer', 'revision': 'b' * 40,
                          'entrypoint': 'ansible/client/install.yml'},
            'components': {
                'profiles': {'roots': [str(self.profiles)]}, 'artifacts': {'roots': [str(self.artifacts)]},
                'shared': {'roots': [str(self.shared)]}, 'worker': {'rebuild': 'synthetic stateless writer'},
                'database': {'postgres': [{
                    'container': self.container, 'user': 'postgres', 'database': 'postgres',
                    'data_mounts': ['/tmp'], 'dedicated': True, 'socket': '/tmp'}]}},
            'docker_scope': ['brai.backup.fixture=' + self.identity],
            'systemd_scope': ['brai-fixture-' + self.identity + '-*.service'],
            'snapshot': {'enter': ['/usr/bin/python3', '-B', str(programs / 'snapshot.py'), 'enter',
                                   '--config', str(config), '--state', str(self.stage)],
                         'leave': ['/usr/bin/python3', '-B', str(programs / 'snapshot.py'), 'leave',
                                   '--config', str(config), '--state', str(self.stage)],
                         'units': [], 'containers': [self.worker],
                         'ingress_socket': str(control), 'ingress_uid': 0},
            'destination': 'file://' + str(self.base / 'remote'),
            'duplicati': {'image': DUPLICATI}}
        config = self.base / 'plan.json'
        config.write_text(json.dumps(self.plan))
        config.chmod(0o600)
        key = self.base / 'passphrase'
        key.write_text('SYNTHETIC-ACCEPTANCE-PASSPHRASE')
        key.chmod(0o600)
        for name, value in [('ROOT', self.stage), ('STATUS', self.stage / 'status.json'),
                            ('CONFIG', config), ('KEY', key)]:
            mock = patch.object(recovery, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def remove_container(self):
        """Удалить только свой контейнер с проверкой уникальной метки."""
        if run(['docker', 'inspect', self.container], check=False) == 0:
            state = json.loads(run(['docker', 'inspect', self.container]))[0]
            self.assertEqual(state['Config']['Labels']['brai.backup.fixture'], self.identity)
            self.assertEqual(state['HostConfig']['NetworkMode'], 'none')
            self.assertTrue(all(item['Type'] == 'tmpfs' for item in state['Mounts']))
            run(['docker', 'rm', '-f', self.container])

    def remove_worker(self):
        """Удалить только собственный stateless writer без сети и рабочих volumes."""
        if run(['docker', 'inspect', self.worker], check=False) == 0:
            found = json.loads(run(['docker', 'inspect', self.worker]))[0]
            self.assertEqual(found['Config']['Labels']['brai.backup.fixture'], self.identity)
            self.assertFalse(found['Mounts'])
            run(['docker', 'rm', '-f', self.worker])

    def sql(self, database, statement):
        """Исполнить SQL только в собственном изолированном источнике."""
        return run(command(self.container, 'postgres', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
                           '-d', database, '-c', statement))

    def test_collect_two_generations_and_cold_restore_all_state(self):
        first = recovery.upload(self.plan)
        self.assertEqual(first['stage'], 'verified')
        self.assertTrue(json.loads(run(['docker', 'inspect', self.worker]))[0]['State']['Running'])
        self.assertFalse(first['cloud_verified'], 'local file backend must not claim Google verification')
        self.sql('postgres', 'CREATE DATABASE future_project;')
        self.sql('future_project', """CREATE TABLE future(id bigserial PRIMARY KEY, raw bytea, settings jsonb);
            ALTER TABLE future ADD COLUMN future_column text;
            INSERT INTO future(raw,settings,future_column) VALUES(decode('00ff','hex'),'{"new":true}','new column');""")
        new_file = self.profiles / 'future-person/usercustom/future-dir/new.txt'
        new_file.parent.mkdir(parents=True)
        new_file.write_text('new user after first backup')
        # Не меняем план: новая БД, таблица, колонка, пользователь и папка обнаруживаются сами.
        second = recovery.upload(self.plan)
        self.assertNotEqual(first['bundle_id'], second['bundle_id'])
        bundle = (self.stage / 'current').resolve()
        manifest = recovery.check_bundle(bundle)
        self.assertIn('future_project', manifest['postgres'][self.container]['databases'])
        self.assertTrue(any('synthetic-unique-server-setting' in (bundle / 'postgres' / self.container / path).read_text()
                            for path in manifest['postgres'][self.container]['configuration_files'].values()))
        self.assertIn('public.future', manifest['postgres'][self.container]['fingerprints']['future_project']['tables'])
        self.assertEqual(json.loads((self.stage / 'last-verified.json').read_text())['bundle_id'], second['bundle_id'])
        self.assertTrue(any(path.name.endswith('.aes') for path in (self.base / 'remote').iterdir()))
        # Уничтожаем только свою исходную среду и локальные каталоги: остаётся encrypted remote.
        original_document = self.document.read_bytes()
        self.remove_container()
        self.remove_worker()
        shutil.rmtree(self.source)
        (self.stage / 'current').unlink()
        for previous in self.stage.glob('build-*'):
            shutil.rmtree(previous)
        shutil.rmtree(self.stage / 'duplicati')
        bundle = recovery.fetch(self.plan, self.stage, recovery.credentials(self.plan))
        self.assertEqual(recovery.check_bundle(bundle)['bundle_id'], second['bundle_id'])
        isolated_verify(bundle, manifest)
        earlier = recovery.fetch(self.plan, self.stage, recovery.credentials(self.plan), version=1)
        self.assertEqual(recovery.check_bundle(earlier)['bundle_id'], first['bundle_id'])
        target = self.base / 'fresh-root'
        recovery.restore(bundle, target)
        restored = target / str(self.document).lstrip('/')
        self.assertEqual(restored.read_bytes(), original_document)
        self.assertEqual(restored.stat().st_mode & 0o777, 0o640)
        self.assertEqual(restored.stat().st_uid, 42042)
        self.assertEqual(restored.parent.stat().st_uid, 42042)
        self.assertEqual(restored.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(os.getxattr(restored, 'user.fixture'), b'exact attributes')
        self.assertEqual(restored.stat().st_ino, (restored.parent / 'hardlink.bin').stat().st_ino)
        self.assertEqual(os.readlink(restored.parent / 'relative-link'), 'document.bin')
        self.assertEqual((target / str(new_file).lstrip('/')).read_text(), 'new user after first backup')
        with sqlite3.connect(target / str(self.profiles / 'person/state.sqlite').lstrip('/')) as db:
            self.assertEqual(db.execute('SELECT body,raw FROM messages').fetchone(), ('before\0after', b'\0\xff'))
            self.assertEqual(db.execute("SELECT body FROM search WHERE search MATCH 'память'").fetchone()[0],
                             'уникальная память')


if __name__ == '__main__':
    unittest.main(verbosity=2)

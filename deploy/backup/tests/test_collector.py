# ABOUTME: Проверяет включение будущих данных, штатный SQLite и отказ неполного снимка.
# ABOUTME: Реальны файловые операции и SQLite; Docker/согласование подменены только в unit-проверках.
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

PROGRAM = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROGRAM))
import recovery
import duplicati
from common import Failure, digest, write_json


class CollectorTests(unittest.TestCase):
    """Синтетические данные не требуют root, контейнеров или подключения облака."""

    def setUp(self):
        temporary = PROGRAM.parents[1] / 'tmp'
        temporary.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temporary, prefix='backup-unit-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / 'profiles'
        self.state.mkdir()
        self.staging = self.base / 'staging'
        self.staging.mkdir()
        self.installed = self.base / 'installed.json'
        self.installed.write_text(json.dumps({'installed': {'client': {'fixture': {}}},
                                              'source_revisions': {'brai': 'a' * 40}}))
        self.plan = {
            'format': 'brai-client-backup-plan-v1', 'environment': 'client',
            'installation_manifest': str(self.installed),
            'installer': {'repository': 'https://example.invalid/installer', 'revision': 'b' * 40,
                          'entrypoint': 'ansible/client/install.yml'},
            'components': {'fixture': {'roots': [str(self.state)]}},
            'docker_scope': ['brai.test=unit'], 'systemd_scope': ['brai-fixture-*.service'],
            'snapshot': {'enter': ['/usr/bin/true'], 'leave': ['/usr/bin/false'],
                         'units': [], 'containers': []}}
        for name, value in [('ROOT', self.staging), ('STATUS', self.base / 'status.json'),
                            ('KEY', self.base / 'passphrase')]:
            mock = patch.object(recovery, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.object(recovery, 'protected')
        mock.start()
        self.addCleanup(mock.stop)
        mock = patch.object(recovery, 'isolated_verify', return_value={})
        mock.start()
        self.addCleanup(mock.stop)
        native = recovery.run
        self.calls = []

        def commands(argv, **kwargs):
            self.calls.append(argv)
            if argv[:3] == ['docker', 'ps', '-aq']:
                return b''
            if argv[:2] == ['systemctl', 'list-unit-files']:
                return b''
            if argv[0] in ('/usr/bin/true', '/usr/bin/false'):
                return json.dumps({'operation_id': argv[-1],
                                   'state': 'quiesced' if argv[0].endswith('true') else 'resumed'}).encode()
            return native(argv, **kwargs)
        self.commands = commands
        mock = patch.object(recovery, 'run', side_effect=commands)
        mock.start()
        self.addCleanup(mock.stop)

    def restored_path(self, target, path):
        """Найти исходный абсолютный путь внутри пустого restore root."""
        return target / str(path).lstrip('/')

    def test_native_sqlite_preserves_wal_nul_blobs_future_columns_and_fts(self):
        path = self.state / 'state.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, raw BLOB)')
            db.execute('ALTER TABLE notes ADD COLUMN future TEXT')
            row = ('before\0after', b'\0\xffbinary', '{"future":true}')
            db.execute('INSERT INTO notes(body,raw,future) VALUES(?,?,?)', row)
            db.execute('CREATE VIRTUAL TABLE search USING fts5(body)')
            db.execute("INSERT INTO search(body) VALUES ('Уникальный документ')")
            db.commit()
            db.execute("INSERT INTO notes(body) VALUES ('uncommitted')")
            manifest = recovery.prepare(self.plan)
            target = self.base / 'restored'
            recovery.restore(self.staging / 'current', target)
            restored = self.restored_path(target, path)
            with sqlite3.connect(restored) as actual:
                self.assertEqual(actual.execute('SELECT body,raw,future FROM notes').fetchall(), [row])
                self.assertEqual(actual.execute("SELECT body FROM search WHERE search MATCH 'Уникальный'").fetchone()[0],
                                 'Уникальный документ')
                actual.execute("INSERT INTO notes(body) VALUES ('after restore')")
                self.assertEqual(actual.execute('SELECT max(id) FROM notes').fetchone()[0], 2)
            self.assertEqual(manifest['sqlite'], [str(path)])
            self.assertTrue((self.staging / 'current' / 'files' / str(path).lstrip('/')).read_bytes().startswith(b'SQLite format 3\0'))
            self.assertFalse(Path(str(restored) + '-wal').exists())

    def test_new_profiles_and_folders_are_included_without_plan_changes(self):
        first = self.state / 'user-1/usercustom/nested/file.txt'
        first.parent.mkdir(parents=True)
        first.write_text('original')
        recovery.prepare(self.plan)
        second = self.state / 'future-user/usercustom/future/new.bin'
        second.parent.mkdir(parents=True)
        second.write_bytes(b'\0future\xff')
        manifest = recovery.prepare(self.plan)
        self.assertIn('files/' + str(second).lstrip('/'), manifest['files'])
        self.assertIn('files/' + str(first).lstrip('/'), manifest['files'])

    def test_new_component_blocks_backup_until_storage_is_declared(self):
        installed = json.loads(self.installed.read_text())
        installed['installed']['client']['new-service'] = {}
        self.installed.write_text(json.dumps(installed))
        with self.assertRaisesRegex(Failure, 'COVERAGE_CHANGED'):
            recovery.inspect(self.plan)

    def test_profile_cache_rules_are_anchored_and_preserve_usercustom(self):
        proof = self.base / 'rebuild-proof.json'
        proof.write_text(json.dumps({'format': 'brai-rebuild-proof-v1', 'restored': True,
                                     'recipe': 'fixture rebuild', 'software_revision': 'c' * 40,
                                     'subject': {'root': str(self.state), 'relative': '*/.cache'}}))
        self.plan['exclude'] = [{'root': str(self.state), 'relative': '*/.cache',
                                 'reason': 'verified fixture cache', 'proof': {'path': str(proof), 'sha256': digest(proof)}}]
        for user in ('one', 'future'):
            cache = self.state / user / '.cache/index'
            cache.parent.mkdir(parents=True)
            cache.write_text('derived')
            unique = self.state / user / 'usercustom/.cache/keep.txt'
            unique.parent.mkdir(parents=True)
            unique.write_text('unique')
        manifest = recovery.prepare(self.plan)
        names = manifest['files']
        self.assertFalse(any(name.endswith('/.cache/index') for name in names))
        self.assertTrue(any(name.endswith('/usercustom/.cache/keep.txt') for name in names))

    def test_exclusion_requires_verified_recipe_and_cannot_exclude_root(self):
        self.plan['exclude'] = [{'path': str(self.state), 'reason': 'cache',
                                 'proof': {'path': str(self.installed), 'sha256': digest(self.installed)}}]
        with self.assertRaisesRegex(Failure, 'REBUILD_NOT_PROVEN'):
            recovery.inspect(self.plan)

    def test_symlink_outside_covered_roots_is_rejected(self):
        other = self.base / 'outside.txt'
        other.write_text('must not be lost')
        (self.state / 'escape').symlink_to(other)
        with self.assertRaisesRegex(Failure, 'UNCOVERED_SYMLINK'):
            recovery.prepare(self.plan)

    def test_unregistered_volume_is_not_silently_skipped(self):
        def command(argv, **kwargs):
            if argv[:3] == ['docker', 'ps', '-aq']:
                return b'fixture-id'
            if argv[:2] == ['docker', 'inspect']:
                return json.dumps([{'Name': '/new-service',
                                    'Mounts': [{'RW': True, 'Source': '/unregistered', 'Destination': '/data'}]}]).encode()
            return self.commands(argv, **kwargs)
        with patch.object(recovery, 'run', side_effect=command):
            with self.assertRaisesRegex(Failure, 'UNREGISTERED_WRITABLE_MOUNT') as failure:
                recovery.inspect(self.plan)
        self.assertEqual(failure.exception.context, {'container': 'new-service', 'mount': '/data'})

    def test_new_writer_requires_quiescence_coverage(self):
        def command(argv, **kwargs):
            if argv[:2] == ['systemctl', 'list-unit-files']:
                return b'brai-fixture-new.service enabled\n'
            return self.commands(argv, **kwargs)
        with patch.object(recovery, 'run', side_effect=command):
            with self.assertRaisesRegex(Failure, 'UNQUIESCED_SCOPED_UNIT'):
                recovery.inspect(self.plan)

    def test_unsupported_database_format_is_an_error(self):
        (self.state / 'unknown.db').write_bytes(b'not a SQLite database')
        with self.assertRaisesRegex(Failure, 'UNKNOWN_DATABASE_FORMAT'):
            recovery.prepare(self.plan)

    def test_snapshot_and_verification_failure_keep_previous_generation(self):
        original = recovery.prepare(self.plan)['bundle_id']
        with patch.object(recovery, 'isolated_verify', side_effect=Failure('RECOVERY_FIXTURE_FAILURE')):
            with self.assertRaisesRegex(Failure, 'FIXTURE_FAILURE'):
                recovery.prepare(self.plan)
        self.assertEqual(recovery.check_bundle(self.staging / 'current')['bundle_id'], original)
        self.assertFalse((self.staging / 'snapshot-journal.json').exists())
        self.assertTrue(any(argv[0] == '/usr/bin/false' for argv in self.calls))

    def test_failed_resume_retains_journal_and_does_not_publish(self):
        def command(argv, **kwargs):
            if argv[0] == '/usr/bin/false':
                return b'{"state":"unknown"}'
            return self.commands(argv, **kwargs)
        with patch.object(recovery, 'run', side_effect=command):
            with self.assertRaisesRegex(Failure, 'RESUME_UNCONFIRMED'):
                recovery.prepare(self.plan)
        self.assertTrue((self.staging / 'snapshot-journal.json').exists())
        self.assertFalse((self.staging / 'current').exists())
        recovery.resume()
        self.assertFalse((self.staging / 'snapshot-journal.json').exists())

    def test_changed_file_or_extra_file_rejects_restore(self):
        path = self.state / 'document.txt'
        path.write_text('expected bytes')
        recovery.prepare(self.plan)
        bundle = (self.staging / 'current').resolve()
        copied = bundle / 'files' / str(path).lstrip('/')
        copied.write_text('corrupted bytes')
        with self.assertRaisesRegex(Failure, 'CORRUPT'):
            recovery.restore(bundle, self.base / 'target')

    def test_restore_rejects_existing_target_and_symlink_parent(self):
        recovery.prepare(self.plan)
        with self.assertRaisesRegex(Failure, 'MUST_NOT_EXIST'):
            recovery.restore(self.staging / 'current', self.state)
        alias = self.base / 'alias'
        alias.symlink_to(self.state)
        with self.assertRaisesRegex(Failure, 'LINK_PARENT'):
            recovery.restore(self.staging / 'current', alias / 'new')

    def test_file_metadata_and_links_survive(self):
        path = self.state / 'original'
        path.write_bytes(b'exact')
        path.chmod(0o640)
        os.setxattr(path, 'user.fixture', b'extended metadata')
        os.link(path, self.state / 'hardlink')
        (self.state / 'relative-link').symlink_to('original')
        recovery.prepare(self.plan)
        target = self.base / 'restore'
        recovery.restore(self.staging / 'current', target)
        restored = self.restored_path(target, path)
        self.assertEqual(restored.stat().st_mode & 0o777, 0o640)
        self.assertEqual(os.getxattr(restored, 'user.fixture'), b'extended metadata')
        self.assertEqual(os.readlink(restored.parent / 'relative-link'), 'original')
        self.assertEqual(restored.stat().st_ino, (restored.parent / 'hardlink').stat().st_ino)

    def test_shared_cluster_is_rejected_instead_of_exporting_other_tenants(self):
        self.plan['components']['fixture']['postgres'] = [{'container': 'fixture-pg', 'user': 'postgres',
            'database': 'postgres', 'data_mounts': ['/data'], 'dedicated': False}]
        with self.assertRaisesRegex(Failure, 'SHARED_CLUSTER_UNSUPPORTED'):
            recovery.inspect(self.plan)

    def test_regular_user_cannot_run_the_privileged_cli(self):
        with patch.object(sys, 'argv', ['recovery.py', 'prepare']), patch.object(os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(Failure, 'ROOT_REQUIRED'):
                recovery.main()

    def test_archive_password_is_not_part_of_argv_and_parameters_are_removed(self):
        secret = 'synthetic-only passphrase'
        with duplicati.parameters(self.staging, {'passphrase': secret, 'authid': 'synthetic-auth'}) as path:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertIn(secret, path.read_text())
        self.assertFalse(path.exists())
        with self.assertRaisesRegex(Failure, 'CREDENTIAL_INVALID'):
            with duplicati.parameters(self.staging, {'passphrase': 'bad\n--no-encryption=true'}):
                pass

    def test_transfer_failure_never_runs_retention_and_cleans_download(self):
        value = {'destination': 'googledrive://Fixture', 'duplicati': {'image': 'fixture'}, 'keep_versions': 2}
        calls = []
        def failure(image, action, *args, **kwargs):
            calls.append(action)
            if action == 'test':
                raise Failure('RECOVERY_TRANSPORT_FAILED')
        with patch.object(duplicati, 'invoke', side_effect=failure):
            with self.assertRaisesRegex(Failure, 'TRANSPORT_FAILED'):
                duplicati.transfer(value, self.state, self.staging, {'passphrase': 'synthetic'}, lambda p: None)
        self.assertEqual(calls, ['backup', 'test'])
        self.assertFalse(list(self.staging.glob('.parameters-*')))
        self.assertFalse(list(self.staging.glob('.download-*')))

    def test_cloud_receipt_is_written_only_after_restored_bundle_passes(self):
        key = self.base / 'passphrase'
        key.write_text('synthetic only')
        self.plan.update(destination='file://' + str(self.base / 'remote'), duplicati={'image': 'duplicati/duplicati@sha256:' + 'a' * 64})
        previous = {'bundle_id': 'previous', 'cloud_verified': False, 'verified_at': 'earlier'}
        write_json(self.staging / 'last-verified.json', previous)
        with patch.object(recovery, 'transfer', side_effect=Failure('RECOVERY_REMOTE_CORRUPT')):
            with self.assertRaisesRegex(Failure, 'REMOTE_CORRUPT'):
                recovery.upload(self.plan)
        self.assertEqual(json.loads((self.staging / 'last-verified.json').read_text()), previous)


    def test_interrupted_container_transfer_is_resumed_and_secrets_stay_out_of_argv(self):
        catalog = self.staging / 'duplicati'
        catalog.mkdir()
        options = self.staging / 'private-options'
        options.write_text('--passphrase=SYNTHETIC-SECRET')
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            if argv[:2] == ['docker', 'run']:
                raise KeyboardInterrupt
            return b''
        with patch.object(duplicati, 'run', side_effect=command):
            with self.assertRaises(KeyboardInterrupt):
                duplicati.invoke('fixture', 'backup', 'googledrive://Fixture', options, catalog, bundle=self.state)
        self.assertFalse((self.staging / 'transfer-journal.json').exists())
        self.assertNotIn('SYNTHETIC-SECRET', json.dumps(calls))
        self.assertTrue(any('dst=/source,readonly' in str(arg) for argv in calls for arg in argv))

    def test_unknown_docker_outcome_preserves_journal_and_never_removes_foreign_container(self):
        identity = 'a' * 32
        journal = self.staging / 'transfer-journal.json'
        write_json(journal, {'identity': identity, 'name': 'brai-backup-transfer-' + identity, 'database': None})
        with patch.object(duplicati, 'run', side_effect=Failure('RECOVERY_DOCKER_UNAVAILABLE')):
            with self.assertRaisesRegex(Failure, 'DOCKER_UNAVAILABLE'):
                duplicati.resume(self.staging)
        self.assertTrue(journal.exists())
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            if argv[:2] == ['docker', 'ps']:
                return b'container'
            return json.dumps([{'Config': {'Labels': {'brai.backup.transfer': 'foreign'}}}]).encode()
        with patch.object(duplicati, 'run', side_effect=command):
            with self.assertRaisesRegex(Failure, 'CONTAINER_CHANGED'):
                duplicati.resume(self.staging)
        self.assertTrue(journal.exists())
        self.assertFalse(any(argv[:2] == ['docker', 'rm'] for argv in calls))

    def test_unknown_plan_fields_are_rejected_before_copying(self):
        self.plan['components']['fixture']['postgress'] = []
        with self.assertRaisesRegex(Failure, 'PLAN_FIELDS_INVALID'):
            recovery.prepare(self.plan)
        self.assertFalse((self.staging / 'current').exists())



    def test_resume_removes_only_own_closed_orphaned_parameter_files(self):
        path = self.staging / '.parameters-orphan'
        path.write_text('--passphrase=SYNTHETIC-ORPHAN')
        path.chmod(0o600)
        recovery.resume()
        self.assertFalse(path.exists())
        other = self.staging / '.parameters-symlink'
        other.symlink_to(self.installed)
        with self.assertRaisesRegex(Failure, 'PARAMETER_FILE_UNTRUSTED'):
            recovery.resume()
        self.assertTrue(self.installed.exists())

    def test_changed_configuration_cannot_reuse_a_verified_status(self):
        config = self.base / 'plan.json'
        config.write_text(json.dumps(self.plan))
        write_json(self.base / 'status.json', {'stage': 'verified', 'bundle_id': 'old',
                   'cloud_verified': True, 'plan_sha256': 'mismatched'})
        with patch.object(recovery, 'CONFIG', config):
            status = recovery.public_status()
        self.assertEqual(status['stage'], 'configuration_changed')
        self.assertFalse(status['cloud_verified'])



    def test_pending_publication_is_saved_even_when_scratch_root_is_excluded(self):
        work = self.state / 'person/workspace/files/work'
        work.mkdir(parents=True)
        pending = work / 'pending.bin'
        pending.write_bytes(b'pending original\0\xff')
        (work / 'scratch.txt').write_text('rebuildable scratch')
        registry = self.state / 'person/brai-files/files.sqlite'
        registry.parent.mkdir()
        with sqlite3.connect(registry) as db:
            db.executescript('CREATE TABLE items(path TEXT, artifact TEXT); CREATE TABLE publications(path TEXT, confirmed INTEGER);')
            db.execute('INSERT INTO publications VALUES (?,0)', (str(pending),))
        proof = self.base / 'scratch-proof.json'
        selector = {'root': str(self.state), 'relative': '*/workspace/files/work'}
        proof.write_text(json.dumps({'format': 'brai-rebuild-proof-v1', 'restored': True,
                                     'recipe': 'fixture scratch', 'software_revision': 'c' * 40, 'subject': selector}))
        self.plan['exclude'] = [{**selector, 'reason': 'temporary work', 'proof': {'path': str(proof), 'sha256': digest(proof)}}]
        manifest = recovery.prepare(self.plan)
        self.assertIn('files/' + str(pending).lstrip('/'), manifest['files'])
        self.assertFalse(any(name.endswith('/scratch.txt') for name in manifest['files']))
        target = self.base / 'restored-pending'
        recovery.restore(self.staging / 'current', target)
        self.assertEqual(self.restored_path(target, pending).read_bytes(), b'pending original\0\xff')
        pending.unlink()
        with self.assertRaisesRegex(Failure, 'DEPENDENCY_MISSING'):
            recovery.prepare(self.plan)
        self.assertEqual(recovery.check_bundle(self.staging / 'current')['bundle_id'], manifest['bundle_id'])

    def test_local_generations_have_no_implicit_retention_limit(self):
        recovery.prepare(self.plan)
        recovery.prepare(self.plan)
        self.assertEqual(len(list(self.staging.glob('build-*'))), 2)
        self.plan['local_keep_versions'] = 1
        key = self.base / 'passphrase'
        key.write_text('synthetic only')
        self.plan.update(destination='file://' + str(self.base / 'remote'),
                         duplicati={'image': 'duplicati/duplicati@sha256:' + 'a' * 64})
        def verified(value, bundle, root, private, verify):
            verify(bundle)
        with patch.object(recovery, 'transfer', side_effect=verified):
            recovery.upload(self.plan)
        self.assertEqual(len(list(self.staging.glob('build-*'))), 1)



    def test_artifact_blobs_remain_exact_bytes_even_with_a_sqlite_header(self):
        self.installed.write_text(json.dumps({'installed': {'client': {'artifacts': {}}},
                                              'source_revisions': {'brai': 'a' * 40}}))
        self.plan['components'] = {'artifacts': {'roots': [str(self.state)]}}
        blob = self.state / 'artifact.sqlite'
        blob.write_bytes(b'SQLite format 3\0opaque artifact payload')
        manifest = recovery.prepare(self.plan)
        self.assertEqual(manifest['sqlite'], [])
        target = self.base / 'opaque-restored'
        recovery.restore(self.staging / 'current', target)
        self.assertEqual(self.restored_path(target, blob).read_bytes(), blob.read_bytes())



    def test_collector_cannot_stop_its_own_service(self):
        self.plan['snapshot']['units'] = ['brai-client-backup.service']
        with self.assertRaisesRegex(Failure, 'SELF_STOP_FORBIDDEN'):
            recovery.prepare(self.plan)
        self.assertFalse((self.staging / 'snapshot-journal.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)

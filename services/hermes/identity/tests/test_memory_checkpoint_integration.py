# ABOUTME: Проверяет provider→gateway checkpoint и восстановление шести pending.
# ABOUTME: Использует только синтетический профиль, временные файлы и локальный fake MemOS.
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from services.hermes.identity.memory_gateway import Boundary

PLUGIN = Path(__file__).resolve().parents[2] / 'extensions/plugins/memos-rest'


class CheckpointIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        package = types.ModuleType('checkpoint_integration')
        package.__path__ = [str(PLUGIN)]
        sys.modules[package.__name__] = package
        worker = types.ModuleType('agent.memory_provider')
        worker.spawn_context_thread = lambda *args, **kwargs: None
        sys.modules['agent'] = types.ModuleType('agent')
        sys.modules['agent.memory_provider'] = worker
        utility = types.ModuleType('utils')
        utility.atomic_json_write = lambda path, value, **kwargs: Path(path).write_text(json.dumps(value))
        sys.modules['utils'] = utility
        self.modules = {}
        for name in ('client', 'router', 'outbox', 'admin', 'routing'):
            spec = importlib.util.spec_from_file_location(package.__name__ + '.' + name, PLUGIN / (name + '.py'))
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            self.modules[name] = module
        stable_id = self.modules['router'].stable_id
        self.config = {'base_url':'http://127.0.0.1:1', 'user_id':'u', 'scope_profile':'test',
                       'cube_id':'main', 'routing_enabled':True, 'memory_epoch':'epoch',
                       'deployment_phase':'setup', 'generation':1, 'frozen':False, 'flush_timeout':1}
        self.save_config()
        self.catalog = self.modules['router'].Catalog(self.home)
        self.profile = {'userId':'u', 'profileId':'p', 'authorId':'111', 'homeScope':stable_id(str(self.home)),
                        'memoryEpoch':'epoch', 'status':'active', 'cubes':self.catalog.cubes}
        self.rows, self.add_count = {}, 0
        test = self

        class Backend:
            def __init__(self, config):
                self.cube = config['cube_id']

            def request(self, path, body=None):
                if path == '/product/memory_capabilities':
                    return {'code':200, 'data':{'memory_stream':1, 'recall_index':1}}
                if path == '/product/add':
                    test.add_count += 1
                    identifier = 'memory-' + str(test.add_count)
                    test.rows[identifier] = {'id':identifier, '_cube_id':self.cube,
                        'memory':'\n'.join(row['content'] for row in body['messages']),
                        'metadata':{'user_id':body['user_id'], 'session_id':body['session_id'],
                                    'info':copy.deepcopy(body['info'])}}
                    return {'code':200, 'data':[{'cube_id':self.cube, 'memory_id':identifier}]}
                raise AssertionError(path)

            def _memory_read(self, body, timeout=None):
                rows = [copy.deepcopy(row) for row in test.rows.values() if row['_cube_id'] == self.cube]
                return {'code':200, 'data':{'text_mem':[{'cube_id':self.cube, 'memories':rows}]}}

        self.boundary = Boundary('', '', authorize=lambda *args:True, cursor_key=b'x',
                                 registry_loader=lambda _: {1:self.profile}, clients=Backend)
        tree = ast.parse((PLUGIN / 'provider.py').read_text())
        source_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'MemOSProvider')
        source_class.bases = []
        source_class.decorator_list = []
        source_class.body = [node for node in source_class.body if isinstance(node, ast.FunctionDef)
                             and node.name in ('_body', '_archive', 'on_pre_compress')]
        scope = {'Path':Path, 'digest':stable_id, 'scrub':lambda value:value, 'dialogue':lambda rows:rows,
                 'internal_dialogue':lambda rows:False, 'MemOSError':self.modules['client'].MemOSError}
        provider_module = types.ModuleType(package.__name__ + '.provider')
        provider_module.scrub = scope['scrub']
        sys.modules[provider_module.__name__] = provider_module
        exec(compile(ast.fix_missing_locations(ast.Module(body=[source_class], type_ignores=[])), '<provider>', 'exec'), scope)
        self.provider = provider = scope['MemOSProvider']()
        provider.home, provider.config, provider.context = self.home, self.config, {'platform':'telegram'}
        provider.session_id, provider.primary, provider._lock = 'session', True, threading.RLock()
        provider.author = {'id':'111'}
        provider.client = self.modules['client'].Client(self.config)
        provider.client.request = lambda path, body=None, **kwargs: self.boundary.handle(
            1, 'GET' if body is None else 'POST', path, body or {})
        runtime = object.__new__(self.modules['routing'].RoutedRuntime)
        runtime.home, runtime.provider, runtime.catalog = self.home, provider, self.catalog
        runtime.home_scope = self.profile['homeScope']
        runtime.api = provider.client
        runtime.writable = lambda job=None:self.config
        runtime.router = types.SimpleNamespace(extract=lambda *args:[])
        provider.routing = runtime
        provider.outbox = self.modules['outbox'].Outbox(self.home, runtime)
        provider.outbox.flush = lambda timeout, event_id=None: (
            provider.outbox.process_once() or provider.outbox.receipt(event_id) is not None)

    def save_config(self):
        (self.home / 'memos-rest.json').write_text(json.dumps(self.config))

    def test_provider_checkpoint_roundtrip_and_legacy_do_not_extract_facts(self):
        self.provider.routing.router.extract = lambda *args: self.fail('Checkpoint must not extract facts')
        rows = [{'role':'user','content':'First speaker'}, {'role':'assistant','content':'Reply'},
                {'role':'user','content':'Unresolved second speaker'}]
        self.assertIn('verified', self.provider.on_pre_compress(rows, require_checkpoint=True))
        self.assertEqual(self.add_count, 1)
        stored = next(iter(self.rows.values()))['metadata']['info']
        self.assertEqual(stored['hermes_author_id'], '111')
        self.assertEqual(stored['hermes_source_author_id'], 'multiple_or_unknown')
        self.assertEqual(stored['hermes_checkpoint']['origin'], {'session_id':'session', 'platform':'telegram'})
        self.assertTrue(all(author['author_id'] is None for author in stored['hermes_checkpoint']['authors']))
        self.provider.on_pre_compress(rows, require_checkpoint=True)
        self.assertEqual(self.add_count, 1)
        job = {'body':self.provider._body(rows, 'legacy-session', 'checkpoint',
                                        {'id':'multiple_or_unknown'}, 'legacy')}
        self.provider.outbox.submit('legacy', self.provider.routing.enqueue(job))
        self.provider.outbox.process_once()
        self.assertIsNotNone(self.provider.outbox.receipt('legacy'))
        self.assertEqual(self.add_count, 2)

    def test_six_pending_repair_has_exact_backup_readback_and_no_duplicates(self):
        originals, hashes = {}, {}
        for index in range(6):
            event, kind = 'event-' + str(index), 'checkpoint' if index in (0, 5) else 'turn'
            rows = [{'role':'user','content':'Synthetic evidence ' + str(index)}]
            author = {'id':'multiple_or_unknown' if kind == 'checkpoint' else '111'}
            job = {'body':self.provider._body(rows, 'session', kind, author, event)}
            self.provider.outbox.submit(event, self.provider.routing.enqueue(job))
            path = self.provider.outbox.pending / (event + '.json')
            queued = json.loads(path.read_bytes())
            queued.update(attempts=464 if index == 0 else 0, next_attempt=99999999999)
            path.write_text(json.dumps(queued, indent=2))
            originals[event] = path.read_bytes()
            hashes[event] = hashlib.sha256(originals[event]).hexdigest()
        self.config['frozen'] = True
        self.save_config()
        admin = self.modules['admin'].Admin(self.home)
        scope = {'profile':'test', 'user_id':'u', 'managed_cubes':self.catalog.cubes}
        plan = admin.repair_checkpoint_queue(scope, hashes)
        self.assertEqual(plan['status'], 'planned')
        self.assertTrue(all((admin.root / 'pending' / (event + '.json')).read_bytes() == raw
                            for event, raw in originals.items()))
        applied = admin.repair_checkpoint_queue(scope, hashes, apply=True)
        self.assertEqual(admin.repair_checkpoint_queue(scope, hashes, apply=True), applied)
        for event, raw in originals.items():
            backup = admin.root / 'queue-repair-v1' / plan['plan_id'] / (event + '.json')
            self.assertEqual(backup.read_bytes(), raw)
            repaired = json.loads((admin.root / 'pending' / (event + '.json')).read_bytes())
            self.assertEqual(repaired['body'], json.loads(raw)['body'])
            self.assertEqual(repaired['attempts'], json.loads(raw)['attempts'])
            self.assertEqual(repaired['queue_repair']['original_sha256'], hashes[event])
        self.config['frozen'] = False
        self.save_config()
        self.provider.outbox.process_once()
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        self.assertEqual(self.provider.outbox.status()['verified_events'], 6)
        self.assertEqual(self.add_count, 6)
        self.provider.outbox.process_once()
        self.assertEqual(self.add_count, 6)
        self.config['frozen'] = True
        self.save_config()
        self.assertEqual(admin.repair_checkpoint_queue(scope, hashes, apply=True), applied)
        self.assertEqual(self.add_count, 6)

    def test_repair_rejects_wrong_scope_hash_and_epoch_then_resumes_interruption(self):
        hashes = {}
        for event in ('first', 'second'):
            job = {'body':self.provider._body([{'role':'user','content':event}], 'session',
                                            'checkpoint', {'id':'multiple_or_unknown'}, event)}
            self.provider.outbox.submit(event, self.provider.routing.enqueue(job))
            hashes[event] = hashlib.sha256((self.provider.outbox.pending / (event + '.json')).read_bytes()).hexdigest()
        admin = self.modules['admin'].Admin(self.home)
        scope = {'profile':'test', 'user_id':'u', 'managed_cubes':self.catalog.cubes}
        with self.assertRaisesRegex(ValueError, 'frozen'):
            admin.repair_checkpoint_queue(scope, hashes, apply=True)
        self.config['frozen'] = True
        self.save_config()
        with self.assertRaisesRegex(ValueError, 'scope'):
            admin.repair_checkpoint_queue({**scope, 'user_id':'other'}, hashes, apply=True)
        with self.assertRaisesRegex(Exception, 'hash mismatch'):
            admin.repair_checkpoint_queue(scope, {**hashes, 'first':'0'*64}, apply=True)
        self.config['memory_epoch'] = 'new-epoch'
        self.save_config()
        with self.assertRaisesRegex(Exception, 'scope or operation'):
            admin.repair_checkpoint_queue(scope, hashes, apply=True)
        self.config['memory_epoch'] = 'epoch'
        self.save_config()
        original_write = self.modules['admin'].atomic_json_write
        writes = []
        def interrupted(path, value, **kwargs):
            if Path(path).parent.name == 'pending':
                writes.append(path)
                if len(writes) == 2:
                    raise OSError('Synthetic interrupted repair')
            original_write(path, value, **kwargs)
        with patch.object(self.modules['admin'], 'atomic_json_write', interrupted):
            with self.assertRaisesRegex(OSError, 'interrupted'):
                admin.repair_checkpoint_queue(scope, hashes, apply=True)
        self.assertEqual(self.add_count, 0)
        result = admin.repair_checkpoint_queue(scope, hashes, apply=True)
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(len(list((admin.root / 'queue-repair-v1' / result['plan_id']).glob('*.json'))), 3)
        self.assertEqual(self.add_count, 0)


if __name__ == '__main__':
    unittest.main()

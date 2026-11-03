# ABOUTME: Проверяет owner scope, маршрутизацию и durable lifecycle MemOS.
# ABOUTME: Все модели и API заменены локальными fake; пользовательские данные не читаются.
"""Multi-cube tracer bullets; all writes target an in-memory fake API."""
import copy
import importlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugins.memory import load_memory_provider
import test_provider as legacy

Backend = legacy.Backend
PLUGIN_ROOT = legacy.PLUGIN_ROOT


class MultiBackend(Backend):
    def request(self, client, path, body=None, **kwargs):
        if self.offline:
            return super().request(client, path, body, **kwargs)
        cube = (body or {}).get('mem_cube_id') or ((body or {}).get('writable_cube_ids') or [client.cube_id])[0]
        if path == '/product/add':
            proxy = copy.copy(client)
            proxy.cube_id = cube
            before = self.add_count
            try:
                return super().request(proxy, path, body, **kwargs)
            finally:
                if self.add_count != before:
                    self.rows[f'memory-{self.add_count}']['cube'] = cube
        if path in ('/product/get_memory', '/product/search'):
            self.calls.append((path, copy.deepcopy(body)))
            cubes = (body or {}).get('readable_cube_ids', [cube])
            # Ignore metadata/user filters but preserve real cube containers.
            groups = [{'cube_id': c, 'memories': [copy.deepcopy(r) for r in self.rows.values() if r.get('cube') == c]}
                      for c in cubes]
            return {'code': 200, 'data': {'text_mem': groups}}
        return super().request(client, path, body, **kwargs)


class RoutingTests(unittest.TestCase):
    tearDown = legacy.ProviderTests.tearDown
    def new_provider(self, *args, **kwargs):
        """Изолировать модель релевантности в тестах транспорта и прав доступа."""
        provider = legacy.ProviderTests.new_provider(self, *args, **kwargs)
        if provider.routing:
            provider.routing.router.plan = lambda query, context=None: {'goal':'evidence','query':query}
            provider.routing.router.rank = lambda query, rows, **kwargs: {
                'matches': [{'index': i, 'relevance': 'direct', 'reason': 'Synthetic relevant evidence'}
                            for i in range(len(rows))],
                'needs_sources': False, 'source_query': query}
        return provider
    send = legacy.ProviderTests.send
    retry_now = legacy.ProviderTests.retry_now

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memos-routing-')
        self.home = Path(self.temp.name)
        shutil.copytree(PLUGIN_ROOT, self.home / 'plugins' / 'memos-rest', ignore=shutil.ignore_patterns('tests', '__pycache__'))
        self.env = patch.dict(os.environ, {'HERMES_HOME': str(self.home)})
        self.env.start()
        self.cfg = {'base_url': 'http://127.0.0.1:8001', 'user_id': 'root', 'cube_id': 'main',
                    'routing_enabled': True, 'deployment_phase': 'setup', 'memory_epoch': 'test-epoch',
                    'generation': 1, 'enabled': True, 'frozen': False,
                    'router': {'base_url': 'http://127.0.0.1:8012', 'model': 'test-model'}}
        self.save_config()
        self.backend = MultiBackend()
        self.providers = []
        self.provider = self.new_provider('session-a', user_id='alice')

    def save_config(self):
        (self.home / 'memos-rest.json').write_text(json.dumps(self.cfg))

    def router_reply(self, facts, provider=None):
        def reply(payload):
            data = json.loads(payload[-1]['content'])
            if 'candidates' in data:
                return {'reviews': [{'index': i, 'keep': True, 'spheres': f['spheres'],
                                     'supported': True, 'standalone': True, 'reason': 'Synthetic supported fact'}
                                    for i, f in enumerate(data['candidates'])]}
            return {'facts': facts}
        (provider or self.provider).routing.router.transport = reply

    def fact(self, **changes):
        return {'text': 'I am studying sales.', 'source': {'message_index': 0, 'role': 'user',
                'start': 0, 'end': 20, 'quote': 'I am studying sales.'},
                'spheres': ['life_intellect'], 'projects': [], 'status': 'observation', **changes}

    def test_backend_write_pause_prevents_false_resume(self):
        self.cfg.update(backend_write_paused=True, frozen=True)
        self.save_config()
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root', 'managed_cubes': self.provider.routing.catalog.cubes}
        with self.assertRaisesRegex(ValueError, 'базе данных'):
            admin.resume(scope)
        self.assertTrue(admin.config()['frozen'])

    def test_bulk_clear_lock_blocks_purge_and_handoff_before_api_calls(self):
        self.cfg['bulk_clear_locked'] = True
        self.save_config()
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root', 'managed_cubes': self.provider.routing.catalog.cubes}
        for operation in ('purge', 'handoff'):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(ValueError, 'массовой очистки'):
                    getattr(admin, operation)(scope, 'PURGE default/root managed')
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(admin.config()['memory_epoch'], 'test-epoch')

    def test_named_owner_rejects_wrong_scope_before_api_calls(self):
        """Чужие owner/profile и неполный набор кубов отвергаются до чтения backend."""
        self.cfg.update(user_id='tenant-owner', scope_profile='hermes-dev', bulk_clear_locked=True)
        self.save_config()
        admin = self.provider.routing.admin()
        scope = {'profile': 'hermes-dev', 'user_id': 'tenant-owner', 'managed_cubes': self.provider.routing.catalog.cubes}
        for wrong in ({**scope, 'user_id': 'root'}, {**scope, 'profile': 'default'},
                      {**scope, 'managed_cubes': scope['managed_cubes'][:-1]},
                      {**scope, 'managed_cubes': scope['managed_cubes'] + ['unmanaged']}):
            with self.subTest(scope=wrong):
                with self.assertRaisesRegex(ValueError, 'scope'):
                    admin.resume(wrong)
        for operation in ('purge', 'handoff'):
            with self.assertRaisesRegex(ValueError, 'default/root'):
                getattr(admin, operation)(scope, 'PURGE hermes-dev/tenant-owner managed', 'next-epoch')
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(admin.status()['user_id'], 'tenant-owner')
        self.assertEqual(admin.status()['profile'], 'hermes-dev')

    def test_cli_accepts_only_matching_named_owner_scope(self):
        """CLI передаёт явные owner/profile в общий проверяемый Admin boundary."""
        import argparse
        import contextlib
        import io
        self.cfg.update(user_id='tenant-owner', scope_profile='hermes-dev', frozen=True)
        self.save_config()
        cli = importlib.import_module(self.provider.__class__.__module__.rsplit('.', 1)[0] + '.cli')
        parser = argparse.ArgumentParser()
        cli.register_cli(parser)
        cubes = self.provider.routing.catalog.cubes
        wrong = parser.parse_args(['resume', '--scope-profile', 'default', '--user-id', 'root', '--managed-cubes', *cubes])
        with self.assertRaisesRegex(ValueError, 'scope'):
            wrong.func(wrong)
        args = parser.parse_args(['resume', '--scope-profile', 'hermes-dev', '--user-id', 'tenant-owner', '--managed-cubes', *cubes])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            args.func(args)
        result = json.loads(output.getvalue())
        self.assertEqual(result['user_id'], 'tenant-owner')
        self.assertEqual(result['profile'], 'hermes-dev')
        self.assertFalse(result['frozen'])
        self.assertEqual(self.backend.calls, [])

    def owner_empty_scope(self):
        """Подготовить только fake owner-профиль для empty handoff."""
        self.cfg.update(user_id='tenant-owner', scope_profile='hermes-dev', frozen=True, enabled=False, bulk_clear_locked=True)
        self.save_config()
        return self.provider.routing.admin(), {'profile': 'hermes-dev', 'user_id': 'tenant-owner', 'managed_cubes': self.provider.routing.catalog.cubes}

    def test_empty_handoff_checks_every_cube_and_never_deletes(self):
        """Любая owner-запись в любом managed cube останавливает переход без записи state."""
        admin, scope = self.owner_empty_scope()
        original = (self.home / 'memos-rest.json').read_bytes()
        for cube in scope['managed_cubes']:
            self.backend.rows = {'existing': {'id': 'existing', 'memory': 'Existing synthetic row', 'cube': cube,
                                             'metadata': {'user_id': 'tenant-owner', 'info': {}}}}
            self.backend.calls.clear()
            with self.subTest(cube=cube), self.assertRaisesRegex(Exception, 'zero owner memories'):
                admin.handoff_empty(scope, 'production-empty')
            self.assertEqual((self.home / 'memos-rest.json').read_bytes(), original)
            self.assertFalse((admin.root / 'admin-state.json').exists())
            self.assertFalse((admin.root / 'session-fence.json').exists())
            self.assertEqual(set(self.backend.rows), {'existing'})
            self.assertFalse(any(path == '/product/delete_memory' for path, body in self.backend.calls))

    def test_empty_handoff_rejects_pending_receipts_scope_and_stale_epoch(self):
        """Непустая очередь, квитанция, чужая область и прежний epoch не меняют профиль."""
        admin, scope = self.owner_empty_scope()
        original = (self.home / 'memos-rest.json').read_bytes()
        for folder in ('pending', 'receipts'):
            path = admin.root / folder / 'existing.json'
            path.write_text('{}')
            with self.subTest(folder=folder), self.assertRaisesRegex(Exception, 'empty native'):
                admin.handoff_empty(scope, 'production-empty')
            self.assertEqual(path.read_text(), '{}')
            path.unlink()
        for wrong in ({**scope, 'user_id': 'root'}, {**scope, 'profile': 'default'},
                      {**scope, 'managed_cubes': scope['managed_cubes'][:-1]}):
            with self.subTest(scope=wrong), self.assertRaisesRegex(ValueError, 'scope'):
                admin.handoff_empty(wrong, 'production-empty')
        with self.assertRaisesRegex(ValueError, 'fresh'):
            admin.handoff_empty(scope, self.cfg['memory_epoch'])
        self.assertEqual((self.home / 'memos-rest.json').read_bytes(), original)
        self.assertFalse((admin.root / 'admin-state.json').exists())
        self.assertEqual(self.backend.calls, [])

    def test_empty_handoff_proves_scope_fences_sessions_and_preserves_foreign_owner(self):
        """Пустая owner-область получает настоящий production state без удаления чужих строк."""
        admin, scope = self.owner_empty_scope()
        foreign = {'id': 'foreign', 'cube': 'main', 'memory': 'Foreign synthetic fact',
                   'metadata': {'user_id': 'foreign-owner', 'info': {}}}
        self.backend.rows = {'foreign': foreign}
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(self.home / 'state.db')) as connection:
            connection.execute('CREATE TABLE sessions (id TEXT, started_at REAL)')
            connection.execute('INSERT INTO sessions VALUES (?, ?)', ('old-canonical-session', 0))
            connection.commit()
        (admin.root / 'session-fence.json').write_text(json.dumps({'sessions': {'previous-session-hash': 'test-epoch'}}))
        result = admin.handoff_empty(scope, 'production-empty')
        self.assertEqual(result['deployment_phase'], 'production')
        self.assertEqual(result['memory_epoch'], 'production-empty')
        self.assertEqual(result['generation'], 2)
        self.assertTrue(result['frozen'])
        self.assertTrue(result['bulk_clear_locked'])
        self.assertFalse(result['enabled'])
        state = json.loads((admin.root / 'admin-state.json').read_text())
        self.assertEqual(state['status'], 'complete')
        self.assertEqual(state['new_epoch'], 'production-empty')
        self.assertEqual(state['user_id'], 'tenant-owner')
        self.assertEqual(state['profile'], 'hermes-dev')
        fence = json.loads((admin.root / 'session-fence.json').read_text())
        self.assertIn('previous-session-hash', fence['revoked'])
        self.assertEqual(fence['sessions'], {})
        self.assertEqual(self.backend.rows, {'foreign': foreign})
        self.assertEqual({body['mem_cube_id'] for path, body in self.backend.calls}, set(scope['managed_cubes']))
        self.assertTrue(all(path == '/product/get_memory' for path, body in self.backend.calls))
        self.assertEqual(admin.handoff_empty(scope, 'production-empty')['generation'], 2)
        admin.resume(scope)
        self.provider.sync_turn('An old loaded session cannot write.', '')
        self.send()
        self.assertEqual(self.backend.rows, {'foreign': foreign})
        fresh = self.new_provider('fresh-empty-owner-session', user_id='tenant-owner')
        fresh.routing.router.transport = lambda payload: {'facts': []}
        fresh.sync_turn('A fresh owner session can write.', '')
        self.send(fresh)
        self.assertEqual(len(self.backend.rows), 2)
        self.assertEqual(json.loads(fresh.handle_tool_call('memos_status', {}))['user_id'], 'tenant-owner')
        fresh.on_session_switch('old-canonical-session')
        fresh.sync_turn('Delayed canonical session cannot write.', '')
        self.send(fresh)
        self.assertEqual(len(self.backend.rows), 2)

    def test_empty_handoff_rejects_unfrozen_or_unlocked_without_io(self):
        """Empty bootstrap не снимает и не обходит frozen/bulk lock."""
        admin, scope = self.owner_empty_scope()
        for flags in ({'frozen': False}, {'bulk_clear_locked': False}):
            self.cfg.update({'frozen': True, 'bulk_clear_locked': True, **flags})
            self.save_config()
            original = (self.home / 'memos-rest.json').read_bytes()
            with self.subTest(flags=flags), self.assertRaisesRegex(ValueError, 'frozen memory'):
                admin.handoff_empty(scope, 'production-empty')
            self.assertEqual((self.home / 'memos-rest.json').read_bytes(), original)
            self.assertFalse((admin.root / 'admin-state.json').exists())
        self.assertEqual(self.backend.calls, [])

    def test_empty_handoff_resumes_only_exact_interrupted_transition(self):
        """Сбой после empty proof сохраняет intent; продолжение не меняет выбранный epoch."""
        admin, scope = self.owner_empty_scope()
        with patch.object(admin, 'write', side_effect=OSError('Synthetic config commit failure')):
            with self.assertRaises(OSError):
                admin.handoff_empty(scope, 'production-empty')
        state = json.loads((admin.root / 'admin-state.json').read_text())
        self.assertEqual(state['status'], 'in_progress')
        self.assertEqual(admin.config()['memory_epoch'], 'test-epoch')
        with self.assertRaisesRegex(ValueError, 'exact interrupted'):
            admin.handoff_empty(scope, 'different-epoch')
        result = admin.handoff_empty(scope, 'production-empty')
        self.assertEqual(result['memory_epoch'], 'production-empty')
        self.assertEqual(result['generation'], 2)
        final_state = json.loads((admin.root / 'admin-state.json').read_text())
        self.assertEqual(final_state['status'], 'complete')
        self.assertEqual(final_state['started_at'], state['started_at'])
        self.assertEqual(self.backend.rows, {})
        self.assertTrue(all(path == '/product/get_memory' for path, body in self.backend.calls))

    def test_destructive_handoff_rechecks_identity_after_lock_wait(self):
        """Смена identity во время ожидания lock не даёт старому root-вызову удалить новую область."""
        from contextlib import contextmanager
        module = importlib.import_module(self.provider.__class__.__module__.rsplit('.', 1)[0] + '.admin')
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root', 'managed_cubes': self.provider.routing.catalog.cubes}
        original_lock = module.file_lock
        changed = {**self.cfg, 'user_id': 'tenant-owner', 'scope_profile': 'hermes-dev'}
        @contextmanager
        def lock_with_identity_change(path, timeout=120):
            """Имитировать только конкурентную смену настроек перед выдачей admin lock."""
            if Path(path).name == 'admin.lock':
                (self.home / 'memos-rest.json').write_text(json.dumps(changed))
            with original_lock(path, timeout):
                yield
        with patch.object(module, 'file_lock', lock_with_identity_change), patch.object(admin, 'write') as write:
            with self.assertRaisesRegex(ValueError, 'default/root'):
                admin.handoff(scope, 'PURGE default/root managed', 'must-not-commit')
            write.assert_not_called()
        self.assertEqual(json.loads((self.home / 'memos-rest.json').read_text()), changed)
        self.assertFalse((admin.root / 'admin-state.json').exists())
        self.assertFalse((admin.root / 'session-fence.json').exists())
        self.assertEqual(self.backend.calls, [])

    def test_fact_copy_contains_only_its_source_quote_not_full_dialogue(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales. Unrelated private detail.', 'Unrelated reply.')
        self.send()
        fact = next(r for r in self.backend.rows.values() if r['cube'] == 'life_intellect')
        transcript = fact['metadata']['info']['hermes_messages']
        self.assertEqual(transcript, [{'role': 'user', 'content': 'I am studying sales.'}])
        original = next(r for r in self.backend.rows.values() if r['cube'] == 'main')
        self.assertIn('Unrelated private detail.', original['memory'])

    def test_long_dialogue_is_chunked_recovered_and_forgotten_as_one_memory(self):
        text = ('Массаж 🟢 и уход. ' * 300)
        self.router_reply([])
        self.provider.sync_turn(text, '')
        original_request = self.provider.client.request
        lost = [False]
        def limited_api(path, body=None, **extra):
            if path == '/product/add':
                part = body['messages'][0]['content']
                self.assertLessEqual(len(part.encode('utf-8')), 768)
                if not lost[0]:
                    lost[0] = True
                    self.backend.lose_response = True
            return original_request(path, body, **extra)
        self.provider.client.request = limited_api
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 1)
        self.retry_now()
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        rows = sorted(self.backend.rows.values(), key=lambda row: row['metadata']['info']['hermes_chunk_index'])
        self.assertGreater(len(rows), 1)
        self.assertEqual(''.join(row['memory'] for row in rows), text)
        self.assertTrue(all(row['metadata']['info']['hermes_messages'][0]['content'] == text for row in rows))
        self.assertEqual(len(rows), self.backend.add_count, 'lost response must not duplicate a part')
        result = json.loads(self.provider.handle_tool_call('memos_forget', {'memory_id': rows[0]['id']}))
        self.assertEqual(result['status'], 'pending')
        self.send()
        self.assertEqual(self.backend.rows, {}, 'forget must delete every part')

    def test_corrupted_part_never_receives_a_delivery_receipt(self):
        self.router_reply([])
        self.provider.sync_turn('Сохранить текст. ' * 100, '')
        original_request = self.provider.client.request
        def corrupt_part(path, body=None, **extra):
            result = original_request(path, body, **extra)
            if path == '/product/get_memory':
                for group in result['data']['text_mem']:
                    for row in group['memories']:
                        row['memory'] = 'corrupted'
            return result
        self.provider.client.request = corrupt_part
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 1)
        self.assertEqual(self.provider.outbox.status()['verified_events'], 0)
        self.assertIn('chunk_content', self.provider.outbox.status()['last_error'])
        self.provider.client.request = original_request
        self.retry_now()
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 0)

    def test_worker_archives_original_and_routes_grounded_atomic_fact(self):
        self.assertIsNotNone(getattr(self.provider, 'routing', None), 'semantic runtime must be enabled')
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', 'Good.', messages=[
            {'role': 'user', 'content': 'I am studying sales.'}, {'role': 'assistant', 'content': 'Good.'}])
        self.assertEqual(self.backend.calls, [], 'sync_turn may not perform LLM or API calls')
        self.send()
        self.assertEqual({r['cube'] for r in self.backend.rows.values()}, {'main', 'life_intellect'})
        original = next(r for r in self.backend.rows.values() if r['cube'] == 'main')
        fact = next(r for r in self.backend.rows.values() if r['cube'] == 'life_intellect')
        self.assertEqual(original['memory'], 'I am studying sales.\nGood.')
        info = fact['metadata']['info']
        self.assertEqual(info['hermes_author_id'], 'alice')
        self.assertEqual(info['hermes_subject_id'], 'alice')
        self.assertEqual(info['hermes_memory_epoch'], 'test-epoch')
        self.assertEqual(info['hermes_status'], 'observation')
        self.assertTrue(info['hermes_logical_id'])
        self.assertEqual(info['hermes_memberships'], ['life_intellect'])
        self.assertEqual(info['hermes_source_ids'], [original['id']])
        self.assertEqual(self.provider.outbox.status()['pending'], 0)


    def test_scoped_multi_cube_recall_deduplicates_and_forget_removes_all_copies(self):
        self.router_reply([self.fact(spheres=['life_intellect', 'life_work'])])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        facts = [r for r in self.backend.rows.values() if r['cube'] != 'main']
        self.assertEqual(len(facts), 2)
        logical_id = facts[0]['metadata']['info']['hermes_logical_id']
        self.assertEqual({r['metadata']['info']['hermes_logical_id'] for r in facts}, {logical_id})
        for key, field, value in [('foreign-author', 'hermes_author_id', 'bob'),
                                  ('foreign-home', 'hermes_home_scope', 'other-home'),
                                  ('foreign-epoch', 'hermes_memory_epoch', 'old-epoch')]:
            rogue = copy.deepcopy(facts[0])
            rogue['id'] = key
            rogue['metadata']['info'][field] = value
            self.backend.rows[key] = rogue
        self.provider.routing.router.transport = lambda payload: {'cubes': ['life_work']}
        result = json.loads(self.provider.handle_tool_call('memos_search', {'query': 'study sales'}))
        self.assertEqual(len(result['memories']), 1)
        self.assertEqual(result['memories'][0]['logical_id'], logical_id)
        read = json.loads(self.provider.handle_tool_call('memos_read', {'memory_id': facts[1]['id']}))
        self.assertEqual(read['memory']['logical_id'], logical_id)
        self.assertEqual(json.loads(self.provider.handle_tool_call('memos_read', {'memory_id': 'foreign-author'}))['status'], 'not_found')
        forgot = json.loads(self.provider.handle_tool_call('memos_forget', {'memory_id': facts[1]['id']}))
        self.assertEqual(forgot['status'], 'pending')
        self.send()
        self.assertTrue(all(r['id'] not in self.backend.rows for r in facts))
        self.assertTrue(all(key in self.backend.rows for key in ['foreign-author', 'foreign-home', 'foreign-epoch']))
        repeated = json.loads(self.provider.handle_tool_call('memos_forget', {'memory_id': logical_id}))
        self.assertEqual(repeated['status'], 'deleted')


    def test_replace_preserves_logical_identity_moves_memberships_and_replays_safely(self):
        self.router_reply([self.fact(spheres=['life_intellect', 'life_work'])])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        old = next(r for r in self.backend.rows.values() if r['cube'] == 'life_work')
        logical_id = old['metadata']['info']['hermes_logical_id']
        self.router_reply([self.fact(text='I plan to practise.', source={'message_index': 0, 'role': 'user',
            'start': 0, 'end': 19, 'quote': 'I plan to practise.'}, spheres=['life_time'], status='plan')])
        args = {'memory_id': old['id'], 'content': 'I plan to practise.', 'operation_id': 'correction-1'}
        result = json.loads(self.provider.handle_tool_call('memos_replace', args))
        self.assertEqual(result['status'], 'pending')
        self.send()
        current = [r for r in self.backend.rows.values() if r['metadata']['info'].get('hermes_logical_id') == logical_id]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]['cube'], 'life_time')
        self.assertEqual(current[0]['memory'], 'I plan to practise.')
        count = self.backend.add_count
        replay = json.loads(self.provider.handle_tool_call('memos_replace', args))
        self.assertEqual(replay['status'], 'verified')
        self.send()
        self.assertEqual(self.backend.add_count, count)


    def test_admin_handoff_freezes_cleans_rotates_epoch_and_fences_old_session_replay(self):
        self.assertTrue(hasattr(self.provider.routing, 'admin'), 'provider must expose a checked admin entrypoint')
        self.router_reply([self.fact()])
        messages = [{'role': 'user', 'content': 'I am studying sales.'}]
        self.provider.sync_turn('I am studying sales.', '', messages=messages)
        self.send()
        self.provider.sync_turn('queued before handoff', 'reply')
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root', 'managed_cubes': self.provider.routing.catalog.cubes}
        result = admin.handoff(scope, confirmation='PURGE default/root managed', new_epoch='production-test')
        self.assertEqual(result['deployment_phase'], 'production')
        self.assertEqual(result['memory_epoch'], 'production-test')
        self.assertTrue(result['frozen'], 'handoff stays frozen until explicit resume')
        self.assertEqual(self.backend.rows, {})
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        self.assertEqual(self.provider.outbox.status()['verified_events'], 0)
        admin.resume(scope)
        self.provider.on_session_end(messages)
        self.provider.sync_turn('old agent cannot write', 'reply', messages=messages)
        self.send()
        self.assertEqual(self.backend.rows, {})
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        fresh = self.new_provider('session-new', user_id='alice')
        fresh.routing.router.transport = lambda payload: {'facts': []}
        fresh.sync_turn('new production session', '')
        self.send(fresh)
        self.assertEqual(len(self.backend.rows), 1)
        fresh.on_session_switch('session-a')
        fresh.sync_turn('old session replay', '')
        self.send(fresh)
        self.assertEqual(len(self.backend.rows), 1)


    def test_cached_recall_is_revalidated_on_author_and_disabled_config_boundary(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        self.provider.routing.router.transport = lambda payload: {'cubes': ['life_intellect']}
        self.assertIn('studying', self.provider.prefetch('sales study'))
        self.provider.on_turn_start(2, 'same query', author_id='bob')
        self.assertNotIn('I am studying sales.', self.provider.prefetch('sales study'),
                         'cached personal recall must never cross authors')
        self.assertEqual(self.provider.recall_status().count, 0)
        self.provider.on_turn_start(3, 'same query', author_id='alice')
        self.assertIn('studying', self.provider.prefetch('sales study'))
        self.cfg['enabled'] = False
        self.save_config()
        self.assertEqual(self.provider.prefetch('sales study'), '')
        self.provider.sync_turn('disabled must not queue', 'reply')
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        self.assertIsNone(self.provider.recall_status())


    def test_native_correction_and_removal_are_scoped_across_cubes(self):
        old = 'Keep answers short.'
        new = 'Prefer detailed replies.'
        self.router_reply([self.fact(text=old, source={'message_index': 0, 'role': 'user',
             'start': 0, 'end': len(old), 'quote': old}, spheres=['user'], status='preference')])
        self.provider.on_memory_write('add', 'user', old)
        self.send()
        self.assertEqual(len(self.backend.rows), 2)
        self.router_reply([self.fact(text=new, source={'message_index': 0, 'role': 'user',
             'start': 0, 'end': len(new), 'quote': new}, spheres=['user', 'life_intellect'], status='preference')])
        self.provider.on_memory_write('replace', 'user', new, {'previous_content': old})
        self.send()
        self.assertFalse(any(old in r['memory'] for r in self.backend.rows.values()))
        self.assertEqual(len(self.backend.rows), 3)
        self.provider.on_memory_write('remove', 'user', new, {'previous_content': new})
        self.send()
        self.assertEqual(self.backend.rows, {})


    def test_catalog_binding_and_explicit_project_override_add_a_project_axis(self):
        catalog = {'version': 1, 'projects': {'project_demo': {'description': 'Demo'},
                   'project_other': {'description': 'Other'}}, 'session_projects': {'topic-1': 'project_demo'},
                   'shared_infra': False}
        (self.home / 'memos-catalog.json').write_text(json.dumps(catalog))
        p = self.new_provider('session-project', user_id='alice', gateway_session_key='topic-1')
        self.router_reply([self.fact()], p)
        result = json.loads(p.handle_tool_call('memos_remember', {'content': 'I am studying sales.',
                                      'project': 'project_other', 'operation_id': 'remember-1'}))
        self.assertEqual(result['status'], 'pending')
        self.send(p)
        facts = [r for r in self.backend.rows.values() if r['metadata']['info'].get('hermes_kind') == 'fact']
        self.assertEqual({r['cube'] for r in facts}, {'life_intellect', 'project_other'})
        self.assertEqual({tuple(r['metadata']['info']['hermes_projects']) for r in facts}, {('project_other',)})
        count = self.backend.add_count
        replay = json.loads(p.handle_tool_call('memos_remember', {'content': 'I am studying sales.',
                                      'project': 'project_other', 'operation_id': 'remember-1'}))
        self.assertEqual(replay['status'], 'verified')
        self.send(p)
        self.assertEqual(self.backend.add_count, count)
        bad = json.loads(p.handle_tool_call('memos_remember', {'content': 'fact', 'project': 'project_unlisted'}))
        self.assertEqual(bad['status'], 'error')


    def test_cli_prepare_is_scoped_frozen_setup_and_tools_report_epoch(self):
        import argparse
        import contextlib
        import io
        cli = importlib.import_module(self.provider.__class__.__module__.rsplit('.', 1)[0] + '.cli')
        parser = argparse.ArgumentParser()
        cli.register_cli(parser)
        self.assertIn('prepare', parser.format_help())
        args = parser.parse_args(['prepare', '--profile', 'default', '--user-id', 'root', '--managed-cubes',
                                  *self.provider.routing.catalog.cubes])
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            args.func(args)
        result = json.loads(captured.getvalue())
        self.assertEqual(result['deployment_phase'], 'setup')
        self.assertTrue(result['frozen'])
        self.assertEqual(self.backend.calls, [], 'prepare must not create/purge remote cubes')
        status = json.loads(self.provider.handle_tool_call('memos_status', {}))
        self.assertEqual(status['memory_epoch'], 'test-epoch')
        self.assertEqual(status['deployment_phase'], 'setup')
        self.assertTrue(status['frozen'])
        schemas = {s['name']: s for s in self.provider.get_tool_schemas()}
        self.assertIn('memos_replace', schemas)
        self.assertNotIn('project', schemas['memos_remember']['parameters']['required'])
        self.assertIn('project', schemas['memos_remember']['parameters']['properties'])


    def test_router_failure_keeps_original_visible_and_partial_copy_retry_pins_plan(self):
        def unavailable(payload):
            raise self.provider.routing.router.__class__.extract.__globals__['MemOSError']('Router unavailable')
        self.provider.routing.router.transport = unavailable
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        self.assertEqual(len(self.backend.rows), 1)
        original = next(iter(self.backend.rows.values()))
        result = json.loads(self.provider.handle_tool_call('memos_read', {'memory_id': original['id']}))
        self.assertEqual(result['memory']['classification'], 'pending/unclassified')
        self.assertEqual(self.provider.outbox.status()['pending'], 1)
        calls = []
        def router(payload):
            calls.append(payload)
            if 'candidates' in json.loads(payload[-1]['content']):
                return {'reviews':[{'index':0,'keep':True,'spheres':['life_intellect','life_work'],
                                    'supported':True,'standalone':True,'reason':'Synthetic supported fact'}]}
            return {'facts': [self.fact(spheres=['life_intellect', 'life_work'])]}
        self.provider.routing.router.transport = router
        original_request = self.provider.client.request
        def fail_last_copy(path, body=None, **extra):
            if path == '/product/add' and body['writable_cube_ids'] == ['life_work']:
                self.backend.lose_response = True
            return original_request(path, body, **extra)
        self.provider.client.request = fail_last_copy
        self.retry_now()
        self.send()
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.provider.outbox.status()['pending'], 1)
        self.provider.client.request = original_request
        self.provider.routing.router.transport = unavailable
        count = self.backend.add_count
        self.retry_now()
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        self.assertEqual(self.backend.add_count, count, 'lost response may not create a second linked copy')
        self.assertEqual(len(calls), 2)


    def test_freeze_between_recovery_read_and_add_blocks_the_network_write(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        original_request = self.provider.client.request
        def freeze_on_read(path, body=None, **extra):
            response = original_request(path, body, **extra)
            if path == '/product/get_memory':
                self.cfg['frozen'] = True
                self.save_config()
            return response
        self.provider.client.request = freeze_on_read
        self.send()
        self.assertEqual(self.backend.rows, {}, 'reload must run immediately before add, not just before recovery GET')
        self.assertEqual(self.provider.outbox.status()['pending'], 1)
        self.cfg['frozen'] = False
        self.save_config()
        self.provider.client.request = original_request
        self.retry_now()
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 0)


    def test_exact_unique_quote_resolves_model_offset_errors_without_guessing_evidence(self):
        router = self.provider.routing.router
        source = {'message_index': 0, 'role': 'user', 'start': 60, 'end': 121, 'quote': 'I am studying sales.'}
        self.router_reply([self.fact(source=source)])
        rows = [{'role': 'user', 'content': 'Unrelated introduction.'}, {'role': 'user', 'content': 'I am studying sales.'}]
        try:
            facts = router.extract(rows)
        except Exception as error:
            self.fail('Verbatim unique evidence must be anchored deterministically: ' + type(error).__name__)
        self.assertEqual(facts[0]['source'], {'message_index': 1, 'role': 'user', 'start': 0,
                         'end': len(rows[1]['content']), 'quote': rows[1]['content']})
        with self.assertRaises(RuntimeError):
            router.extract(rows + [rows[1]])
        router.transport = lambda payload: {'facts': [self.fact(status='verified_done')]}
        with self.assertRaises(RuntimeError):
            router.extract([rows[1]])
        router.transport = lambda payload: {'facts': [self.fact(source={**source, 'quote': 'not in source'})]}
        with self.assertRaises(RuntimeError):
            router.extract(rows)


    def test_repeat_operation_id_with_changed_payload_is_rejected_not_false_verified(self):
        self.router_reply([self.fact()])
        args = {'content': 'I am studying sales.', 'operation_id': 'immutable-request'}
        self.assertEqual(json.loads(self.provider.handle_tool_call('memos_remember', args))['status'], 'pending')
        self.send()
        changed = json.loads(self.provider.handle_tool_call('memos_remember', {**args, 'content': 'A different claim.'}))
        self.assertEqual(changed['status'], 'error', 'stable request IDs may not acknowledge a different payload')
        self.assertEqual(self.provider.outbox.status()['pending'], 0)


    def test_rejected_material_requires_explicit_archive_search(self):
        self.router_reply([])
        self.provider.sync_turn('An uncertain neutral note.', '')
        self.send()
        self.provider.routing.router.transport = lambda payload: {'cubes': []}
        result = json.loads(self.provider.handle_tool_call('memos_search', {'query': 'uncertain note'}))
        self.assertEqual(result['memories'], [], 'unclassified dialogue is not a useful fact')
        result = json.loads(self.provider.handle_tool_call('memos_search', {'query': 'uncertain note', 'include_archive': True}))
        self.assertEqual(len(result['memories']), 1, 'the transcript remains available explicitly')
        self.assertEqual(result['memories'][0]['classification'], 'unclassified')
        self.assertEqual(result['memories'][0]['cube_id'], 'main')


    def test_handoff_cutoff_blocks_delayed_old_sessions_from_canonical_store(self):
        import sqlite3
        from contextlib import closing
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root', 'managed_cubes': self.provider.routing.catalog.cubes}
        admin.handoff(scope, 'PURGE default/root managed', new_epoch='cutoff-test')
        admin.resume(scope)
        with closing(sqlite3.connect(self.home / 'state.db')) as db, db:
            db.execute('CREATE TABLE sessions(id TEXT, started_at REAL)')
            db.execute('INSERT INTO sessions VALUES (?, ?)', ('late-persisted-old-session', 1))
        p = self.new_provider('late-persisted-old-session', user_id='alice')
        p.routing.router.transport = lambda payload: {'facts': []}
        p.sync_turn('historical replay', '')
        self.send(p)
        self.assertEqual(self.backend.rows, {}, 'canonical old started_at must fence unseen delayed sessions')


    def test_shared_infra_is_explicit_read_only_across_authors(self):
        catalog = {'version': 1, 'projects': {}, 'session_projects': {}, 'shared_infra': True}
        (self.home / 'memos-catalog.json').write_text(json.dumps(catalog))
        text = 'Service listens on localhost.'
        p = self.new_provider('shared-session', user_id='bob')
        self.router_reply([self.fact(text=text, source={
            'message_index': 0, 'role': 'user', 'start': 0, 'end': len(text), 'quote': text},
            spheres=['infra', 'life_systems'])], p)
        result = json.loads(p.handle_tool_call('memos_remember', {'content': text + ' A private unrelated note.', 'shared_infra': True}))
        self.assertEqual(result['status'], 'pending')
        self.send(p)
        infra = next(r for r in self.backend.rows.values() if r['cube'] == 'infra')
        self.assertTrue(infra['metadata']['info'].get('hermes_shared_infra'))
        self.provider.routing.router.transport = lambda payload: {'cubes': ['infra']}
        search = json.loads(self.provider.handle_tool_call('memos_search', {'query': 'service address'}))
        self.assertEqual([r['author_id'] for r in search['memories']], ['bob'])
        read = json.loads(self.provider.handle_tool_call('memos_read', {'memory_id': infra['id'], 'include_transcript': True}))
        self.assertEqual(read['transcript'], [{'role': 'user', 'content': text}], 'shared evidence must not expose private transcript')
        denied = json.loads(self.provider.handle_tool_call('memos_forget', {'memory_id': infra['id']}))
        self.assertEqual(denied['status'], 'error', 'sharing recall never grants cross-author deletion')
        self.assertIn(infra['id'], self.backend.rows)


    def test_legacy_session_cannot_bypass_new_policy_after_dynamic_prepare(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        archive = next(r for r in self.backend.rows.values() if r['cube'] == 'main')
        self.cfg['routing_enabled'] = False
        self.save_config()
        legacy_session = self.new_provider('legacy', user_id='bob')
        schema_before = copy.deepcopy(legacy_session.get_tool_schemas())
        self.cfg['routing_enabled'] = True
        self.save_config()
        result = json.loads(legacy_session.handle_tool_call('memos_read', {'memory_id': archive['id']}))
        self.assertEqual(result['status'], 'error', 'a legacy session may not bypass author/home/epoch policy')
        status = json.loads(legacy_session.handle_tool_call('memos_status', {}))
        self.assertEqual(status['memory_epoch'], 'test-epoch')
        self.assertEqual(legacy_session.get_tool_schemas(), schema_before, 'tool schema is immutable until a new session')
        legacy_session.sync_turn('legacy blocked', '')
        self.assertEqual(self.provider.outbox.status()['pending'], 0)


    def test_router_output_is_scrubbed_before_persistence_and_delivery(self):
        secret = 'sk-' + 'aB9x' * 12
        self.router_reply([self.fact(text='I am studying sales. API_KEY=' + secret)])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        self.assertNotIn(secret, json.dumps(self.backend.rows), 'router output must obey the persistence secret boundary')


    def test_production_cannot_be_selected_without_a_completed_handoff(self):
        self.cfg['deployment_phase'] = 'production'
        self.save_config()
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        self.assertEqual(self.backend.rows, {}, 'production must require the durable completed handoff gate')
        self.assertEqual(self.provider.outbox.status()['pending'], 0)


if __name__ == '__main__':
    unittest.main()

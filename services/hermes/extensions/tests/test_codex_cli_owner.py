# ABOUTME: Проверяет единственного credential owner без живого OAuth или запросов модели.
# ABOUTME: Использует только временные credentials и настоящий stdlib helper.
import asyncio
import base64
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('owner', Path(__file__).parents[1] / 'tools/codex_cli_owner.py')
owner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(owner)


def token(expiry, account='fixture'):
    claims = {'exp': expiry, 'https://api.openai.com/auth': {'chatgpt_account_id': account}}
    return 'header.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.signature'


class OwnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name); codex = home / '.codex'; codex.mkdir(mode=0o700)
        for name, value in {'HOME':home, 'CODEX_HOME':codex, 'LOCK':codex/'lock'}.items():
            patch = mock.patch.object(owner, name, value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.dict(os.environ, {'HOME':str(home), 'CODEX_HOME':str(codex)});patch.start();self.addCleanup(patch.stop)
        self.write(int(time.time())+3600)

    def write(self, expiry, account='fixture', token_account='fixture'):
        path=owner.CODEX_HOME/'auth.json'
        path.write_text(json.dumps({'tokens':{'access_token':token(expiry,token_account),'account_id':account,'refresh_token':'never-export-this-refresh'}}))
        path.chmod(0o600)

    def test_access_only_without_native_store_or_refresh(self):
        with mock.patch.object(owner, 'refresh', side_effect=AssertionError('no refresh')):
            result=owner.resolve()
        self.assertEqual(result['source'], 'codex-cli-single-owner')
        self.assertEqual(result['base_url'],owner.BASE_URL)
        self.assertEqual(result['account_id'],'fixture')
        self.assertNotIn('refresh_token',result)
        self.assertNotIn('never-export',repr(result))
        self.assertFalse(owner.LOCK.exists())

    def test_readonly_never_refreshes_even_when_forced(self):
        with mock.patch.object(owner,'refresh',side_effect=AssertionError('readonly')):
            owner.resolve(read_only=True,force_refresh=True)
            self.write(int(time.time())-1)
            with self.assertRaisesRegex(owner.OwnerError,'CODEX_OWNER_ACCESS_EXPIRED'):
                owner.resolve(read_only=True,force_refresh=True)
        self.assertFalse(owner.LOCK.exists())

    def test_expired_refresh_only_via_codex_owner(self):
        self.write(int(time.time())-1)
        def renew(_): self.write(int(time.time())+7200)
        with mock.patch.object(owner,'refresh',side_effect=renew) as refresh:
            result=owner.resolve()
        refresh.assert_called_once()
        self.assertGreater(result['expires_at'],time.time())
        self.assertEqual(owner.LOCK.stat().st_mode & 0o777,0o600)

    def test_401_force_refresh_does_not_reuse_rejected_token(self):
        with mock.patch.object(owner,'refresh') as refresh:
            with self.assertRaisesRegex(owner.OwnerError,'CODEX_OWNER_REFRESH_REJECTED'):
                owner.resolve(force_refresh=True)
        refresh.assert_called_once()
        with mock.patch.object(owner,'refresh',side_effect=lambda _:self.write(int(time.time())+7200)):
            owner.resolve(force_refresh=True)

    def test_refresh_failure_has_no_native_fallback_or_secret_error(self):
        self.write(int(time.time())-1)
        with mock.patch.object(owner,'refresh',side_effect=RuntimeError('never-export-this-refresh')):
            with self.assertRaisesRegex(owner.OwnerError,'^CODEX_OWNER_UNAVAILABLE$'):
                owner.resolve()

    def test_account_binding_rejects_wrong_header_identity(self):
        self.write(int(time.time())+3600,account='other')
        with self.assertRaises(owner.OwnerError): owner.resolve()

    def test_metadata_and_shared_home_rejected(self):
        path=owner.CODEX_HOME/'auth.json'
        for mode in (0o644,0o640):
            path.chmod(mode)
            with self.assertRaises(owner.OwnerError): owner.resolve()
        path.chmod(0o600)
        os.link(path,owner.CODEX_HOME/'hardlink')
        with self.assertRaises(owner.OwnerError):owner.resolve()
        (owner.CODEX_HOME/'hardlink').unlink()
        path.rename(owner.CODEX_HOME/'real');path.symlink_to('real')
        with self.assertRaises(owner.OwnerError):owner.resolve()
        with mock.patch.dict(os.environ,{'HOME':'/root'}):
            with self.assertRaises(owner.OwnerError):owner.resolve()

    def test_lock_timeout_does_not_release_other_owner(self):
        with owner.owner_lock():
            with self.assertRaisesRegex(owner.OwnerError,'CODEX_OWNER_BUSY'):
                with owner.owner_lock(timeout=0):pass
        with owner.owner_lock(timeout=0):pass

    def test_async_wait_cancellation_and_eventloop_progress(self):
        async def exercise():
            with owner.owner_lock():
                async def waiting():
                    async with owner.owner_lock_async(): pass
                task=asyncio.create_task(waiting())
                await asyncio.sleep(0.01)
                self.assertFalse(task.done())
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):await task
            async with owner.owner_lock_async(timeout=0):pass
        asyncio.run(exercise())

    def test_real_stdio_refresh_rpc_contains_no_credentials_or_login(self):
        binary=owner.HOME/'fake-codex'
        binary.write_text('''#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if r.get('method')=='initialize': print(json.dumps({'id':r['id'],'result':{}}),flush=True)
 elif r.get('method')=='account/read':
  assert r['params']=={'refreshToken':True}
  print(json.dumps({'id':r['id'],'result':{'account':{'type':'chatgpt'}}}),flush=True)
 elif r.get('method')!='initialized': raise SystemExit(8)
''');binary.chmod(0o700)
        with mock.patch.object(owner,'BINARY',binary):owner.refresh(time.monotonic()+3)

    def test_stdio_timeout_is_bounded_and_child_reaped(self):
        binary=owner.HOME/'fake-codex'
        binary.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(30)\n');binary.chmod(0o700)
        with mock.patch.object(owner,'BINARY',binary):
            with self.assertRaisesRegex(owner.OwnerError,'CODEX_OWNER_TIMEOUT'):
                owner.refresh(time.monotonic()+0.1)


if __name__=='__main__': unittest.main()

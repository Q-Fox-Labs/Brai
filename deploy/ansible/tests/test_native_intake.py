# ABOUTME: Проверяет owner-only intake PROD на синтетических Telegram-подписях.
# ABOUTME: Не обращается к Telegram/Groq и не читает существующие секреты.
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

FILES=Path(__file__).resolve().parents[1]/'roles/brai_install/files'
sys.path.insert(0,str(FILES))
import hermes_intake as intake
import native_hermes as native

BOT='fixture-token'
OWNER=123456
KEY='gsk_'+'Z'*48
ORIGIN='https://client.example.invalid'


def signed(owner=OWNER,age=0,token=BOT):
    data={'auth_date':str(int(time.time())-age),'query_id':'fixture','user':json.dumps({'id':owner})}
    secret=hmac.new(b'WebAppData',token.encode(),hashlib.sha256).digest()
    data['hash']=hmac.new(secret,'\n'.join(key+'='+value for key,value in sorted(data.items())).encode(),hashlib.sha256).hexdigest()
    return urlencode(data)


class NativeIntake(unittest.TestCase):
    def test_real_http_serves_assets_and_rejects_unauthenticated_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            app=intake.IntakeApplication(BOT,OWNER,str(Path(temporary)/'secrets'),ORIGIN,validator=lambda key:False)
            with intake.make_server(app,'127.0.0.1',0) as server:
                thread=threading.Thread(target=server.serve_forever);thread.start()
                try:
                    native.verify_intake({'intake':{'bind':'127.0.0.1','port':server.server_address[1],'origin':ORIGIN}})
                finally:
                    server.shutdown();thread.join(timeout=5)
    def test_owner_signature_and_freshness_are_required(self):
        self.assertEqual(intake.validate_init_data(signed(),BOT,OWNER,time.time()),OWNER)
        for raw in [signed(owner=OWNER+1),signed(age=601),signed(token='wrong'),signed()+'&user=duplicate']:
            with self.assertRaises(intake.Denied):intake.validate_init_data(raw,BOT,OWNER,time.time())

    def test_single_use_form_saves_only_new_key_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temporary:
            secret=Path(temporary)/'secrets'
            app=intake.IntakeApplication(BOT,OWNER,str(secret),ORIGIN,validator=lambda key:key==KEY)
            status,_,data=app.post('/connect/groq/authorize',{'init_data':signed()})
            self.assertEqual(status,200)
            request={'init_data':signed(),'operation_token':data['operation_token'],'api_key':KEY}
            self.assertEqual(app.post('/connect/groq/submit',request)[0],200)
            self.assertEqual((secret/'groq.env').read_text(),'GROQ_API_KEY='+KEY+'\n')
            self.assertEqual((secret/'groq.env').stat().st_mode&0o777,0o600)
            self.assertNotEqual(app.post('/connect/groq/submit',request)[0],200)
            _,_,second=app.post('/connect/groq/authorize',{'init_data':signed()})
            request['operation_token']=second['operation_token']
            self.assertEqual(app.post('/connect/groq/submit',request)[0],409)
            self.assertEqual((secret/'groq.env').read_text(),'GROQ_API_KEY='+KEY+'\n')

    def test_unverified_key_or_other_owner_cannot_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            app=intake.IntakeApplication(BOT,OWNER,str(Path(temporary)/'secrets'),ORIGIN,validator=lambda key:False)
            self.assertNotEqual(app.post('/connect/groq/authorize',{'init_data':signed(owner=OWNER+1)})[0],200)
            _,_,data=app.post('/connect/groq/authorize',{'init_data':signed()})
            self.assertNotEqual(app.post('/connect/groq/submit',{'init_data':signed(),'operation_token':data['operation_token'],'api_key':KEY})[0],200)
            self.assertFalse((Path(temporary)/'secrets/groq.env').exists())

    def test_config_accepts_client_origin_but_rejects_dev_bind_and_broad_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'intake.json'
            config={'owner_id':OWNER,'bind':'172.23.42.1','port':19379,'origin':ORIGIN,'secret_dir':'/etc/brai/hermes/secrets'}
            path.write_text(json.dumps(config));path.chmod(0o600)
            self.assertEqual(intake.load_config(path),config)
            path.chmod(0o640)
            with self.assertRaises(intake.Denied):intake.load_config(path)
            path.chmod(0o600);config['bind']='192.168.16.1';path.write_text(json.dumps(config))
            with self.assertRaises(intake.Denied):intake.load_config(path)

    def test_token_is_injected_without_reading_a_dotenv(self):
        with patch.dict(os.environ,{'BRAI_AI_BOT_TOKEN':BOT},clear=True),patch.object(intake,'read_regular') as read:
            self.assertEqual(intake.environment_bot_token(),BOT);read.assert_not_called()
        with patch.dict(os.environ,{'BOT_TOKEN':BOT,'TELEGRAM_BOT_TOKEN':'conflict'},clear=True):
            with self.assertRaises(intake.Denied):intake.environment_bot_token()


if __name__=='__main__':unittest.main()

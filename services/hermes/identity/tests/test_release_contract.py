# ABOUTME: Проверяет версионированный ingress contract до любой установки polling.
# ABOUTME: Моделирует несовместимые provider без запуска служб и данных.
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from identity import native_ingress


class ContractTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'release-contract.json'
        self.resolver=Mock(side_effect=LookupError('synthetic resolver reached'))
        self.ctx=SimpleNamespace(register_telegram_handler=lambda factory:setattr(self.ctx,'factory',factory),
                                 on_unload=lambda close:None)
        self.app=SimpleNamespace()
        self.adapter=SimpleNamespace(gateway_runner=SimpleNamespace(_hm_admit_event=lambda event:None))
        native_ingress.register(self.ctx,build_resolver=self.resolver,admit_update=lambda *args:None)

    def test_old_missing_or_incompatible_provider_fails_before_resolver_or_poll(self):
        cases=[None,{}, {'version':1,'profileGate':2,'telegramInbox':2,'routingIndex':2,'legacyJournal':1},
               {**native_ingress.RELEASE_CONTRACT,'routingIndex':True},
               {**native_ingress.RELEASE_CONTRACT,'extra':1}, 'not-json',
               '{"version":1,"version":2,"profileGate":2,"telegramInbox":2,"routingIndex":2,"legacyJournal":1}']
        for value in cases:
            with self.subTest(value=value):
                if self.path.exists(): self.path.unlink()
                if value is not None:
                    self.path.write_text(value if isinstance(value,str) else json.dumps(value))
                with patch.object(native_ingress,'RELEASE_CONTRACT_PATH',self.path):
                    with self.assertRaises(RuntimeError): self.ctx.factory(self.app,self.adapter)
                self.resolver.assert_not_called()
                self.assertFalse(hasattr(self.adapter,'_brai_identity_dispatch'))

    def test_exact_v2_contract_reaches_existing_factory_path(self):
        self.path.write_text(json.dumps(native_ingress.RELEASE_CONTRACT))
        with patch.object(native_ingress,'RELEASE_CONTRACT_PATH',self.path):
            with self.assertRaisesRegex(LookupError,'resolver reached'):
                self.ctx.factory(self.app,self.adapter)
        self.resolver.assert_called_once_with(self.adapter,self.adapter.gateway_runner)

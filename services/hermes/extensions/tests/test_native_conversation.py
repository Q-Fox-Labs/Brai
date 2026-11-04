# ABOUTME: Проверяет overlay на настоящем закреплённом native движке и SessionDB.
# ABOUTME: Все данные временные, модель и транспорт подменены; рабочий gateway не запускается.
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[4]
ENGINE=os.environ.get("BRAI_NATIVE_ENGINE")
if ENGINE:
    sys.path.insert(0,ENGINE)
    from hermes_state import SessionDB
    from tools import approval
    from tools import approval_conversation as consent

@unittest.skipUnless(ENGINE,"BRAI_NATIVE_ENGINE points to a patched isolated native fixture")
class NativeConsentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=ROOT/"tmp")
        self.db=SessionDB(Path(self.temp.name)/"state.db")
        self.source=types.SimpleNamespace(platform=types.SimpleNamespace(value="telegram"),profile="dev",chat_id="test-chat",thread_id="test-topic",user_id="alice",is_bot=False)
        self.config=patch.object(approval.approval_context,"_get_approval_config",return_value={"interaction":"conversation"})
        self.config.start()
    def tearDown(self):
        self.config.stop()
        self.db.close()
        self.temp.cleanup()
    def invoke(self,spec=None):
        return approval._human_decision(spec or approval._COMMAND_GATE,command="python -c 'print(1)'",
            description="script execution",pattern_key="python",pattern_keys=["python"],
            session_key="test-session",approval_callback=None,is_cli=False,is_gateway=True,is_ask=False,smart=True)
    def test_gate_precedes_every_legacy_transport(self):
        review={"decision":"needs_consent","effects_known":True,"target":"Папка Поездка","consequences":"Фотографии будут удалены без восстановления.","reason":"Удаление не поручалось."}
        with patch.object(consent,"review_action",return_value=review),patch.object(approval,"_await_gateway_decision",side_effect=AssertionError("legacy wait")),patch.object(approval,"_present_with_selected_transport",side_effect=AssertionError("legacy UI")):
            with consent.turn_scope(self.db,self.source,"test-session","Подготовь список одежды","1"),consent.tool_scope("terminal",{"command":"python -c 'print(1)'"},"tool"):
                for spec in (approval._COMMAND_GATE,approval._EXECUTE_CODE_GATE,approval._ACTION_GATE):
                    with self.subTest(noun=spec.noun):
                        result=self.invoke(spec)
                        self.assertEqual(result["status"],"needs_consent")
        self.assertEqual(result["status"],"needs_consent")
        row=consent.Store(self.db).query(consent.conversation_key(self.source))
        self.assertEqual(row["status"],"pending")
    def test_smart_allow_does_not_create_pending_record(self):
        with patch.object(consent,"review_action",return_value={"decision":"allow","effects_known":True}):
            with consent.turn_scope(self.db,self.source,"test-session","Посчитай","1"),consent.tool_scope("terminal",{},"tool"):
                self.assertTrue(self.invoke()["approved"])
        self.assertIsNone(consent.Store(self.db).query(consent.conversation_key(self.source)))
    def test_busy_and_idle_ingress_use_same_durable_answer(self):
        store=consent.Store(self.db)
        scope=consent.Scope(self.db,consent.conversation_key(self.source),"alice","test-session","Проверь папку","1")
        row=store.prepare(scope,{"command":"remove trip"},{"decision":"needs_consent"},"Удалить фотографии?")
        store.delivered(row["id"],"10")
        runner=types.SimpleNamespace(_session_key_for_source=lambda _:"test-session",session_store=types.SimpleNamespace(_db_for_key=lambda _:self.db))
        import time
        event=types.SimpleNamespace(source=self.source,internal=False,allow_gateway_control=False,message_id="11",text="да",timestamp=time.time()+1,reply_to_message_id="10")
        self.assertIsNone(consent.gateway_input(runner,event,event))
        self.assertEqual(store.query(scope.key)["status"],"authorized")
    def test_direct_wait_has_no_transport_or_five_minute_block(self):
        from tools.approval_gateway_wait import _await_gateway_decision
        notifier=unittest.mock.Mock(side_effect=AssertionError("legacy notification"))
        result=_await_gateway_decision("test-session",notifier,{"command":"opaque"})
        self.assertEqual(result["cancelled"],"conversation")
        notifier.assert_not_called()

    def test_nested_unavailable_result_halts_with_plain_native_response(self):
        from run_agent import AIAgent
        decisions=[]
        agent=types.SimpleNamespace(_set_tool_guardrail_halt=decisions.append)
        with consent.turn_scope(self.db,self.source,"test-session","Проверь папку","1"),consent.tool_scope("execute_code",{},"tool"):
            with patch.object(consent,"review_action",side_effect=TimeoutError()):
                result=consent.gate("private-command")
            consent.halt_if_needed(agent,{"nested":{"error":result}})
        self.assertEqual(len(decisions),1)
        text=AIAgent._toolguard_controlled_halt_response(agent,decisions[0])
        self.assertEqual(text,result["message"])
        self.assertNotIn("private-command",text)

    def test_child_worker_inherits_authenticated_context(self):
        import contextvars
        from concurrent.futures import ThreadPoolExecutor
        with consent.turn_scope(self.db,self.source,"test-session","Посчитай","1") as scope:
            with ThreadPoolExecutor(max_workers=1) as pool:
                child=pool.submit(contextvars.copy_context().run,consent._scope.get).result()
        self.assertIs(child,scope)
        self.assertEqual(child.owner,"alice")

    def test_native_localization_brands_english_and_fallback_without_changing_values(self):
        from agent import i18n
        for language in ("en","ru"):
            with patch.object(i18n,"_load_catalog",side_effect=lambda lang,home: {"fixture":"Hermes Agent: {value}"} if lang=="en" else {}):
                self.assertEqual(i18n.t("fixture",lang=language,value="hermes config"),"Brai: hermes config")

    def test_old_callback_never_grants_consent(self):
        self.assertEqual(approval.resolve_gateway_approval("test-session","always"),0)
    def test_unbound_child_has_no_technical_fallback(self):
        with patch.object(approval,"_present_with_selected_transport",side_effect=AssertionError("legacy UI")):
            self.assertEqual(self.invoke()["status"],"review_unavailable")

if __name__=="__main__":
    unittest.main()

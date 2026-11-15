# ABOUTME: Проверяет overlay на настоящем закреплённом native движке и SessionDB.
# ABOUTME: Все данные временные, модель и транспорт подменены; рабочий gateway не запускается.
import os
import asyncio
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
    sys.path.insert(0,str(ROOT/'services/hermes'))
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

    def test_native_mcp_transport_error_preserves_unknown_execution(self):
        import time
        from tools.mcp_tool_handlers import _render_call_tool_result
        tool = 'mcp__brai__publish_file'
        args = {'path':str(Path(self.temp.name)/'report.xlsx'), 'requestId':'fixture'}
        review = {'decision':'needs_consent','effects_known':True,
            'target':'Отчёт','consequences':'Файл будет опубликован.','reason':'Нужно согласие.'}
        store = consent.Store(self.db)
        key = consent.conversation_key(self.source)
        with consent.turn_scope(self.db,self.source,'test-session','Подготовь файл','1'):
            with consent.tool_scope(tool,args,'prepare'):
                with patch.object(consent,'review_action',return_value=review):
                    consent.gate(tool)
        row = store.query(key)
        store.delivered(row['id'],'10')
        self.assertEqual(store.answer(key,'alice','11','да',time.time()+1,'10'),'authorized')
        calls = []
        @consent.conversation_tool
        def execute(agent, **kwargs):
            self.assertTrue(consent.gate(tool)['approved'])
            calls.append(True)
            result = _render_call_tool_result(types.SimpleNamespace(isError=True,
                content=[types.SimpleNamespace(type='text',text='Broker unavailable')]),'fixture')
            return types.SimpleNamespace(result=result)
        with consent.turn_scope(self.db,self.source,'test-session','да','11'):
            execute(types.SimpleNamespace(),function_name=tool,function_args=args,
                tool_call_id='actual',effective_task_id='fixture')
        self.assertEqual(store.query(key)['status'],'unknown')
        with consent.turn_scope(self.db,self.source,'test-session','Что получилось?','12'):
            with consent.tool_scope(tool,args,'retry'):
                self.assertEqual(consent.gate(tool)['status'],'execution_unknown')
        self.assertEqual(len(calls),1)

    def test_native_round_presents_brai_question_without_technical_status(self):
        from agent import turn_tool_round as rounds
        from unittest.mock import Mock
        for code in ('brai_conversation', 'policy_block'):
            with self.subTest(code=code):
                decision=types.SimpleNamespace(code=code,tool_name='terminal')
                agent=types.SimpleNamespace(quiet_mode=True,verbose_logging=False,
                    valid_tool_names={'terminal'},_tool_guardrail_halt_decision=None,
                    _cap_delegate_task_calls=lambda calls:calls,
                    _deduplicate_tool_calls=lambda calls:calls,
                    _flush_messages_to_session_db=Mock(return_value=True),
                    _emit_interim_assistant_message=Mock(),
                    _emit_diagnostic_status=Mock(),_safe_print=Mock(),
                    stream_delta_callback=Mock(),
                    _toolguard_controlled_halt_response=lambda _: 'Разрешаете это действие?')
                def execute(*_):
                    agent._tool_guardrail_halt_decision=decision
                agent._execute_tool_calls=Mock(side_effect=execute)
                message=types.SimpleNamespace(tool_calls=[types.SimpleNamespace(
                    function=types.SimpleNamespace(name='terminal',arguments='{}'))])
                rows=[]
                with patch.object(rounds,'validate_tool_calls',return_value=types.SimpleNamespace(
                        action='execute',mixed_invalid_batch=False)), \
                        patch.object(rounds,'normalize_provider_tool_call_ids'), \
                        patch.object(rounds,'stage_tool_call_message',return_value=(
                            {'role':'assistant','content':None},False)), \
                        patch.dict(sys.modules,{
                            'agent.conversation_loop':types.SimpleNamespace(_invalid_tool_name_error_content=lambda *_:'invalid'),
                            'agent.tool_call_batches':types.SimpleNamespace(expand_local_tool_batches=lambda calls,**_:calls),
                            'hermes_cli.observability.shared_metrics_harness':types.SimpleNamespace(finish_tool_round=lambda _:None)}):
                    result=rounds.run_tool_round(agent,assistant_message=message,finish_reason='tool_calls',
                        messages=rows,conversation_history=[],api_call_count=1,effective_task_id='fixture',
                        user_message='Проверь',system_message='',active_system_prompt='',
                        compression_attempts=0,max_compression_attempts=1,final_response='',failed=False,
                        _turn_exit_reason='',truncated_tool_call_retries=0,current_turn_user_idx=0)
                self.assertEqual(result.action,'break')
                self.assertEqual(result.final_response,'Разрешаете это действие?')
                self.assertEqual(rows[-1]['content'],result.final_response)
                agent._execute_tool_calls.assert_called_once()
                if code=='brai_conversation':
                    agent._emit_diagnostic_status.assert_not_called()
                else:
                    agent._emit_diagnostic_status.assert_called_once()
                    self.assertIn('policy_block',agent._emit_diagnostic_status.call_args.args[0])
                self.assertEqual(sum(call.args==(result.final_response,)
                    for call in agent.stream_delta_callback.call_args_list),1)

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

    def _ipc_fixture(self, *, result=None, before_reply=None):
        """Собрать настоящий IPC adapter с временным FileStore и локальным transport port."""
        from gateway.config import Platform, PlatformConfig
        from files import native
        from files.tests.test_files import Backend
        from identity.adapter import make_adapter
        root=Path(self.temp.name)
        native.configure({'ownerId':'owner','account':'fixture','stateRoot':str(root/'files-state'),
            'resultRoot':str(root/'files-cache'),'readRoots':[str(root)]},Backend(root/'backend'))
        stub=patch.dict(sys.modules,{'brai_files':native})
        stub.start()
        self.addCleanup(stub.stop)
        calls=[]
        async def send(method, params):
            calls.append(params)
            if before_reply is not None:
                before_reply()
            return result if result is not None else {'success':True,'message_id':str(10+len(calls))}
        adapter=make_adapter(PlatformConfig(),Platform.TELEGRAM,
            types.SimpleNamespace(call=send),None)
        self.source.platform=Platform.TELEGRAM
        self.source.user_id='123'
        self.source.chat_type='dm'
        self.source.chat_name=''
        runner=types.SimpleNamespace(_session_key_for_source=lambda _:'key',
            session_store=types.SimpleNamespace(_db_for_key=lambda _:self.db),
            _brai_consent_generation=lambda _:0)
        adapter.gateway_runner=runner
        adapter.bind_source(self.source)
        return adapter,runner,calls

    def test_stream_receipt_arms_question_before_turn_completion(self):
        from gateway.stream_consumer import GatewayStreamConsumer,StreamConsumerConfig
        import time
        adapter,runner,calls=self._ipc_fixture()
        store=consent.Store(self.db)
        scope=consent.Scope(self.db,consent.conversation_key(self.source),'123',
            'test-session','Проверь папку','1',generation=0)
        row=store.prepare(scope,{'command':'remove synthetic file'},
            {'decision':'needs_consent'},'Папка: файл будет удалён. Разрешаете это действие?')
        async def run():
            stream=GatewayStreamConsumer(adapter,self.source.chat_id,
                config=StreamConsumerConfig(edit_interval=.001,transport='edit'),
                metadata={'thread_id':self.source.thread_id})
            stream.on_delta(row['question'])
            stream.finish(row['question'])
            await asyncio.wait_for(stream.run(),5)
            self.assertTrue(stream.final_response_sent)
            self.assertEqual(store.query(scope.key)['question_message_id'],stream.message_id)
            self.assertEqual(store.answer(scope.key,'123','99','Разрешаю это действие',
                time.time()+1,stream.message_id,generation=0),'authorized')
        asyncio.run(run())
        self.assertEqual(sum(call['action']=='send' for call in calls),1)

    def test_worker_records_busy_clarification_before_native_dispatch(self):
        from identity.worker import Worker
        from unittest.mock import AsyncMock
        adapter,runner,calls=self._ipc_fixture()
        worker=Worker(os.getuid()+1,'owner','123',None)
        worker.chat_snapshot_ready=True
        worker.chat_states[(self.source.chat_id,self.source.thread_id)]={
            'paused':False,'generation':0,'recoveryBlocked':False}
        worker.runner=runner
        worker.ensure_tools=AsyncMock()
        worker.ensure_user_policy=AsyncMock()
        from gateway.session import SessionSource
        data=dict(source={'platform':'telegram','user_id':'123','chat_id':self.source.chat_id,
            'thread_id':self.source.thread_id,'chat_type':'dm','profile':'dev'},
            text='Долю сделай 10%',message_id='2',chat_generation=0)
        actual_source=SessionSource.from_dict(data['source'])
        key=adapter._source_session_key(actual_source)
        runner._session_key_for_source=lambda _:key
        received=[]
        async def busy(message, session_key):
            self.assertEqual(session_key,key)
            received.extend(consent.Store(self.db).requests(
                consent.conversation_key(message.source),'123',0))
            message._gateway_accepted=True
            return True
        async def run():
            adapter.set_message_handler(AsyncMock(side_effect=AssertionError('idle path')))
            adapter.set_busy_session_handler(busy)
            adapter._active_sessions[key]=asyncio.Event()
            worker.adapter=adapter
            return await worker.dispatch(data,'owner')
        self.assertTrue(asyncio.run(run())['accepted'])
        self.assertEqual(received,[{'message_id':'2','text':'Долю сделай 10%'}])

    def test_transport_failure_missing_receipt_and_foreign_topic_do_not_arm_question(self):
        result={'success':False,'message_id':'11'}
        adapter,runner,calls=self._ipc_fixture(result=result)
        store=consent.Store(self.db)
        scope=consent.Scope(self.db,consent.conversation_key(self.source),'123',
            'test-session','Проверь папку','1',generation=0)
        row=store.prepare(scope,{'command':'remove synthetic file'},
            {'decision':'needs_consent'},'Папка: удалить файл?')
        async def run():
            await adapter.send(self.source.chat_id,row['question'],metadata={'thread_id':self.source.thread_id})
            self.assertIsNone(store.query(scope.key)['delivered_at'])
            result.clear()
            result['success']=True
            await adapter.send(self.source.chat_id,row['question'],metadata={'thread_id':self.source.thread_id})
            self.assertIsNone(store.query(scope.key)['delivered_at'])
            result['message_id']='12'
            await adapter.send(self.source.chat_id,row['question'],metadata={'thread_id':'other'})
            await adapter.edit_message(self.source.chat_id,'12',row['question'],finalize=False)
            self.assertIsNone(store.query(scope.key)['delivered_at'])
            await adapter.send(self.source.chat_id,row['question'],metadata={'thread_id':self.source.thread_id})
            self.assertEqual(store.query(scope.key)['question_message_id'],'12')
        asyncio.run(run())

    def test_question_replaced_during_send_cannot_inherit_receipt(self):
        replacement=[]
        store=consent.Store(self.db)
        def replace():
            store.invalidate(row['id'])
            replacement.append(store.prepare(scope,{'command':'other action'},
                {'decision':'needs_consent'},row['question']))
        adapter,runner,calls=self._ipc_fixture(before_reply=replace)
        scope=consent.Scope(self.db,consent.conversation_key(self.source),'123',
            'test-session','Проверь папку','1',generation=0)
        row=store.prepare(scope,{'command':'remove synthetic file'},
            {'decision':'needs_consent'},'Папка: удалить файл?')
        asyncio.run(adapter.send(self.source.chat_id,row['question'],
            metadata={'thread_id':self.source.thread_id}))
        current=store.query(scope.key)
        self.assertEqual(current['id'],replacement[0]['id'])
        self.assertIsNone(current['delivered_at'])

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

    def test_missing_profile_config_never_enters_legacy_transport(self):
        with patch.object(approval.approval_context,"_get_approval_config",return_value={}),patch.object(approval,"_present_with_selected_transport",side_effect=AssertionError("legacy UI")):
            self.assertTrue(consent.enabled())
            self.assertEqual(self.invoke()["status"],"review_unavailable")

    def test_old_callback_never_grants_consent(self):
        self.assertEqual(approval.resolve_gateway_approval("test-session","always"),0)
    def test_unbound_child_has_no_technical_fallback(self):
        with patch.object(approval,"_present_with_selected_transport",side_effect=AssertionError("legacy UI")):
            self.assertEqual(self.invoke()["status"],"review_unavailable")

if __name__=="__main__":
    unittest.main()

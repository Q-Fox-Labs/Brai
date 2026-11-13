# ABOUTME: Проверяет разговорное согласование, привязку ответа и однократное исполнение.
# ABOUTME: Использует временную SQLite и подмену модели; не читает рабочий профиль и не отправляет сообщения.
import importlib.util
import hashlib
import os
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location("brai_consent_tested",ROOT/"services/hermes/extensions/native/approval_conversation.py")
consent=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=consent
spec.loader.exec_module(consent)

class Database:
    """Small implementation of SessionDB's transaction port, including rollback and locking."""
    def __init__(self,path):
        self.conn=sqlite3.connect(path,check_same_thread=False)
        self.conn.row_factory=sqlite3.Row
        self.lock=threading.RLock()
    def _execute_write(self,fn):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                value=fn(self.conn)
                self.conn.commit()
                return value
            except BaseException:
                self.conn.rollback()
                raise
    def close(self):
        self.conn.close()

def source(owner="alice",thread="trip"):
    return types.SimpleNamespace(platform=types.SimpleNamespace(value="telegram"),profile="dev",
        chat_id="chat",thread_id=thread,user_id=owner,is_bot=False)

def branding_module():
    """Загрузить настоящий чистый formatter из i18n overlay без native зависимостей."""
    lines=(ROOT/"services/hermes/extensions/patches/conversational-approvals.patch").read_text().splitlines()
    start=lines.index("+def brand_text(text):")
    body=[]
    for line in lines[start:]:
        if not line.startswith("+"):
            break
        body.append(line[1:])
    module=types.ModuleType("agent.i18n")
    exec(compile("\n".join(body),"native/agent/i18n.py","exec"),module.__dict__)
    return module


REVIEW={"decision":"needs_consent","effects_known":True,"target":"Папка Поездка","consequences":"Фотографии будут удалены без возможности восстановления.","reason":"Удаление не было поручено."}

class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.configuration=patch.object(consent,"configuration",return_value={"interaction":"conversation"})
        self.configuration.start()
        self.branding=patch.dict(sys.modules,{'agent.i18n':branding_module()})
        self.branding.start()
        (ROOT/"tmp").mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=ROOT/"tmp")
        self.db=Database(Path(self.temp.name)/"state.db")
        self.scope=consent.Scope(self.db,consent.conversation_key(source()),"alice","session","Подготовь список одежды","1")
        self.store=consent.Store(self.db)
        self.descriptor={"command":"delete trip","arguments":{},"cwd":self.temp.name}
    def tearDown(self):
        self.branding.stop()
        self.configuration.stop()
        self.db.close()
        self.temp.cleanup()
    def prepare(self):
        return self.store.prepare(self.scope,self.descriptor,REVIEW,"Удалить фотографии из папки Поездка?")
    def authorize(self,row):
        self.store.delivered(row["id"],"10")
        return self.store.answer(self.scope.key,"alice","11","да",time.time()+1,"10")
    def test_consent_reuses_exact_authenticated_workspace_after_reply(self):
        sys.path.insert(0, str(ROOT / 'services/hermes'))
        try:
            from files import native
            cfg = {'ownerId':'owner', 'account':'instance', 'stateRoot':str(Path(self.temp.name)/'files'),
                   'resultRoot':str(Path(self.temp.name)/'cache'), 'readRoots':[]}
            native.configure(cfg, types.SimpleNamespace())
            actor = source()
            agent = types.SimpleNamespace(session_id='session')
            command = "rm -rf './test-photos'"
            args = {'command':command}
            with patch.object(consent, 'review_action', return_value=REVIEW):
                with native.inbound_handoff(actor, '1'):
                    with consent.turn_scope(self.db, actor, 'session', 'Покажи фотографии', '1') as first:
                        with native.conversation(agent, 'Покажи фотографии'):
                            initial = agent._brai_workspace
                            marker = Path(initial)/'test-photos'
                            marker.mkdir()
                            (marker/'test.txt').write_text('test')
                            with consent.tool_scope('terminal', args, 'call-1'):
                                result = consent.gate(command, cwd=initial, backend='local')
                            self.assertEqual(result['status'], 'needs_consent')
                            row = first.pending
                self.assertTrue((marker/'test.txt').is_file())
                self.store.delivered(row['id'], '10')
                self.assertEqual(self.store.answer(first.key, 'alice', '11', 'да', time.time()+1, '10'), 'authorized')
                with native.inbound_handoff(actor, '11'):
                    with consent.turn_scope(self.db, actor, 'session', 'да', '11'):
                        with native.conversation(agent, 'да'):
                            self.assertEqual(agent._brai_workspace, initial)
                            with consent.tool_scope('terminal', args, 'call-2'):
                                result = consent.gate(command, cwd=agent._brai_workspace, backend='local')
                            self.assertTrue(result['approved'])
        finally:
            sys.path.pop(0)

    def test_authorizations_come_from_same_authenticated_owner_and_conversation(self):
        self.store.record_request(self.scope.key,"alice","1","Публикуй готовый отчёт")
        self.store.record_request(self.scope.key,"bob","2","Удаляй всё")
        self.store.record_request("other","alice","3","Отправляй деньги")
        with consent.turn_scope(self.db,source(),"session","model paraphrase","1") as scope:
            self.assertEqual(scope.instruction,"Публикуй готовый отчёт")
            self.assertEqual(self.store.requests(scope.key,scope.owner,scope.generation),[{"message_id":"1","text":"Публикуй готовый отчёт"}])

    def test_unknown_history_does_not_hide_newer_completed_operation(self):
        first=self.prepare()
        self.authorize(first)
        self.store.claim(first["id"],consent.operation_fingerprint(self.descriptor),"first")
        self.store.finish(first["id"],"first",False)
        second_descriptor={**self.descriptor,"command":"another operation"}
        second=self.store.prepare(self.scope,second_descriptor,REVIEW,"Другое действие?")
        self.authorize(second)
        self.store.claim(second["id"],consent.operation_fingerprint(second_descriptor),"second")
        self.store.finish(second["id"],"second",True)
        self.assertEqual(self.store.query(self.scope.key)["id"],second["id"])
        self.assertEqual(self.store.operation(self.scope.key,consent.operation_fingerprint(self.descriptor))["status"],"unknown")
        self.assertEqual({row["status"] for row in self.store.review_history(self.scope.key,"alice")},{"unknown","completed"})

    def test_stop_clears_prior_request_authority(self):
        self.store.record_request(self.scope.key,"alice","1","Поручение")
        self.store.cancel(self.scope.key,"alice")
        self.assertEqual(self.store.requests(self.scope.key,"alice"),[])

    def test_branding_preserves_commands_paths_and_links(self):
        text="Hermes Agent готов. `hermes config get model` /opt/hermes/engine https://example.test/Hermes"
        self.assertEqual(consent.brand_text(text),"Brai готов. `hermes config get model` /opt/hermes/engine https://example.test/Hermes")
        self.assertEqual(consent.brand_text("Команда: hermes config get model"),"Команда: hermes config get model")

    def test_telegram_second_precision_accepts_a_newer_message_id(self):
        row=self.prepare()
        self.store.delivered(row["id"],"10")
        timestamp=int(self.store.query(self.scope.key)["delivered_at"])
        self.assertEqual(self.store.answer(self.scope.key,"alice","11","да",timestamp,"10"),"authorized")

    def test_explicit_confirmation_of_this_action_is_consumed_once(self):
        row=self.prepare()
        self.store.delivered(row["id"],"10")
        runner=types.SimpleNamespace(_session_key_for_source=lambda _:"native-key",
            session_store=types.SimpleNamespace(_db_for_key=lambda _:self.db))
        event=types.SimpleNamespace(source=source(),internal=False,message_id="11",
            text="Разрешаю это действие",timestamp=time.time()+1,reply_to_message_id="10")
        self.assertIsNone(consent.gateway_input(runner,event,event))
        stored=self.store.query(self.scope.key)
        self.assertEqual(stored["status"],"authorized")
        self.assertEqual(stored["answer_id"],"11")
        self.assertTrue(self.store.claim(row["id"],stored["fingerprint"],"once"))
        self.assertFalse(self.store.claim(row["id"],stored["fingerprint"],"twice"))

    def test_no_answer_before_delivery(self):
        row=self.prepare()
        self.assertEqual(self.store.answer(self.scope.key,"alice","11","да",time.time()+1),"stale")
        self.assertEqual(self.store.query(self.scope.key)["status"],"pending")
    def test_only_same_owner_scope_and_current_question(self):
        row=self.prepare()
        self.store.delivered(row["id"],"10")
        self.assertIsNone(self.store.answer(self.scope.key,"bob","11","да",time.time()+1))
        self.assertIsNone(self.store.answer("other","alice","11","да",time.time()+1))
        self.assertEqual(self.store.answer(self.scope.key,"alice","9","да",time.time()+1),"stale")
        self.assertEqual(self.store.answer(self.scope.key,"alice","11","да",time.time()+1,"8"),"stale")
        self.assertEqual(self.store.answer(self.scope.key,"alice","11","может быть",time.time()+1),"ambiguous")
        self.assertEqual(self.authorize(row),"authorized")
        self.assertIsNone(self.store.answer(self.scope.key,"alice","11","да",time.time()+1))
    def test_wait_survives_restart_without_five_minute_expiry(self):
        row=self.prepare()
        self.store.delivered(row["id"],"10")
        self.db.close()
        self.db=Database(Path(self.temp.name)/"state.db")
        self.store=consent.Store(self.db)
        self.assertEqual(self.store.answer(self.scope.key,"alice","11","да",time.time()+3600),"authorized")

    def test_pending_survives_cold_worker_metadata_but_not_execution_inputs(self):
        sys.path.insert(0, str(ROOT / 'services/hermes'))
        try:
            from identity.release_native import NativeRelease
            command='remove trip'; args={'command':command}
            base={'PATH':'/usr/bin:/bin','HOME':self.temp.name,'EXECUTION_SECRET':'same'}
            metadata={'INVOCATION_ID':'old','JOURNAL_STREAM':'old','SYSTEMD_EXEC_PID':'10',
                      'MEMORY_PRESSURE_WATCH':'old-watch','MEMORY_PRESSURE_WRITE':'old-write'}
            with patch.dict(os.environ,{**base,**metadata},clear=True):
                NativeRelease(None).bootstrap(Path('/unused'))
                with consent.turn_scope(self.db,source(),'session','Поручение','1'), consent.tool_scope('terminal',args,'first'), patch.object(consent,'review_action',return_value=REVIEW):
                    self.assertEqual(consent.gate(command,cwd=self.temp.name,backend='local')['status'],'needs_consent')
                original=consent.descriptor_for(command,cwd=self.temp.name,backend='local')
            row=self.store.query(self.scope.key);self.assertEqual(self.authorize(row),'authorized')
            payload=b'pinned worker'; operation='6115e95f-dd1d-4501-a9f2-31bc4c747818'
            cold={**base,'INVOCATION_ID':'new','JOURNAL_STREAM':'new','SYSTEMD_EXEC_PID':'20',
                  'MEMORY_PRESSURE_WATCH':'new-watch','MEMORY_PRESSURE_WRITE':'new-write',
                  'BRAI_IDENTITY_RELEASE_HOLD_OPERATION':operation,
                  'BRAI_IDENTITY_RELEASE_HOLD_SOURCE_SHA256':hashlib.sha256(payload).hexdigest()}
            retirement=types.SimpleNamespace(brai_hold=lambda value:value==operation)
            with patch.dict(os.environ,cold,clear=True), patch.dict(sys.modules,{'hermes_cli.backend_retirement':types.SimpleNamespace(retirement=retirement)}), patch.object(Path,'read_bytes',return_value=payload):
                release=NativeRelease(None)
                release.bootstrap(Path('/opt/brai-profile/runtime/services/hermes/identity/worker.py'))
                self.assertTrue(release.cold_start);self.assertEqual(release.operation,operation)
                self.assertEqual(dict(os.environ),base)
                self.assertEqual(consent.descriptor_for(command,cwd=self.temp.name,backend='local'),original)
                with patch.dict(os.environ,{'EXECUTION_SECRET':'changed'}):
                    self.assertNotEqual(consent.descriptor_for(command,cwd=self.temp.name,backend='local'),original)
                self.assertNotEqual(consent.descriptor_for(command,cwd='/',backend='local'),original)
                self.assertNotEqual(consent.descriptor_for(command,cwd=self.temp.name,backend='docker'),original)
                with consent.turn_scope(self.db,source(),'session','да','11'), consent.tool_scope('terminal',args,'second'):
                    self.assertTrue(consent.gate(command,cwd=self.temp.name,backend='local')['approved'])
        finally:
            sys.path.pop(0)

    def test_changed_environment_cwd_or_backend_invalidates_real_consent(self):
        command='remove trip'; args={'command':command}
        for field in ('environment','cwd','backend'):
            with self.subTest(field=field), patch.dict(os.environ,{'PATH':'/usr/bin:/bin','HOME':self.temp.name},clear=True):
                with consent.turn_scope(self.db,source(),'session','Поручение','1'), consent.tool_scope('terminal',args,'first'), patch.object(consent,'review_action',return_value=REVIEW):
                    self.assertEqual(consent.gate(command,cwd=self.temp.name,backend='local')['status'],'needs_consent')
                self.assertEqual(self.authorize(self.store.query(self.scope.key)),'authorized')
                if field=='environment':os.environ['PATH']='/other/bin'
                cwd='/' if field=='cwd' else self.temp.name
                backend='docker' if field=='backend' else 'local'
                with consent.turn_scope(self.db,source(),'session','да','11'), consent.tool_scope('terminal',args,'second'):
                    self.assertEqual(consent.gate(command,cwd=cwd,backend=backend)['status'],'consent_changed')
    def test_concurrent_preparations_keep_one_operation(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            rows=list(pool.map(lambda _:self.prepare(),range(16)))
        self.assertEqual(len({row["id"] for row in rows}),1)
    def test_concurrent_consumption_is_once(self):
        row=self.prepare()
        self.authorize(row)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(lambda n:self.store.claim(row["id"],consent.operation_fingerprint(self.descriptor),str(n)),range(16)))
        self.assertEqual(sum(results),1)
    def test_changed_descriptor_does_not_consume_grant(self):
        row=self.prepare()
        self.authorize(row)
        self.assertFalse(self.store.claim(row["id"],"different","execution"))
        self.assertEqual(self.store.query(self.scope.key)["status"],"authorized")
    def test_stop_revokes_grant_and_preserves_unknown_execution(self):
        row=self.prepare()
        self.authorize(row)
        self.store.cancel(self.scope.key,"bob")
        self.assertEqual(self.store.query(self.scope.key)["status"],"authorized")
        self.store.claim(row["id"],consent.operation_fingerprint(self.descriptor),"execution")
        self.store.cancel(self.scope.key,"alice")
        self.assertEqual(self.store.query(self.scope.key)["status"],"unknown")
        self.assertFalse(self.store.claim(row["id"],consent.operation_fingerprint(self.descriptor),"retry"))
    def test_decline_is_not_a_grant(self):
        row=self.prepare()
        self.store.delivered(row["id"],"10")
        self.assertEqual(self.store.answer(self.scope.key,"alice","11","нет",time.time()+1),"denied")
        self.assertFalse(self.store.claim(row["id"],consent.operation_fingerprint(self.descriptor),"execution"))
    def test_script_and_directory_are_bound(self):
        script=Path(self.temp.name)/"calculate.py"
        script.write_text("print(1)")
        command="python "+str(script)
        before=consent.descriptor_for(command,cwd=self.temp.name,backend="local")
        script.write_text("print(2)")
        after=consent.descriptor_for(command,cwd=self.temp.name,backend="local")
        self.assertNotEqual(consent._hash(before),consent._hash(after))
        self.assertNotEqual(consent._hash(after),consent._hash(consent.descriptor_for(command,cwd=str(Path(self.temp.name).parent),backend="local")))
    def test_screenshot_style_python_is_allowed_without_question(self):
        with consent.turn_scope(self.db,source(),"session","Посмотри погоду и посчитай температуру","1"),consent.tool_scope("terminal",{"command":"python -c 'print((38-32)*5/9)'"},"tool-1"):
            with patch.object(consent,"review_action",return_value={**REVIEW,"decision":"allow"}):
                result=consent.gate("python -c 'print((38-32)*5/9)'")
        self.assertTrue(result["approved"])
        self.assertIsNone(self.store.query(self.scope.key))
    def test_pending_then_exact_execution_then_replayed_answer(self):
        command="remove trip"
        args={"command":command}
        with consent.turn_scope(self.db,source(),"session","Подготовь список одежды","1"),consent.tool_scope("terminal",args,"tool-1"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                result=consent.gate(command)
        row=self.store.query(self.scope.key)
        self.assertEqual(result["status"],"needs_consent")
        self.authorize(row)
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("terminal",args,"tool-2"):
            self.assertTrue(consent.gate(command)["approved"])
        self.assertEqual(self.store.query(self.scope.key)["status"],"completed")
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("terminal",args,"tool-3"):
            self.assertEqual(consent.gate(command)["status"],"execution_already_completed")
    def test_exception_after_claim_remains_unknown(self):
        with consent.turn_scope(self.db,source(),"session","Подготовь список одежды","1"),consent.tool_scope("terminal",{},"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate("remove trip")
        self.authorize(self.store.query(self.scope.key))
        with self.assertRaises(RuntimeError):
            with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("terminal",{},"run"):
                self.assertTrue(consent.gate("remove trip")["approved"])
                raise RuntimeError("lost connection")
        self.assertEqual(self.store.query(self.scope.key)["status"],"unknown")
    def test_branding_does_not_rename_the_verified_target_in_a_question(self):
        question="Удалить папку «Hermes»?"
        row=self.store.prepare(self.scope,self.descriptor,REVIEW,question)
        event=types.SimpleNamespace(_brai_consent_delivery=(self.db,self.scope.key,"alice"))
        response=consent.brand_response(event,"Hermes Agent: "+question)
        self.assertEqual(response,"Brai: "+question)
        consent.record_delivery(event,response,True,"10")
        self.assertIsNotNone(self.store.query(self.scope.key)["delivered_at"])

    def test_delivery_requires_success_and_the_real_question(self):
        row=self.prepare()
        event=types.SimpleNamespace(_brai_consent_delivery=(self.db,self.scope.key,"alice"))
        consent.record_delivery(event,row["question"],False,"10")
        self.assertIsNone(self.store.query(self.scope.key)["delivered_at"])
        consent.record_delivery(event,"Другой ответ",True,"10")
        self.assertIsNone(self.store.query(self.scope.key)["delivered_at"])
        consent.record_delivery(event,row["question"],True,"10")
        self.assertIsNotNone(self.store.query(self.scope.key)["delivered_at"])
    def test_worker_normal_completion_cannot_rearm_replaced_question(self):
        row=self.prepare()
        event=types.SimpleNamespace(_brai_consent_delivery=(self.db,self.scope.key,"alice"))
        self.store.invalidate(row["id"])
        replacement=self.prepare()
        with patch.dict(consent.os.environ,BRAI_IDENTITY_MODE="worker"):
            consent.record_delivery(event,replacement["question"],True,"10")
        self.assertIsNone(self.store.query(self.scope.key)["delivered_at"])

    def test_transport_receipt_is_bound_before_question_replacement(self):
        row=self.prepare()
        runner=types.SimpleNamespace(_session_key_for_source=lambda _:"native-key",
            session_store=types.SimpleNamespace(_db_for_key=lambda _:self.db))
        pending=consent.pending_delivery(runner,source(),row["question"])
        self.assertIsNone(self.store.query(self.scope.key)["delivered_at"])
        self.store.invalidate(row["id"])
        replacement=self.prepare()
        pending[0].delivered(pending[1],"10")
        self.assertIsNone(self.store.query(self.scope.key)["delivered_at"])
        self.assertNotEqual(replacement["id"],row["id"])

    def test_transport_receipt_rejects_other_owner_topic_generation_and_content(self):
        row=self.prepare()
        runner=types.SimpleNamespace(_session_key_for_source=lambda _:"native-key",
            session_store=types.SimpleNamespace(_db_for_key=lambda _:self.db))
        for actor,text in ((source("bob"),row["question"]),
                (source(thread="other"),row["question"]),(source(),"Предварительный ответ")):
            self.assertIsNone(consent.pending_delivery(runner,actor,text))
        runner._brai_consent_generation=lambda _:1
        self.assertIsNone(consent.pending_delivery(runner,source(),row["question"]))

    def test_prepared_input_is_not_reinterpreted_on_idle_dispatch(self):
        import asyncio
        row=self.prepare()
        self.store.delivered(row["id"],"10")
        runner=types.SimpleNamespace(_session_key_for_source=lambda _:"native-key",
            session_store=types.SimpleNamespace(_db_for_key=lambda _:self.db))
        event=types.SimpleNamespace(source=source(),internal=False,message_id="11",
            text="Разрешаю это действие",timestamp=time.time()+1,reply_to_message_id="10")
        self.assertIsNone(asyncio.run(consent.gateway_input_prepared(runner,event,event)))
        # Повторный idle hook не читает даже новое обогащённое представление.
        event._gateway_pending_stt_text="Разрешаю это действие"
        event._gateway_pending_stt_transcripts=["Разрешаю это действие"]
        event._gateway_pending_stt_echoed=1
        replacement=types.SimpleNamespace(source=event.source,text="Служебное представление")
        self.assertIsNone(asyncio.run(consent.gateway_input_prepared(runner,replacement,event)))
        self.assertEqual(replacement._gateway_pending_stt_transcripts,event._gateway_pending_stt_transcripts)
        self.assertEqual(replacement._gateway_pending_stt_echoed,1)
        self.assertEqual(self.store.query(self.scope.key)["status"],"authorized")
        self.assertEqual(self.store.requests(self.scope.key,"alice")[-1]["text"],"Разрешаю это действие")

    def test_reviewer_has_budget_context_and_bounded_retry(self):
        auxiliary=types.ModuleType("agent.auxiliary_client")
        auxiliary._get_task_timeout=lambda _:30
        auxiliary.call_llm=None
        config=types.ModuleType("tools.approval_context")
        config._get_approval_config=lambda:{"interaction":"conversation","smart_policy":"operator"}
        redact=types.ModuleType("agent.redact")
        redact.redact_sensitive_text=lambda text,**_:text
        calls=[]
        def call(**kwargs):
            calls.append(kwargs)
            if len(calls)==1:
                raise TimeoutError()
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=json.dumps(REVIEW)))])
        with patch.dict(sys.modules,{"agent.auxiliary_client":auxiliary,"tools.approval_context":config,"agent.redact":redact}):
            result=consent.review_action(self.descriptor,self.scope,call=call)
            self.assertEqual(result["decision"],"needs_consent")
            self.assertEqual(len(calls),2)
            self.assertEqual(calls[0]["max_tokens"],2048)
            self.assertLessEqual(calls[1]["timeout"],calls[0]["timeout"])
            self.assertIn(self.scope.instruction,calls[0]["messages"][1]["content"])
    def test_invalid_review_does_not_show_technical_prompt_or_allow(self):
        auxiliary=types.ModuleType("agent.auxiliary_client")
        auxiliary._get_task_timeout=lambda _:30
        auxiliary.call_llm=None
        config=types.ModuleType("tools.approval_context")
        config._get_approval_config=lambda:{}
        calls=[]
        def call(**kwargs):
            calls.append(kwargs)
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="APPROVE"))])
        with patch.dict(sys.modules,{"agent.auxiliary_client":auxiliary,"tools.approval_context":config}):
            result=consent.review_action(self.descriptor,self.scope,call=call)
        self.assertEqual(result["decision"],"unavailable")
        self.assertEqual(len(calls),2)
        self.assertNotIn("delete trip",result["reason"])


    def test_approved_code_covers_reviewed_nested_effects_without_a_second_question(self):
        args={"code":"terminal('remove trip')"}
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("execute_code",args,"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate(args["code"])
        self.authorize(self.store.query(self.scope.key))
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("execute_code",args,"run"):
            self.assertTrue(consent.gate(args["code"])["approved"])
            with consent.tool_scope("terminal",{"command":"remove trip"},"nested"):
                with patch.object(consent,"review_action",return_value={**REVIEW,"decision":"allow"}) as reviewer:
                    self.assertTrue(consent.gate("remove trip")["approved"])
                    self.assertEqual(reviewer.call_args.kwargs["existing_authorization"]["operation"]["tool"],"execute_code")
            self.assertEqual(self.store.query(self.scope.key)["status"],"executing")
        self.assertEqual(self.store.query(self.scope.key)["status"],"completed")

    def test_uncovered_nested_effect_preserves_parent_unknown_and_one_new_question(self):
        args={"code":"terminal(dynamic_command)"}
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("execute_code",args,"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate(args["code"])
        parent=self.store.query(self.scope.key)
        self.authorize(parent)
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("execute_code",args,"run"):
            self.assertTrue(consent.gate(args["code"])["approved"])
            with consent.tool_scope("terminal",{"command":"remove other"},"nested"):
                with patch.object(consent,"review_action",return_value={**REVIEW,"target":"Другая папка"}):
                    self.assertEqual(consent.gate("remove other")["status"],"needs_consent")
        self.assertEqual(self.store.operation(self.scope.key,parent["fingerprint"])["status"],"unknown")
        pending=self.store.query(self.scope.key)
        self.assertNotEqual(pending["id"],parent["id"])
        self.assertEqual(pending["status"],"pending")

    def test_plugin_rewrite_of_autoallowed_operation_stops_before_dispatch(self):
        with consent.turn_scope(self.db,source(),"session","Посчитай","1"),consent.tool_scope("plugin",{"command":"calculate"},"run"):
            with patch.object(consent,"review_action",return_value={**REVIEW,"decision":"allow"}):
                self.assertTrue(consent.gate("calculate")["approved"])
            self.assertEqual(consent.update_arguments({"command":"delete"})["status"],"consent_changed")

    def test_database_failure_on_finish_cannot_leak_parent_authority(self):
        with self.assertRaises(RuntimeError):
            with patch.object(consent.Store,"finish",side_effect=RuntimeError("database unavailable")):
                with consent.turn_scope(self.db,source(),"session","Проверь папку","1") as scope:
                    with consent.tool_scope("terminal",{},"run"):
                        scope.execution_ids.add("claimed")
        self.assertIsNone(consent._action.get())

    def test_plugin_arguments_without_a_command_keep_exact_consent(self):
        args={"path":"report.txt","content":"ready"}
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("file_write",args,"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate("plugin approval label")
        self.authorize(self.store.query(self.scope.key))
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("file_write",args,"run"):
            self.assertTrue(consent.gate("another internal label")["approved"])
            self.assertIsNone(consent.update_arguments(args))
            self.assertEqual(consent.update_arguments({**args,"path":"another.txt"})["status"],"consent_changed")

    def test_missing_configuration_cannot_consume_an_authorized_operation(self):
        args={"command":"remove trip"}
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("terminal",args,"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate(args["command"])
        self.authorize(self.store.query(self.scope.key))
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("terminal",args,"run"):
            with patch.object(consent,"configuration",return_value={}):
                self.assertTrue(consent.enabled())
                self.assertEqual(consent.gate(args["command"])["status"],"review_unavailable")
        self.assertEqual(self.store.query(self.scope.key)["status"],"authorized")

    def test_plugin_cannot_rewrite_consumed_consent(self):
        args={"command":"remove trip"}
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("terminal",args,"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate(args["command"])
        self.authorize(self.store.query(self.scope.key))
        with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("terminal",args,"second"):
            self.assertTrue(consent.gate(args["command"])["approved"])
            self.assertIsNone(consent.update_arguments(args))
            self.assertEqual(consent.update_arguments({"command":"remove other"})["status"],"consent_changed")

    def test_unknown_effects_cannot_be_autoapproved(self):
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("terminal",{},"tool"):
            with patch.object(consent,"review_action",return_value={**REVIEW,"decision":"allow","effects_known":False}):
                self.assertEqual(consent.gate("opaque")["status"],"needs_information")

    def test_unknown_operation_cannot_be_retried_by_a_new_message(self):
        args={"command":"remove trip"}
        with consent.turn_scope(self.db,source(),"session","Проверь папку","1"),consent.tool_scope("terminal",args,"first"):
            with patch.object(consent,"review_action",return_value=REVIEW):
                consent.gate(args["command"])
        self.authorize(self.store.query(self.scope.key))
        with self.assertRaises(RuntimeError):
            with consent.turn_scope(self.db,source(),"session","да","11"),consent.tool_scope("terminal",args,"run"):
                consent.gate(args["command"])
                raise RuntimeError("lost outcome")
        with consent.turn_scope(self.db,source(),"session","продолжай","12"),consent.tool_scope("terminal",args,"retry"):
            self.assertEqual(consent.gate(args["command"])["status"],"execution_unknown")

if __name__=="__main__":
    unittest.main()

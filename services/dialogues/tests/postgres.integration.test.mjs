// ABOUTME: Проверяет реальные PostgreSQL, миграции, курсоры и изоляцию Диалогов.
// ABOUTME: Работает только с явно переданным disposable fixture.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {Pool} from "pg";
import {migrate} from "../dist/migrate.js";
import {createStore} from "../dist/store.js";
import {turnChecks} from './turn-fixture.mjs';
import {v02Checks} from "./v02-fixture.mjs";
const ownerUrl=process.env.DIALOGUES_TEST_OWNER_DATABASE_URL;
const appUrl=process.env.DIALOGUES_TEST_DATABASE_URL;
test("PostgreSQL: архив, запись, 50 пар, версии, курсоры и concurrency",{skip:!ownerUrl||!appUrl},async t=>{
  const owner=new Pool({connectionString:ownerUrl}),app=new Pool({connectionString:appUrl,max:8});
  const api=createStore(app,"synthetic-cursor-key");
  let n=0;
  const rid=()=>"request-"+(++n);
  const d=(id)=>({id,channel:"synthetic",title:"Одинаковое название"});
  const msg=(id,turn_id,role="user",kind="input",text="Синтетический текст")=>({id,turn_id,role,kind,text});
  async function pages(cursor,dialogue_id){
    const results=[];
    for(let i=0;i<200;i++){
      const r=await api.context("owner-a",cursor?{cursor}:dialogue_id?{dialogue_id}:{});
      assert.ok(Buffer.byteLength(JSON.stringify(r))<=65536);
      results.push(r);
      if(!r.continuation_cursor)return {results,cursor:r.next_cursor};
      cursor=r.continuation_cursor;
    }
    assert.fail("pagination did not terminate");
  }
  const messages=r=>r.results.flatMap(p=>p.dialogues.flatMap(d=>d.turns.flatMap(t=>t.messages)));
  try {
    if(process.env.DIALOGUES_TEST_RESTART==="true") {
      assert.equal((await api.message("owner-a",{dialogue_id:"a",message_id:"a-u-0"})).text,"Синтетический текст");
      await migrate(owner,"dialogues_test_owner","dialogues_test_app");
      assert.equal((await owner.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='dialogues'")).rows[0].n,"6");
      return;
    }
    const legacy=readFileSync(new URL("../migrations/001.sql",import.meta.url),"utf8").replace(":'dialogues_app_role'","'dialogues_test_app'").replaceAll(':"dialogues_app_role"','"dialogues_test_app"');
    await owner.query(legacy);
    const legacyBefore=(await owner.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='dialogues' ORDER BY table_name,ordinal_position")).rows;
    await migrate(owner,"dialogues_test_owner","dialogues_test_app");
    await migrate(owner,"dialogues_test_owner","dialogues_test_app");
    assert.deepEqual((await owner.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='dialogues' ORDER BY table_name,ordinal_position")).rows,legacyBefore);
    await turnChecks(t,app);
    await t.test("повтор, конфликт и чужой владелец",async()=>{
      const packet={request_id:rid(),dialogue:d("a"),messages:[msg("a-u-0","a-t-0"),msg("a-c-0","a-t-0","assistant","commentary"),msg("a-f-0","a-t-0","assistant","final")]};
      const first=await api.append("owner-a",packet);
      assert.deepEqual(await api.append("owner-a",packet),first);
      await assert.rejects(api.append("owner-a",{...packet,messages:[{...packet.messages[0],text:"изменено"}]}),{code:"REQUEST_CONFLICT"});
      await assert.rejects(api.append("owner-a",{...packet,request_id:rid(),messages:[{...packet.messages[0],text:"изменено"}]}),{code:"MESSAGE_CONFLICT"});
      await assert.rejects(api.message("owner-b",{dialogue_id:"a",message_id:"a-u-0"}),{code:"NOT_FOUND"});
      await assert.rejects(app.query("UPDATE dialogues_live.messages SET text='forbidden'"),{code:"42501"});
      await assert.rejects(app.query("UPDATE dialogues.messages SET original_text='forbidden'"),{code:"42501"});
      assert.equal((await api.message("owner-a",{dialogue_id:"a",message_id:"a-u-0"})).sha256,createHash("sha256").update("Синтетический текст").digest("hex"));
    });
    await t.test("глобальные 50 пар и группировка с исходниками",async()=>{
      for(let i=1;i<=65;i++) {
        const id=i%2?"a":"b";
        await api.append("owner-a",{request_id:rid(),dialogue:d(id),messages:[msg(id+"-u-"+i,id+"-t-"+i),msg(id+"-c-"+i,id+"-t-"+i,"assistant","commentary"),msg(id+"-f-"+i,id+"-t-"+i,"assistant","final")]});
      }
      const r=await pages();
      const turns=r.results.flatMap(x=>x.dialogues.flatMap(d=>d.turns));
      assert.equal(new Set(turns.map(x=>x.id)).size,50);
      assert.equal(messages(r).length,100);
      assert.ok(messages(r).every(x=>x.kind!=="commentary"));
      assert.ok(messages(r).every(x=>x.representation==="original"));
      for(const page of r.results)for(const group of page.dialogues)for(const turn of group.turns)for(const m of turn.messages)assert.equal(m.dialogue_id,group.id);
    });
    await t.test("delta сохраняет промежуточные ответы и версии их саммари",async()=>{
      const checkpoint=(await pages()).cursor;
      await api.append("owner-a",{request_id:rid(),dialogue:d("delta"),messages:[msg("delta-c","delta-t","assistant","commentary")]});
      const delta=await pages(checkpoint);
      assert.ok(messages(delta).some(m=>m.id==="delta-c"&&m.kind==="commentary"));
      await api.summary("owner-a",{request_id:rid(),dialogue_id:"delta",target:"message",message_id:"delta-c",expected_version:null,text:"Саммари промежуточного ответа"});
      const newer=await pages(delta.cursor);
      assert.ok(messages(newer).some(m=>m.id==="delta-c"&&m.summary_version==="1"));
    });
    await t.test("delta возвращает новую версию саммари прежнего final",async()=>{
      await api.append("owner-a",{request_id:rid(),dialogue:d("superseded"),messages:[msg("old-u","old-t"),msg("old-f1","old-t","assistant","final"),msg("old-f2","old-t","assistant","final")]});
      const checkpoint=(await pages()).cursor;
      await api.summary("owner-a",{request_id:rid(),dialogue_id:"superseded",target:"message",message_id:"old-f1",expected_version:null,text:"Саммари предыдущего итога"});
      assert.ok(messages(await pages(checkpoint)).some(m=>m.id==="old-f1"&&m.summary_version==="1"));
    });
    await t.test("полная история ограничена беседой, содержит промежуточные ответы",async()=>{
      const history=await pages(undefined,"a");
      assert.ok(messages(history).some(m=>m.kind==="commentary"));
      assert.ok(messages(history).every(m=>m.dialogue_id==="a"));
      assert.equal(messages(history).length,102);
      await assert.rejects(api.context("owner-a",{cursor:history.cursor,dialogue_id:"b"}),{code:"INVALID_CURSOR"});
    });
    await t.test("старая реплика с новым саммари и проверка покрытия",async()=>{
      const snapshot=await pages();
      const s=await api.summary("owner-a",{request_id:rid(),dialogue_id:"a",target:"message",message_id:"a-u-0",expected_version:null,text:"Короткое саммари"});
      assert.equal(s.version,"1");
      const delta=await pages(snapshot.cursor);
      assert.ok(messages(delta).some(m=>m.id==="a-u-0"&&m.text==="Короткое саммари"&&m.representation==="summary"));
      await assert.rejects(api.summary("owner-a",{request_id:rid(),dialogue_id:"a",target:"message",message_id:"a-u-0",expected_version:null,text:"неверная версия"}),{code:"VERSION_CONFLICT"});
      await api.summary("owner-a",{request_id:rid(),dialogue_id:"a",target:"dialogue",through_message_id:"a-f-65",expected_version:null,text:"Свёртка A"});
      await assert.rejects(api.summary("owner-a",{request_id:rid(),dialogue_id:"a",target:"dialogue",through_message_id:"a-u-0",expected_version:"1",text:"неверный откат покрытия"}),{code:"COVERAGE_CONFLICT"});
    });
    await t.test("поздняя вставка под покрытый префикс запрещена",async()=>{
      await api.append("owner-a",{request_id:rid(),dialogue:d("prefix"),messages:[{...msg("prefix-0","prefix-t"),message_order:0},{...msg("prefix-2","prefix-t"),message_order:2}]});
      await api.summary("owner-a",{request_id:rid(),dialogue_id:"prefix",target:"dialogue",through_message_id:"prefix-2",expected_version:null,text:"Только два существовавших сообщения"});
      await assert.rejects(api.append("owner-a",{request_id:rid(),dialogue:d("prefix"),messages:[{...msg("prefix-1","prefix-t"),message_order:1}]}),{code:"ORDER_CONFLICT"});
      await assert.rejects(api.message("owner-a",{dialogue_id:"prefix",message_id:"prefix-1"}),{code:"NOT_FOUND"});
    });
    await t.test("Unicode, предел ответа и дочитывание оригинала",async()=>{
      const original="😀Я".repeat(15000);
      await api.append("owner-a",{request_id:rid(),dialogue:d("large"),messages:[msg("large-u","large-t","user","input",original),msg("large-f","large-t","assistant","final","Ответ")]});
      let offset=0,restored="";
      for(;;){const r=await api.message("owner-a",{dialogue_id:"large",message_id:"large-u",offset,limit:4096});restored+=r.text;if(r.next_offset===null)break;offset=r.next_offset;}
      assert.equal(restored,original);
      const r=await pages();
      assert.ok(messages(r).some(m=>m.id==="large-u"&&m.truncated&&m.next_offset));
      const huge="\u0001".repeat(8000);
      await api.summary("owner-a",{request_id:rid(),dialogue_id:"large",target:"message",message_id:"large-u",expected_version:null,text:huge});
      await pages();
    });
    await t.test("параллельные commits не теряются за курсором",async()=>{
      let cursor=(await pages()).cursor;
      const expected=new Set();
      await Promise.all(Array.from({length:20},(_,i)=>{
        const id="concurrent-"+i;expected.add(id);
        return api.append("owner-a",{request_id:rid(),dialogue:d("concurrent"),messages:[msg(id,id)]});
      }));
      const r=await pages(cursor);
      assert.deepEqual(new Set(messages(r).filter(x=>x.id.startsWith("concurrent-")).map(x=>x.id)),expected);
      await assert.rejects(api.context("owner-b",{cursor}),{code:"INVALID_CURSOR"});
    });
    await t.test("checkpoint между конкурентными commits не пропускает задержанную запись",async()=>{
      let releaseGate,signalStarted;
      const gate=new Promise(resolve=>{releaseGate=resolve;});
      const started=new Promise(resolve=>{signalStarted=resolve;});
      const slow=createStore({async connect(){
        const c=await app.connect();
        return {async query(sql,...args){
          const result=await c.query(sql,...args);
          if(sql.includes("nextval('dialogues_live.change_seq')")){signalStarted();await gate;}
          return result;
        },release(){c.release();}};
      }},"synthetic-cursor-key");
      const first=slow.append("owner-a",{request_id:rid(),dialogue:d("race"),messages:[msg("race-slow","race-slow-t")]});
      await started;
      let fastDone=false;
      const second=api.append("owner-a",{request_id:rid(),dialogue:d("race"),messages:[msg("race-fast","race-fast-t")]}).then(r=>{fastDone=true;return r;});
      let middle;
      try {
        await new Promise(resolve=>setTimeout(resolve,30));
        assert.equal(fastDone,false,"вторая запись должна ждать commit первой под owner lock");
        middle=await pages();
      } finally{releaseGate();}
      await Promise.all([first,second]);
      const delta=messages(await pages(middle.cursor));
      assert.ok(delta.some(m=>m.id==="race-slow"));
      assert.ok(delta.some(m=>m.id==="race-fast"));
    });
    await t.test("неполное покрытие каждой беседы выдаётся с пагинацией",async()=>{
      for(let i=0;i<80;i++)await api.append("owner-a",{request_id:rid(),dialogue:d("gap-"+i),messages:[msg("gap-u-"+i,"gap-t-"+i)]});
      const r=await pages();
      const gaps=new Set(r.results.flatMap(p=>p.dialogues.filter(d=>d.coverage_gap).map(d=>d.id)));
      for(let i=0;i<80;i++)assert.ok(gaps.has("gap-"+i));
      const a=(await pages(undefined,"a")).results.flatMap(p=>p.dialogues).find(d=>d.coverage_gap);
      assert.equal(a,undefined);
    });
    await v02Checks(t,owner,app);
  } finally {await app.end();await owner.end();}
});

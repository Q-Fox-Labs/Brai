// ABOUTME: Проверяет точную границу и публичный состав разового JSONL-импорта.
// ABOUTME: Использует только синтетический журнал; записи в MCP и БД не выполняются.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {snapshot} from "../dist/import.js";
test("импорт начинается включительно с ID и не захватывает hidden/tool/ранний текст",async()=>{
  const root=fileURLToPath(new URL("../../../tmp/",import.meta.url));
  await mkdir(root,{recursive:true});
  const dir=await mkdtemp(join(root,"dialogues-import-test-"));
  const path=join(dir,"source.jsonl");
  const record=(type,payload)=>({timestamp:"2026-11-01T12:33:23.841Z",type,payload});
  const message=(id,role,phase,text)=>record("response_item",{id,type:"message",role,...(phase?{phase}:{}),content:[{type:role==="user"?"input_text":"output_text",text}]});
  const rows=[
    record("session_meta",{id:"thread"}),
    record("event_msg",{type:"task_started",turn_id:"old-turn",started_at:"2026-10-31T12:00:00Z"}),
    message("old","user",null,"НЕ ПЕРЕНОСИТЬ"),
    record("event_msg",{type:"task_started",turn_id:"turn",started_at:"2026-11-01T12:33:20Z"}),
    message("start","user",null,"Я заспавнился 😀"),
    message("hidden","assistant","analysis","СКРЫТО"),
    record("response_item",{id:"tool",type:"function_call_output",output:"СЛУЖЕБНОЕ"}),
    message("system","developer",null,"ИНСТРУКЦИЯ"),
    message("comment","assistant","commentary","Публичный ход"),
    message("final","assistant","final_answer","Публичный итог")
  ];
  try {
    await writeFile(path,rows.map(x=>JSON.stringify(x)).join("\n")+"\n");
    const a=await snapshot(path,"thread","start");
    assert.deepEqual(a.messages.map(m=>m.id),["start","comment","final"]);
    assert.equal(a.messages[0].occurred_at,null);
    assert.equal(a.messages[0].source.native_turn_started_at,"2026-11-01T12:33:20Z");
    assert.ok(a.messages.every(m=>m.turn_id==="turn"));
    assert.equal(a.cutoff_id,"final");
    assert.equal(a.sha256,(await snapshot(path,"thread","start")).sha256);
    await assert.rejects(snapshot(path,"other","start"),{message:"SOURCE_THREAD_MISMATCH"});
    await assert.rejects(snapshot(path,"thread","missing"),{message:"SOURCE_BOUNDARY_MISSING"});
  } finally {await rm(dir,{recursive:true,force:true});}
});

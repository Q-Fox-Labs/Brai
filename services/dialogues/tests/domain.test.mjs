// ABOUTME: Проверяет границы входа и непрозрачные курсоры Диалогов.
// ABOUTME: Использует только синтетические тексты без базы и сети.
import {test} from "node:test";
import assert from "node:assert/strict";
import {appendInput,summaryInput,encodeCursor,decodeCursor,fragment} from "../dist/domain.js";
const packet={request_id:"r",dialogue:{id:"d",channel:"test"},messages:[{id:"m",turn_id:"t",role:"user",kind:"input",text:"Привет"}]};
test("отклоняет подмену владельца, роли и повтор ID в пакете",()=>{
  assert.throws(()=>appendInput({...packet,owner_id:"other"}),{code:"INVALID_ARGUMENT"});
  assert.throws(()=>appendInput({...packet,messages:[{...packet.messages[0],role:"assistant"}]}),{code:"INVALID_ARGUMENT"});
  assert.throws(()=>appendInput({...packet,messages:[packet.messages[0],packet.messages[0]]}),{code:"DUPLICATE_MESSAGE_ID"});
});
test("сохраняет исходный Unicode и не подменяет неизвестное время",()=>{
  const result=appendInput(packet);
  assert.equal(result.messages[0].text,"Привет");
  assert.equal(result.messages[0].occurred_at,null);
  assert.deepEqual(fragment("А😀Б",1,1),{text:"😀",offset:1,next_offset:2,total_chars:3,truncated:true});
});
test("ограничивает исходник и требует покрытие свёртки",()=>{
  assert.throws(()=>appendInput({...packet,messages:[{...packet.messages[0],text:"x".repeat(1_048_577)}]}),{code:"INVALID_ARGUMENT"});
  assert.throws(()=>summaryInput({request_id:"s",dialogue_id:"d",target:"dialogue",expected_version:null,text:"summary"}),{code:"INVALID_ARGUMENT"});
});
test("курсор проверяет подпись, владельца и позицию",()=>{
  const cursor={v:1,owner:"one",mode:"bootstrap",scope:null,from:"0",through:"2",offset:0};
  const encoded=encodeCursor(cursor,"synthetic-key");
  assert.deepEqual(decodeCursor(encoded,"synthetic-key","one"),cursor);
  assert.throws(()=>decodeCursor(encoded,"synthetic-key","two"),{code:"INVALID_CURSOR"});
  assert.throws(()=>decodeCursor(encoded+"x","synthetic-key","one"),{code:"INVALID_CURSOR"});
});

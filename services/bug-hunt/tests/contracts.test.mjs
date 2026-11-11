// ABOUTME: Проверяет закрытые DTO и пределы запросов bug-hunt.
// ABOUTME: Проверки не используют сервисы или базу данных.
import assert from "node:assert/strict";
import test from "node:test";
import {canonical,limits,validate} from "../dist/contracts.js";
const report=(observation={})=>({request_id:"request-1",observation:{title:"Сбой",operation:"open",expected:"Работает",observed:"Ошибка",...observation}});
const rejects=(operation,value,code="INVALID_ARGUMENT")=>assert.throws(()=>validate(operation,value),error=>error.code===code);
test("минимальный report и защита доверенного контекста",()=>{
 assert.doesNotThrow(()=>validate("report",report()));
 for(const key of ["owner_id","actor_id","ownerId","reviewer","permissions","installation_id"]){rejects("report",{...report(),[key]:"spoofed"});rejects("report",report({[key]:"spoofed"}));}
});
test("Unicode, code points и конечные текстовые пределы",()=>{
 rejects("report",report({title:"nul\u0000"}));rejects("report",report({observed:"\uD800"}));rejects("report",report({title:"\uDC00"}));
 assert.doesNotThrow(()=>validate("report",report({title:"😀".repeat(200)})));
 rejects("report",report({title:"😀".repeat(201)}));rejects("report",report({expected:"e".repeat(4001)}));
 rejects("report",report({steps:"😀".repeat(8000),diagnostic_text:"😀".repeat(16000)}),"REQUEST_TOO_LARGE");
 assert.equal(limits.requestBytes,65536);
});
test("доказательства ограничены восемью уникальными UUID",()=>{
 const ids=Array.from({length:9},(_,i)=>"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"));
 assert.doesNotThrow(()=>validate("report",report({evidence_artifact_ids:ids.slice(0,8)})));
 rejects("report",report({evidence_artifact_ids:ids}));rejects("report",report({evidence_artifact_ids:[ids[0],ids[0]]}));
});
test("предел страницы и обязательное ручное объяснение",()=>{
 for(const limit of [1,50])assert.doesNotThrow(()=>validate("list",{limit}));
 for(const limit of [0,51])rejects("list",{limit});
 const review={request_id:"r",case_id:"00000000-0000-4000-8000-000000000001",expected_revision:1,review_state:"triaged",explanation:"Разбор"};
 assert.doesNotThrow(()=>validate("review",review));rejects("review",{...review,explanation:""});rejects("review",{...review,expected_revision:0});
});
test("канонический hash-input не зависит от порядка ключей",()=>{
 assert.equal(canonical({z:1,nested:{b:2,a:3}}),canonical({nested:{a:3,b:2},z:1}));
});

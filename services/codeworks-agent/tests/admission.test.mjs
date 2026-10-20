// ABOUTME: Проверяет допуск native thread/turn и запрет повторной подписи tool call.
// ABOUTME: Дочерняя identity появляется только из события активного родителя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdmission} from '../codex.mjs';

test('native admission fences unknown, completed and replayed calls while admitting actual child lifecycle',()=>{
  const a=createAdmission(),tool=(threadId,turnId,id)=>({id,params:{threadId,turnId}});
  assert.throws(()=>a.expect('unknown'),/NOT_ADMITTED/);
  a.thread('parent');a.expect('parent');
  a.observe({method:'turn/started',params:{threadId:'parent',turn:{id:'p1'}}});
  assert.throws(()=>a.tool(tool('other','p1',1)),/NOT_ADMITTED/);
  assert.throws(()=>a.tool(tool('parent','wrong',1)),/NOT_ADMITTED/);
  a.tool(tool('parent','p1',1));assert.throws(()=>a.tool(tool('parent','p1',1)),/NOT_ADMITTED/);
  assert.throws(()=>a.observe({method:'item/started',params:{threadId:'other',turnId:'p1',item:{type:'subAgentActivity',agentThreadId:'forged'}}}),/NOT_ADMITTED/);
  a.observe({method:'item/started',params:{threadId:'parent',turnId:'p1',item:{type:'subAgentActivity',agentThreadId:'child'}}});
  a.observe({method:'turn/started',params:{threadId:'child',turn:{id:'c1'}}});a.tool(tool('child','c1',2));
  a.observe({method:'turn/completed',params:{threadId:'child',turn:{id:'c1'}}});
  assert.throws(()=>a.tool(tool('child','c1',3)),/NOT_ADMITTED/);
  a.observe({method:'turn/completed',params:{threadId:'parent',turn:{id:'p1'}}});
  assert.throws(()=>a.tool(tool('parent','p1',4)),/NOT_ADMITTED/);
});

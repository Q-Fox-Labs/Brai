// ABOUTME: Проверяет персональный порт Диалогов и сохранность MCP-диагностики.
// ABOUTME: Подставляет соседний MCP без рабочей истории, сети и credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBraiTools} from '../runtime.mjs';
import {validateConfig} from '../config.mjs';
const config={ownerId:'account-a',nats:{servers:['nats://localhost']},gameCore:{enabled:false},
 history:{enabled:false},transcription:{enabled:false},publisher:{configPath:'/protected/publisher.json'},
 dialogues:{enabled:true,userId:'account-a',profileId:'profile-a',url:'http://127.0.0.1:1234/mcp',token:'synthetic'}};
test('Dialogues: большой input и полный отказ проходят без перепаковки и повтора',async()=>{
 const diagnosis={isError:true,content:[{type:'text',text:JSON.stringify({code:'INVALID_ARGUMENT',field:'arguments.messages[0].role',applied:false,next_action:'Исправить поле'})}]};
 let calls=0;
 const ports={list:async endpoint=>endpoint==='dialogues'?[{name:'dialogues_exchange',inputSchema:{type:'object'}}]:[],
  mcp:async(endpoint,name,args)=>{assert.equal(endpoint,'dialogues');assert.ok(args.text.length>65536);calls++;return diagnosis;},close:async()=>{}};
 const runtime=await createBraiTools(config,ports);
 assert.equal((await runtime.listTools()).filter(x=>x.name==='dialogues_exchange').length,1);
 assert.deepEqual(await runtime.call('dialogues_exchange',{text:'я'.repeat(100000)}),diagnosis);assert.equal(calls,1);
 ports.mcp=async()=>{calls++;throw Object.assign(new Error('connection lost'),{code:'ECONNRESET'});};
 const unknown=await runtime.call('dialogues_exchange',{text:'я'.repeat(100000),arguments:{request_id:'same-request'}});
 const parsed=JSON.parse(unknown.content[0].text);assert.equal(parsed.code,'OUTCOME_UNKNOWN');assert.equal(parsed.request_id,'same-request');
 assert.equal('applied' in parsed,false);assert.equal(calls,2);
 assert.throws(()=>validateConfig({...config,dialogues:{...config.dialogues,userId:'other'}},config.ownerId));
 await runtime.close();
});

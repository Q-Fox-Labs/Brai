// ABOUTME: Проверяет каталог обычного Hermes при offline listener и последующее восстановление.
// ABOUTME: Использует настоящий HTTP MCP, синтетическое хранилище и отключённые остальные сервисы.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBraiTools,connectMcpEndpoint} from '../runtime.mjs';
import {startMcp} from '../../dialogues/dist/mcp.js';
test('standalone keeps Dialogues tools offline and calls the recovered listener',async()=>{
 const cfg={host:'127.0.0.1',port:0,owner:'synthetic',hosts:['placeholder'],origins:['http://127.0.0.1'],token:'a'.repeat(40)};
 let listener=await startMcp({},cfg);const url=listener.url;cfg.hosts.push(new URL(url).host);cfg.port=Number(new URL(url).port);
 await listener.close();listener=undefined;
 const config={ownerId:'u',gameCore:{enabled:false},history:{enabled:false},transcription:{enabled:false},dialogues:{enabled:true,url,token:cfg.token,userId:'u',profileId:'p'}};
 const endpoint=await connectMcpEndpoint(config.dialogues,{endpointName:'dialogues'});
 const runtime=await createBraiTools(config,{list:async name=>name==='dialogues'?(await endpoint.list()).tools:[],mcp:(_name,tool,args)=>endpoint.call(tool,args),close:()=>endpoint.close()});
 try{
  assert.deepEqual((await runtime.listTools()).filter(t=>t.name.startsWith('dialogues_')).map(t=>t.name),['dialogues_exchange','dialogues_context_ack']);
  const args={request_id:'test',consumer_id:'c',context_instance_id:'i',delivery_id:'d'};
  const down=await runtime.call('dialogues_context_ack',args);
  const failure=JSON.parse(down.content[0].text);
  assert.equal(failure.code,'DIALOGUES_UNAVAILABLE');
  assert.match(failure.next_action,/не упоминай внутренний сервис пользователю/i);
  listener=await startMcp({ack:async()=>({acknowledged:true})},cfg);
  const result=await runtime.call('dialogues_context_ack',args);
  assert.equal(result.structuredContent.acknowledged,true);
 }finally{await runtime.close();await listener?.close();}
});

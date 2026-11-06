// ABOUTME: Проверяет отказ, понятную диагностику и исправленный повтор через настоящий MCP.
// ABOUTME: Хранилище синтетическое; журнал не должен содержать текст и metadata сообщений.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../dist/mcp.js';
import {DialoguesFault} from '../dist/domain.js';
import {inputExample,finishExample,toolDefinitions,agentInstructions} from '../dist/api.js';

test('MCP: агент исправляет поля из отказа, повтор сохраняется один раз, примеры исполнимы',async()=>{
 const logs=[],saved=[],store={
  async turnInput(owner,args){saved.push(args);return {dialogue_id:args.dialogue.id,turn_id:'test-turn',version:'1',messages:[{id:args.messages[0].id}]};},
  async turnFinish(owner,args){if(args.expected_version==='2')throw new DialoguesFault('VERSION_CONFLICT');
   if(args.expected_version==='3')throw Error('PRIVATE_DATABASE_ERROR');
   if(args.expected_version==='4')return {status:'completed',payload:'x'.repeat(66000)};
   return {status:'completed',final:args.final};},
  async turnGet(){return {version:'1'};},async logExchange(){},
  async pull(){return {items:[],context_status:'no_updates',delivery_id:null};},
  async ack(){return {acknowledged:true};}
 };
 const cfg={host:'127.0.0.1',port:0,owner:'synthetic',hosts:['initial'],origins:['http://initial'],token:'synthetic-token-012345678901234567890123456789'};
 const listener=await startMcp(store,cfg,entry=>logs.push(entry)),url=new URL(listener.url);
 cfg.hosts.push(url.host);cfg.origins.push(url.origin);
 const client=new Client({name:'agent-recovery-test',version:'1'});
 const call=packet=>client.callTool({name:'dialogues_exchange',arguments:packet});
 try{
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+cfg.token}}}));
  const listed=(await client.listTools()).tools.find(tool=>tool.name==='dialogues_exchange');
  assert.ok(listed.description.includes(JSON.stringify(inputExample)));
  assert.ok(listed.description.includes(JSON.stringify(finishExample)));
  assert.match(agentInstructions,/сразу повтори с новым request_id/);
  const base=structuredClone(inputExample);
  base.arguments.messages[0].text='PRIVATE_TEXT';base.arguments.messages[0].source={token:'PRIVATE_TOKEN',nested:{personal:'PRIVATE_SOURCE'}};
  const cases=[
   ['arguments.dialogue.channel',p=>delete p.arguments.dialogue.channel],
   ['arguments.dialogue.id',p=>{p.arguments.dialogue.external_id=p.arguments.dialogue.id;delete p.arguments.dialogue.id;}],
   ['arguments.messages[0].role',p=>p.arguments.messages[0].role='user'],
   ['arguments.messages[0].turn_id',p=>p.arguments.messages[0].turn_id='old-turn'],
   ['arguments.messages[0].summary',p=>p.arguments.messages[0].text='😀'.repeat(101)],
   ['arguments.messages[0].source',p=>p.arguments.messages[0].source=[]],
   ['arguments.messages[0].occurred_at',p=>p.arguments.messages[0].occurred_at='yesterday'],
   ['arguments.messages[0].id',p=>p.arguments.messages[0].id='bad id'],
   ['context.consumer_id',p=>p.context.consumer_id='bad id'],
   ['arguments.messages[0].summary',p=>p.arguments.messages[0].summary=' '],
   ['action',p=>p.action='bad-action'],
   ['arguments.PRIVATE_UNKNOWN_KEY',p=>p.arguments.PRIVATE_UNKNOWN_KEY='PRIVATE_VALUE']
  ];
  for(const [field,mutate] of cases){
   const packet=structuredClone(base);packet.arguments.request_id='rejected-'+logs.length;mutate(packet);
   const result=await call(packet);assert.equal(result.isError,true);
   const error=JSON.parse(result.content[0].text);
   assert.equal(error.code,'INVALID_ARGUMENT');assert.equal(error.field,field);
   assert.equal(error.applied,false);assert.ok(error.expected);assert.match(error.next_action,/сразу повторите/);
   assert.equal(saved.length,0);assert.equal(logs.at(-1).field,field.includes('PRIVATE_UNKNOWN_KEY')?'arguments.<unknown>':field);
   assert.equal(logs.at(-1).request_id,packet.arguments.request_id);
   assert.equal(logs.at(-1).event,'request_rejected');
   assert.equal(typeof logs.at(-1).duration_ms,'number');
   if(field.endsWith('.role'))assert.deepEqual(error.allowed,['id','text','occurred_at','source','summary']);
  }
  const fixed=structuredClone(base);fixed.arguments.request_id='corrected-request';
  const result=await call(fixed);assert.equal(result.isError,undefined);assert.equal(result.structuredContent.messages[0].id,base.arguments.messages[0].id);
  assert.equal(saved.length,1);assert.equal(saved[0].messages[0].text,'PRIVATE_TEXT');
  const example=await call(inputExample);assert.equal(example.isError,undefined);
  const final=structuredClone(finishExample);final.arguments.turn_id=result.structuredContent.turn_id;
  const completed=await call(final);assert.equal(completed.structuredContent.status,'completed');
  final.arguments.expected_version='2';
  const conflict=await call(final);assert.equal(conflict.structuredContent.status,'rejected');assert.equal(logs.at(-1).code,'VERSION_CONFLICT');
  final.arguments.expected_version='3';
  const internal=await call(final);const error=JSON.parse(internal.content[0].text);
  assert.equal(error.code,'INTERNAL');assert.equal(error.applied,undefined);assert.match(error.next_action,/сначала проверьте/);
  assert.equal(logs.at(-1).applied,undefined);
  final.arguments.expected_version='4';
  const oversized=JSON.parse((await call(final)).content[0].text);
  assert.equal(oversized.code,'RESPONSE_TOO_LARGE');assert.equal(oversized.applied,undefined);assert.match(oversized.next_action,/сначала проверьте/);
  const ack=await client.callTool({name:'dialogues_context_ack',arguments:{request_id:'ack-invalid',consumer_id:'reader',context_instance_id:'instance'}});
  assert.equal(JSON.parse(ack.content[0].text).field,'delivery_id');
  assert.equal(logs.at(-1).tool,'dialogues_context_ack');
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_|synthetic-token/);
  assert.equal(toolDefinitions.length,2);
 }finally{await client.close();await listener.close();}
});

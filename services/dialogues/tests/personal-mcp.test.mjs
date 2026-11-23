// ABOUTME: Проверяет персональный MCP до операции и перед выдачей результата.
// ABOUTME: Использует синтетические store/Auth, не рабочую память или credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../dist/mcp.js';
import {suggestTopic} from '../dist/topic-socket.js';
test('MCP: другой адресат и отозванный после commit доступ не раскрывают результат',async()=>{
 let allowed=true,writes=0;
 const secret='private-data-must-not-escape';
 const store={
  async logExchange(){},
  async pull(){return {context_status:'no_updates',items:[],delivery_id:null};},
  async append(owner){assert.equal(owner,'data-a');writes++;allowed=false;return {secret};}
 };
 const cfg={host:'127.0.0.1',port:0,owner:'data-a',hosts:['initial'],origins:['http://initial'],
  token:'personal-token-012345678901234567890123456789',
  personal:{userId:'account-a',profileId:'profile-a',authorize:async()=>{if(!allowed)throw new Error('Auth denied');}}};
 const listener=await startMcp(store,cfg),url=new URL(listener.url);cfg.hosts.push(url.host);cfg.origins.push(url.origin);
 const client=new Client({name:'personal-test',version:'1'});
 const headers={Authorization:'Bearer '+cfg.token,'x-brai-user-id':'account-a','x-brai-profile-id':'profile-a'};
 try{
  assert.equal((await fetch(listener.url,{method:'POST',headers:{...headers,'x-brai-user-id':'account-b'}})).status,403);
  assert.equal((await fetch(listener.url,{method:'POST',headers:{Authorization:headers.Authorization}})).status,403);
  assert.equal(writes,0);
  assert.equal((await fetch(listener.url,{method:'POST',headers:{...headers,'mcp-session-id':'foreign-session'},body:'{}'})).status,404);
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers}}));
  assert.equal((await client.listTools()).tools.length,2);
  const response=await client.callTool({name:'dialogues_exchange',arguments:{action:'import',
   arguments:{request_id:'import',dialogue:{id:'chat',channel:'synthetic'},messages:[{id:'message',turn_id:'turn',role:'user',kind:'input',text:'hello'}]},
   context:{consumer_id:'personal',context_instance_id:'instance'}}});
  assert.equal(writes,1);assert.equal(response.isError,true);
  assert.equal(JSON.stringify(response).includes(secret),false);
  const fault=JSON.parse(response.content[0].text);
  assert.equal(fault.code,'INTERNAL');assert.equal('applied' in fault,false);
 }finally{await client.close().catch(()=>{});await listener.close();}
});

test('topic endpoint authenticates the profile and never returns a revoked proposal',async()=>{
 let allowed=true;
 const requests=[];
 const cfg={host:'127.0.0.1',port:0,owner:'data-a',hosts:['initial'],origins:['http://initial'],
  token:'personal-token-012345678901234567890123456789',
  personal:{userId:'account-a',profileId:'profile-a',operatorToken:'operator-token-012345678901234567890123456789',
   authorize:async()=>{if(!allowed)throw new Error('Auth denied');},
   suggestTopic:input=>suggestTopic(input,{structured:async(request,config)=>{
    requests.push({request:JSON.parse(request),schema:config.schema});
    if(requests.length===3)allowed=false;
    return JSON.stringify({title:'Уход за садом — сезонный план работ',icon:requests.at(-1).request.icons.length?1:null});
   }})}};
 const listener=await startMcp({},cfg),url=new URL('/telegram-topic-suggestion',listener.url);
 cfg.hosts.push(url.host);cfg.origins.push(url.origin);
 const headers={Authorization:'Bearer '+cfg.token,'x-brai-user-id':'account-a','x-brai-profile-id':'profile-a'};
 const request={request:'Спланируй сад',icons:['🐾','🌿']};
 const post=(head,body=request)=>fetch(url,{method:'POST',headers:head,body:JSON.stringify(body)});
 try{
  assert.equal((await post({...headers,Authorization:'Bearer '+cfg.personal.operatorToken})).status,401);
  assert.equal((await post({...headers,'x-brai-profile-id':'profile-b'})).status,403);
  assert.equal((await post({...headers,Origin:'https://foreign.example'})).status,403);
  assert.equal(requests.length,0);
  const response=await post(headers);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{title:'Уход за садом',icon:1});
  assert.deepEqual(requests[0].request,request);
  assert.deepEqual(requests[0].schema.properties.icon.enum,[0,1]);
  const rename=await post(headers,{request:'План сада',icons:[]});
  assert.deepEqual(await rename.json(),{title:'Уход за садом',icon:null});
  assert.equal(requests[1].schema.properties.icon.type,'null');
  const revoked=await post(headers);
  assert.equal(revoked.status,500);
  assert.equal(await revoked.text(),'');
  assert.equal(requests.length,3);
 }finally{await listener.close();}
});

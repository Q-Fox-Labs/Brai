// ABOUTME: Проверяет персональный MCP до операции и перед выдачей результата.
// ABOUTME: Использует синтетические store/Auth, не рабочую память или credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startMcp} from '../dist/mcp.js';
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

test('удержание RELEASE закрывает и существующий MCP сеанс до публикации',async()=>{
 let held=false;
 const cfg={host:'127.0.0.1',port:0,owner:'archive',hosts:['initial'],origins:['http://initial'],
  token:'standard-token-012345678901234567890123456789',
  hold:{active:()=>held,token:'private-probe-012345678901234567890123456789'},
  personal:{userId:'account',profileId:'profile',authorize:async()=>{}}};
 const listener=await startMcp({},cfg),url=new URL(listener.url);cfg.hosts.push(url.host);cfg.origins.push(url.origin);
 const headers={Authorization:'Bearer '+cfg.token,'x-brai-user-id':'account','x-brai-profile-id':'profile'};
 const client=new Client({name:'ordinary',version:'1'});
 const probe=new Client({name:'release-probe',version:'1'});
 try{
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers}}));
  held=true;
  await assert.rejects(client.listTools(),{code:503});
  assert.equal((await fetch(url,{method:'POST',headers})).status,503);
  await probe.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{...headers,'x-brai-release-probe':cfg.hold.token}}}));
  assert.equal((await probe.listTools()).tools.length,2);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'x-brai-release-probe':cfg.hold.token,'x-brai-user-id':'foreign'}})).status,403);
  held=false;
  assert.equal((await client.listTools()).tools.length,2);
 }finally{await Promise.allSettled([client.close(),probe.close()]);await listener.close();}
});

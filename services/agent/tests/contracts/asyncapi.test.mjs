// ABOUTME: Проверяет AsyncAPI по официальной схеме и сверяет ссылки с DTO владельца.
// ABOUTME: Не использует parser с несовместимой Spectral/Ajv версией.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const api=JSON.parse(await readFile(new URL('../../asyncapi.json',import.meta.url),'utf8'));
const dto=JSON.parse(await readFile(new URL('../../schemas/messages.schema.json',import.meta.url),'utf8'));
const meta=JSON.parse(await readFile(new URL('../../../../node_modules/@asyncapi/specs/schemas/3.0.0-without-$id.json',import.meta.url),'utf8'));

function refs(value,into=[]){if(!value||typeof value!=='object')return into;for(const [key,child]of Object.entries(value)){if(key==='$ref'&&typeof child==='string')into.push(child);else refs(child,into);}return into;}
function resolvePointer(root,pointer){let current=root;for(const segment of pointer.split('/').slice(1).map(v=>v.replace(/~1/g,'/').replace(/~0/g,'~')))current=current?.[segment];return current;}

test('AsyncAPI validates against the released 3.0.0 official schema',()=>{
  const ajv=new Ajv({allErrors:true,strict:false});addFormats(ajv);const check=ajv.compile(meta);
  assert.equal(check(api),true,JSON.stringify(check.errors,null,2));
});

test('all message refs, subjects and request/reply pairs resolve to owner DTOs',()=>{
  const all=refs(api);
  for(const ref of all){
    if(ref.startsWith('#/'))assert.notEqual(resolvePointer(api,ref.slice(1)),undefined,`unresolved ${ref}`);
    else if(ref.startsWith('schemas/messages.schema.json#'))assert.notEqual(resolvePointer(dto,ref.split('#')[1]),undefined,`unresolved ${ref}`);
    else assert.fail(`unexpected reference ${ref}`);
  }
  const expected=['brai.agent.v1.query.projects','brai.agent.v1.query.status','brai.agent.v1.query.threads','brai.agent.v1.query.thread','brai.agent.v1.query.history','brai.agent.v1.command.thread.create','brai.agent.v1.command.turn.start','brai.agent.v1.command.turn.steer','brai.agent.v1.command.turn.interrupt','brai.agent.v1.command.request.respond','brai.agent.v1.event'];
  assert.deepEqual(Object.values(api.channels).filter(channel=>channel.address!==null).map(channel=>channel.address),expected);
  for(const operation of Object.values(api.operations)){
    assert.ok(operation.channel.$ref);
    if(operation.action==='send'&&operation.channel.$ref!=='#/channels/events')assert.ok(operation.reply?.channel?.$ref,'request endpoint needs reply mapping');
  }
  assert.equal(api.operations.publishAgentEvent.action,'send');
  assert.equal(api.operations.consumeAgentEvent.action,'receive');
  for(const [name,operation] of Object.entries(api.operations)) if(operation['x-error-message']) assert.ok(resolvePointer(api,operation['x-error-message'].slice(1)),`${name} error message ref`);
  assert.equal(api.info['x-nats-service'].name,'brai_agent');
  assert.equal(api.info['x-nats-service'].queueGroup,'brai_agent');
});


test('native reply subject is separate from requests and retains the response payload references',()=>{
  const replies=api.channels.replies;
  assert.equal(replies.address,null);
  assert.equal(replies['x-nats-reply-subject'],'message.reply');
  const expected={projects:'ProjectsResponse',status:'StatusResponse',threads:'ThreadsResponse',thread:'ThreadSnapshot',history:'HistoryResponse',threadCreate:'ThreadCreateResponse',turnStart:'TurnMutationResponse',turnSteer:'TurnMutationResponse',turnInterrupt:'TurnMutationResponse',requestRespond:'RequestRespondResponse'};
  let count=0;
  for(const operation of Object.values(api.operations)){
    if(!operation.reply)continue;
    count++;
    const channel=operation.channel.$ref.split('/').at(-1);
    assert.equal(operation.reply.channel.$ref,'#/channels/replies');
    assert.notEqual(operation.reply.channel.$ref,operation.channel.$ref);
    for(const message of operation.reply.messages){
      assert.ok(message.$ref.startsWith('#/channels/replies/messages/'));
      const response=resolvePointer(api,message.$ref.slice(1));
      assert.equal(response.$ref,`#/components/messages/${expected[channel]}`);
      const component=resolvePointer(api,response.$ref.slice(1));
      assert.equal(component.payload.$ref,`schemas/messages.schema.json#/definitions/${expected[channel]}`);
    }
  }
  assert.equal(count,10);
});

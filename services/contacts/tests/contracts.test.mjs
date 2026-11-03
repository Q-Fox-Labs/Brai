// ABOUTME: Проверяет машинный контракт, ограничения и безопасные ошибки.
// ABOUTME: Не обращается к PostgreSQL, NATS или Temporal.
import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {request,valid,response,operations,hash} from '../dist/contracts.js';
import {validateConfig} from '../dist/config.js';
const q=()=>({operationId:'op',packetId:'11111111-1111-4111-8111-111111111111',ownerId:'owner',sourceId:'telegram',identity:{namespace:'telegram',externalId:'123'},observedAt:'2026-10-31T10:00:00.000001Z',profile:{}});
test('all six operations have closed request and response DTO',()=>{assert.equal(operations.length,6);for(const op of operations){assert.equal(valid(op+'Request',{unexpected:true}),false);}assert.deepEqual(request('contacts.list',{ownerId:'owner'}),{ownerId:'owner',limit:50,cursor:null});});
test('Telegram IDs are strings, namespace fixed, null distinct from missing and empty',()=>{assert.deepEqual(request('resolve',q()).profile,{});assert.deepEqual(request('resolve',{...q(),profile:{name:null}}).profile,{name:null});for(const profile of [{name:''},{name:'x'.repeat(256)},{other:1}])assert.throws(()=>request('resolve',{...q(),profile}),{code:'INVALID_REQUEST'});assert.throws(()=>request('profile.observe',Object.fromEntries(Object.entries(q()).filter(([k])=>k!=='packetId'))),{code:'INVALID_REQUEST'});assert.throws(()=>request('resolve',{...q(),identity:{namespace:'email',externalId:'123'}}),{code:'UNSUPPORTED_NAMESPACE'});for(const id of [123,'0','001','-1'])assert.throws(()=>request('resolve',{...q(),identity:{namespace:'telegram',externalId:id}}));});
test('unrepresentable JSON and invalid caller bindings rejected before startup',()=>{assert.throws(()=>request('resolve',{...q(),profile:{name:'\u0000'}}));assert.throws(()=>request('resolve',{...q(),profile:{name:'\ud800'}}));const c={databaseUrl:'postgresql://localhost/contacts',natsUrl:'nats://localhost:4222',natsOptionsFile:'/protected/nats',cursorKeyFile:'/protected/key',callers:{intake:{ownerIds:['owner'],sourceIds:['telegram'],operations:['resolve']}}};assert.deepEqual(validateConfig(c),c);assert.throws(()=>validateConfig({...c,callers:{intake:{...c.callers.intake,operations:['other']}}}));});
test('canonical hash preserves null, arrays and UUID spelling',()=>{assert.equal(hash({b:1,a:2}),hash({a:2,b:1}));assert.notEqual(hash({}),hash({name:null}));assert.notEqual(hash({packetId:'aabb'}),hash({packetId:'AABB'}));assert.throws(()=>response('status',{ready:true}),{code:'INTERNAL'});});

test('AsyncAPI reply inbox and every owner schema reference agree with actual operations',()=>{
 const yaml=readFileSync(new URL('../asyncapi.yaml',import.meta.url),'utf8');assert.match(yaml,/replies:\n    address: null/);
 const refs=[...yaml.matchAll(/\$ref:\s+['"]?\.\/schemas\/(api|common)\.schema\.json#\/definitions\/([A-Za-z0-9_.-]+)/g)];assert.equal(refs.length,13);
 for(const[,owner,name]of refs)assert.doesNotThrow(()=>valid(name,{},owner==='common'));
});

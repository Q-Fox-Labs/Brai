// ABOUTME: Проверяет машинный контракт, правила и защищённую пагинацию Каналов.
// ABOUTME: Не использует БД, сеть или сообщения рабочих каналов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validate,request,hash,operations,profile} from '../dist/contracts.js';
import {checkRules,evaluate} from '../dist/rules.js';
import {validateConfig} from '../dist/config.js';
import {encodeCursor,decodeCursor} from '../dist/cursor.js';
const id='11111111-1111-4111-8111-111111111111';
const input={operationId:'op',packetId:id,ownerId:'owner',sourceId:'telegram',asOf:'2026-10-31T00:00:00Z',eventType:'message.incoming',direction:'incoming',sourceRef:{botId:'123',chatId:'456',threadId:null},author:{kind:'human',id:'456'},facts:{hasText:true,contentKinds:['text']},replyTo:null};
test('all fourteen operations have closed schemas and declared profile',()=>{
 assert.equal(operations.length,14);assert.ok(validate('profile',profile,true));
 assert.ok(validate('resolveRequest',input,true));assert.equal(validate('resolveRequest',{...input,token:'secret'},true),false);
 for(const sourceRef of [{botId:'123',chatId:'456',threadId:0},{botId:'123',chatId:'456',threadId:'0'},{botId:'123',chatId:456,threadId:null}])assert.equal(validate('resolveRequest',{...input,sourceRef},true),false);
 const q=request('resolve',input);assert.deepEqual(q.initialFields,{});assert.deepEqual(input.initialFields,undefined);
 assert.throws(()=>request('types.get',{type:{code:'mail',version:1}}),{code:'UNSUPPORTED_PROFILE'});
});
test('normalization only sorts the author set, keeps rule arrays and null',()=>{
 const q={requestId:id,ownerId:'owner',actorId:null,reason:'test',type:{code:'telegram',version:1},sourceId:'source',botId:'123',settings:{name:'test',enabled:true,credentialsRef:'bot_main',allowedActorIds:['2','1'],extensions:{}}};
 const value=request('connections.create',q);assert.deepEqual(value.settings.allowedActorIds,['1','2']);assert.deepEqual(q.settings.allowedActorIds,['2','1']);
 assert.equal(hash({a:1,b:null}),hash({b:null,a:1}));assert.notEqual(hash([1,2]),hash([2,1]));
 assert.throws(()=>request('connections.create',{...q,settings:{...q.settings,allowedActorIds:['1','1']}}));
 assert.throws(()=>request('connections.create',{...q,settings:{...q.settings,extensions:{'x.y':'x'.repeat(8193)}}}));
});
test('rules are deterministic, retain explicit null and explain the final writer',()=>{
 const rules=[{id:'high',priority:20,when:[],assign:[{field:'title',mode:'override',value:'new'}]},{id:'low',priority:10,when:[],assign:[{field:'title',mode:'fill_missing',value:'old'},{field:'creatorRef',mode:'fill_missing',value:{kind:'person',id:'p'}}]}];
 checkRules(rules);const result=evaluate(rules,{...input,initialFields:{creatorRef:null}},hash(rules));
 assert.deepEqual(result.assignments,{creatorRef:null,title:'new'});assert.equal(result.fieldOrigins.creatorRef.source,'input');
 assert.equal(result.fieldOrigins.title.ruleId,'high');assert.deepEqual(result.appliedRules.map(r=>r.ruleId),['low','high']);
 assert.deepEqual(rules[0].id,'high');
});
test('AND, exists, in and false values have distinct meanings',()=>{
 const r={id:'rule',priority:0,when:[{field:'facts.hasText',op:'exists',value:true},{field:'facts.hasText',op:'equals',value:false},{field:'facts.contentKinds',op:'in',value:['image','video']}],assign:[{field:'categoryRefs',mode:'fill_missing',value:['images']}]};
 assert.deepEqual(evaluate([r],{...input,facts:{hasText:false,contentKinds:['image']},initialFields:{}},'v').assignments,{categoryRefs:['images']});
 assert.deepEqual(evaluate([r],input,'v').assignments,{});
});
test('same priority conflicts and repeated rule IDs are rejected before publication',()=>{
 const r={id:'r',priority:0,when:[],assign:[{field:'title',mode:'override',value:'a'}]};
 assert.throws(()=>checkRules([r,{...r,id:'other'}]),{code:'INVALID_RULE_SET'});
 assert.throws(()=>checkRules([r,{...r,priority:1}]),{code:'INVALID_RULE_SET'});
 assert.throws(()=>checkRules([{...r,assign:[...r.assign,...r.assign]}]),{code:'INVALID_RULE_SET'});
});
test('cursor binds caller, owner and filters and rejects modification',()=>{
 const key=Buffer.alloc(32,7),scope={caller:'a',owner:'owner',filter:null},cursor=encodeCursor(key,scope,id);
 assert.equal(decodeCursor(key,scope,cursor),id);
 assert.throws(()=>decodeCursor(key,{...scope,caller:'b'},cursor),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>decodeCursor(key,scope,cursor+'x'),{code:'INVALID_ARGUMENT'});
});

test('all AsyncAPI request, reply and error references compile and caller operations are unique',()=>{
 const yaml=readFileSync(new URL('../asyncapi.yaml',import.meta.url),'utf8');
 const refs=[...yaml.matchAll(/\$ref:\s+['"]?\.\/schemas\/(api|common)\.schema\.json#\/definitions\/([A-Za-z0-9_.-]+)/g)];
 assert.ok(refs.length>=29);
 for(const [,owner,name]of refs)assert.doesNotThrow(()=>validate(name,{},owner==='common'),name);
 const b={ownerIds:['owner'],operations:['resolve','resolve'],sourceIds:['telegram'],replySourceIds:[],connectionIds:null};
 assert.throws(()=>validateConfig({databaseUrl:'postgresql://test',natsUrl:'nats://test',natsOptionsFile:'/protected/nats',cursorKeyFile:'/protected/key',callers:{test:b}}),/INVALID_CALLER_BINDING/);
});

test('invalid binding IDs and duplicates fail before ready; valid UUID casing is normalized',()=>{
 const binding={ownerIds:['owner'],operations:['resolve'],sourceIds:['telegram'],replySourceIds:['fixture_hermes'],connectionIds:null};
 const cfg={databaseUrl:'postgresql://localhost/test',natsUrl:'nats://localhost:4222',natsOptionsFile:'/protected/nats',cursorKeyFile:'/protected/key',callers:{test:binding}};
 for(const bad of [{connectionIds:['not-a-uuid']},{sourceIds:['INVALID SOURCE']},{replySourceIds:['bad-source!']},{sourceIds:['telegram','telegram']},{ownerIds:[' ']},{extra:true}])assert.throws(()=>validateConfig({...cfg,callers:{test:{...binding,...bad}}}),/INVALID_CALLER_BINDING/);
 assert.throws(()=>validateConfig({...cfg,natsUrl:'https://localhost'}),/INVALID_CHANNELS_CONFIG/);
 const uuid='ABCDEFAB-1111-4111-8111-111111111111';
 assert.deepEqual(validateConfig({...cfg,callers:{test:{...binding,connectionIds:[uuid]}}}).callers.test.connectionIds,[uuid.toLowerCase()]);
});

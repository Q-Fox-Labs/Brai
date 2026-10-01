// ABOUTME: Проверяет DTO агента, пределы размера и браузерно-безопасный экспорт.
// ABOUTME: Проверяет контрактные данные; соблюдение пределов сервисом не доказывает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { jsonSchema as draft07 } from '@json-schema-tools/meta-schema';
import { messagesSchema, subjects, limits, validateDto, assertDto, validateEventEnvelope, validateAguiEvent, serializedBytes, validateUpstreamAnswer } from '../../contracts/index.mjs';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const validStart = { projectId: 'work:alpha', threadId: 'thread opaque/1', generation: uuid, operationId: 'op-a', text: 'hello' };

test('DTO schema is strict and validators do not mutate or coerce input', () => {
  const input = structuredClone(validStart);
  assert.equal(validateDto('TurnStartRequest', input), true);
  assert.deepEqual(input, validStart);
  assert.equal(validateDto('TurnStartRequest', { ...input, surprise: true }), false);
  assert.equal(validateDto('TurnStartRequest', { ...input, generation: 'not-uuid' }), false);
  assert.equal(validateDto('TurnStartRequest', { ...input, text: 4 }), false);
  assert.throws(() => assertDto('TurnStartRequest', { ...input, secret: 'private' }), /Некорректный DTO TurnStartRequest/);
});

test('serialized UTF-8 budgets account for JSON escaping and multibyte input', () => {
  const escaped = { ...validStart, text: '😀'.repeat(17000) };
  assert.ok(escaped.text.length < limits.inputTextBytes);
  assert.ok(serializedBytes(escaped) > limits.inputTextBytes);
  assert.equal(validateDto('TurnStartRequest', escaped), false);
  assert.equal(validateDto('TurnStartRequest', { ...validStart, text: 'x'.repeat(64000) }), true);
});

test('snapshots and request limits are explicit in DTO validation', () => {
  const snapshot = { projectId:'p', threadId:'t', generation:uuid, streamEpoch:uuid, seq:0, state:'waiting', messages:[], pendingRequests:[], truncation:{truncated:false,reason:'none'}, activeTurnId:null, turnStatus:null, traceItems:[] };
  assert.equal(validateDto('ThreadSnapshot', snapshot), true);
  assert.equal(validateDto('ThreadSnapshot', { ...snapshot, seq: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(validateDto('ThreadSnapshot', { ...snapshot, pendingRequests: Array(65).fill({}) }), false);
  assert.equal(validateDto('PendingRequest',{requestId:null,kind:'unsupported',method:'future/method',reason:'unknown-method',code:'UNSUPPORTED',threadId:'t',turnId:null,itemId:null,interruptAvailable:true}),true);
  assert.equal(validateDto('ThreadsRequest', { projectId:'p', limit:101 }), false);
  const pending={requestId:'req',kind:'question',params:{isBlocking:true,itemId:'i',questions:[],threadId:'t',turnId:'u'}};
  assert.equal(validateDto('PendingRequest',pending),true);
  assert.equal(validateDto('PendingRequest',{...pending,params:{threadId:'t'}}),false);
  assert.equal(validateDto('ThreadSnapshot',{...snapshot,pendingRequests:[pending]}),true);
  assert.equal(validateDto('ProjectsResponse',{generation:uuid,projects:[{projectId:'p',name:'x'.repeat(40000),available:true},{projectId:'q',name:'y'.repeat(40000),available:true}]}),false);
  assert.equal(subjects.event, 'brai.agent.v1.event');
});

test('local event envelope checks opaque IDs, generation and safe sequence', () => {
  const event = { projectId:'p', threadId:'opaque', turnId:null, generation:uuid, streamEpoch:uuid, seq:3, event:{type:'RUN_STARTED',threadId:'opaque',runId:'r'} };
  assert.equal(validateEventEnvelope(event), true);
  assert.equal(validateEventEnvelope({ ...event, extra:true }), false);
  assert.equal(validateEventEnvelope({ ...event, seq:1.5 }), false);
  assert.equal(validateEventEnvelope({ ...event, generation:'g' }), false);
});

test('schema formally validates as Draft-07 and all local references resolve', async () => {
  const ajv = new Ajv({ allErrors:true, strict:false }); addFormats(ajv); ajv.addSchema(draft07);
  const valid = ajv.compile(draft07);
  assert.equal(valid(messagesSchema), true, JSON.stringify(valid.errors));
  const refs = [];
  const scan = node => { if (!node || typeof node !== 'object') return; for (const [key,value] of Object.entries(node)) { if (key === '$ref') refs.push(value); else scan(value); } };
  scan(messagesSchema);
  for (const ref of refs) {
    if(ref.startsWith('#/definitions/')) assert.ok(messagesSchema.definitions[ref.slice('#/definitions/'.length)], `unresolved ${ref}`);
    else { assert.match(ref,/^https:\/\/brai.dev\/contracts\/codex\/schema.json#\/definitions\//); const codex=JSON.parse(await readFile(new URL('../../contracts/codex/schema.json',import.meta.url))); assert.ok(codex.definitions[ref.split('/').at(-1)],`unresolved ${ref}`); }
  }
  const source = await readFile(new URL('../../contracts/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|readFile/);
});

test('public event validation delegates to the pinned AG-UI SDK', () => {
  assert.equal(validateAguiEvent({ type:'RUN_STARTED', threadId:'t', runId:'r' }), true);
  assert.equal(validateAguiEvent({ type:'RUN_FINISHED', threadId:'t', runId:'r', outcome:{type:'success'} }), true);
  assert.equal(validateAguiEvent({ type:'RUN_FINISHED', threadId:'t', runId:'r', outcome:{type:'made-up'} }), false);
  assert.equal(validateAguiEvent({ type:'TOOL_CALL_END', toolCallId:'tool', messageId:'m' }), true);
  assert.equal(validateAguiEvent({ type:'RUN_FINISHED', threadId:'t', runId:'r', outcome:{type:'success'}, bogus:true }), true);
});


test('upstream answer validation binds decisions to the actual pending request', async () => {
  const codex=JSON.parse(await readFile(new URL('../../contracts/codex/schema.json',import.meta.url)));
  const command={threadId:'t',turnId:'u',itemId:'i',startedAtMs:1,command:'echo ok',availableDecisions:['accept','decline']};
  assert.equal(validateUpstreamAnswer('command-approval',{decision:'accept'},command),true);
  assert.equal(validateUpstreamAnswer('command-approval',{decision:'cancel'},command),false);
  const questions={threadId:'t',turnId:'u',itemId:'i',isBlocking:true,questions:[{id:'q1',header:'Question',question:'Choose'}]};
  assert.equal(validateUpstreamAnswer('question',{answers:{q1:{answers:['A']}}},questions),true);
  assert.equal(validateUpstreamAnswer('question',{answers:{other:{answers:['A']}}},questions),false);
  const permissionParams={threadId:'t',turnId:'u',itemId:'i',cwd:'/workspace',startedAtMs:1,permissions:{network:{enabled:true}}};
  assert.equal(validateUpstreamAnswer('permissions',{scope:'turn',permissions:{network:{enabled:true}}},permissionParams),true);
  const filesystem={...permissionParams,permissions:{fileSystem:{entries:[{path:{type:'path',path:'/workspace'},access:'read'}]}}};
  assert.equal(validateUpstreamAnswer('permissions',{scope:'turn',permissions:{fileSystem:{entries:[{access:'read',path:{path:'/workspace',type:'path'}}]}}},filesystem),true);
  assert.equal(validateUpstreamAnswer('permissions',{scope:'turn',permissions:{fileSystem:{entries:[{access:'write',path:{type:'path',path:'/workspace'}}]}}},filesystem),false);
  assert.equal(validateUpstreamAnswer('permissions',{scope:'turn',permissions:{network:{enabled:false}}},permissionParams),true);
  const restricted={...permissionParams,permissions:{network:{enabled:false}}};
  assert.equal(validateUpstreamAnswer('permissions',{scope:'turn',permissions:{network:{enabled:true}}},restricted),false);
  assert.ok(codex.definitions.PermissionsRequestApprovalParams);
});


test('request response DTO validates the upstream answer for its discriminated kind',()=>{
  const request={projectId:'p',threadId:'t',generation:uuid,operationId:'op-answer',requestId:'r',kind:'command-approval',answer:{decision:'accept'}};
  assert.equal(validateDto('RequestRespondRequest',request),true);
  assert.equal(validateDto('RequestRespondRequest',{...request,answer:{decision:'made-up'}}),false);
  assert.equal(validateDto('RequestRespondRequest',{...request,kind:'unknown'}),false);
});

test('request opened custom event rejects a single form exceeding 32 KiB',()=>{
  const request={requestId:'r',kind:'question',params:{threadId:'t',turnId:'u',itemId:'i',isBlocking:true,questions:[{id:'q',header:'Question',question:'x'.repeat(limits.pendingFormBytes)}]}};
  assert.ok(serializedBytes(request)>limits.pendingFormBytes);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.request.opened',value:{request}}),false);
});

test('phase metadata uses exact upstream values and only retained snapshot message IDs',()=>{
  const snapshot={projectId:'p',threadId:'t',generation:uuid,streamEpoch:uuid,seq:0,state:'ready',messages:[{id:'m',role:'assistant',content:'hello'}],pendingRequests:[],truncation:{truncated:false,reason:'none'},activeTurnId:null,turnStatus:null,traceItems:[]};
  assert.equal(validateDto('ThreadSnapshot',snapshot),true);
  for(const phase of ['commentary','final_answer',null]){
    assert.equal(validateDto('ThreadSnapshot',{...snapshot,messagePhases:{m:phase}}),true);
    assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.message.phase',value:{itemId:'m',phase}}),true);
    const history={generation:uuid,nextCursor:null,truncation:{truncated:false,reason:'none'},items:[{itemId:'m',order:0,kind:'agentMessage',content:'hello',turnId:'u',trace:{type:'message',status:'completed',phase},truncated:false,contentBytes:5}]};
    assert.equal(validateDto('HistoryResponse',history),true);
    assert.equal(validateDto('HistoryResponse',{...history,items:[{...history.items[0],trace:{type:'message',status:'completed',phase:'success'}}]}),false);
  }
  assert.equal(validateDto('ThreadSnapshot',{...snapshot,messagePhases:{m:'success'}}),false);
  assert.equal(validateDto('ThreadSnapshot',{...snapshot,messagePhases:{other:'commentary'}}),false);
  assert.equal(validateDto('ThreadSnapshot',{...snapshot,messagePhases:{m:{type:'commentary'}}}),false);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.message.phase',value:{itemId:'m',phase:'success'}}),false);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.message.phase',value:{itemId:'m'}}),false);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.message.phase',value:{itemId:'m',phase:null,extra:true}}),false);
  const messages=Array.from({length:256},(_,i)=>({id:`m${i}`,role:'assistant',content:'x'}));
  const messagePhases=Object.fromEntries(messages.map(message=>[message.id,'commentary']));
  assert.equal(validateDto('ThreadSnapshot',{...snapshot,messages,messagePhases}),true);
  assert.equal(validateDto('ThreadSnapshot',{...snapshot,messages,messagePhases:{...messagePhases,overflow:null}}),false);
  const oversized={...snapshot,messages:[{id:'m',role:'assistant',content:'😀'.repeat(limits.snapshotBytes/4)}],messagePhases:{m:'commentary'}};
  assert.ok(serializedBytes(oversized)>limits.snapshotBytes);
  assert.equal(validateDto('ThreadSnapshot',oversized),false);
});

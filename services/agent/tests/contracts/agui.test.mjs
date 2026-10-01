// ABOUTME: Проверяет стандартные и CUSTOM события через закреплённый SDK AG-UI.
// ABOUTME: Проверяет подключение и отключение SDK без живого сервиса и запуска хода.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAguiEvent, validateDto } from '../../contracts/index.mjs';

test('message deltas, terminal outcomes, and snapshot replacement use actual SDK event schemas', () => {
  const messageEvents = [
    {type:'TEXT_MESSAGE_START',messageId:'m',role:'assistant'},
    {type:'TEXT_MESSAGE_CONTENT',messageId:'m',delta:'hello'},
    {type:'TEXT_MESSAGE_END',messageId:'m'},
    {type:'MESSAGES_SNAPSHOT',messages:[{id:'m',role:'assistant',content:'hello'}]},
    {type:'RUN_FINISHED',threadId:'t',runId:'r',outcome:{type:'interrupt',interrupts:[{id:'i',reason:'approval pending'}]}},
    {type:'RUN_FINISHED',threadId:'t',runId:'r',outcome:{type:'cancelled'}},
    {type:'ACTIVITY_SNAPSHOT',messageId:'plan',activityType:'plan',content:{steps:[]}},
    {type:'ACTIVITY_DELTA',messageId:'plan',activityType:'plan',patch:[]},
    {type:'RUN_ERROR',threadId:'t',runId:'r',message:'failed'},
  ];
  for (const event of messageEvents) assert.equal(validateAguiEvent(event), true, JSON.stringify(event));
  assert.equal(validateAguiEvent({type:'RUN_FINISHED',threadId:'t',runId:'r',outcome:{type:'error'}}), false);
});

test('tool end is argument completion and result is a separate event', () => {
  assert.equal(validateAguiEvent({type:'TOOL_CALL_START',toolCallId:'tool',toolCallName:'exec'}), true);
  assert.equal(validateAguiEvent({type:'TOOL_CALL_ARGS',toolCallId:'tool',delta:'{}'}), true);
  assert.equal(validateAguiEvent({type:'TOOL_CALL_END',toolCallId:'tool',messageId:'m'}), true);
  assert.equal(validateAguiEvent({type:'TOOL_CALL_RESULT',toolCallId:'tool',messageId:'m',role:'tool',content:'done'}), true);
});

test('custom event namespace is accepted by AG-UI and envelope remains local', () => {
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.request.opened',value:{request:{requestId:'r',kind:'question',params:{isBlocking:true,itemId:'i',questions:[],threadId:'t',turnId:'u'}}}}), true);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.resync-required',value:{reason:'gap'}}), true);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.resync-required',value:{reason:'made-up'}}), false);
  assert.equal(validateAguiEvent({type:'CUSTOM',name:'brai.agent.unknown',value:{}}), false);
});

test('connectAgent applies deltas then the final snapshot and cancelled outcome without starting a turn', async () => {
  const {AbstractAgent}=await import('@ag-ui/client');
  const {EventEncoder}=await import('@ag-ui/encoder');
  const {Observable}=await import('rxjs');
  class FixtureAgent extends AbstractAgent {
    calls=0;
    connect(input){return new Observable(subscriber=>{
      for(const event of [
        {type:'RUN_STARTED',threadId:input.threadId,runId:input.runId},
        {type:'TEXT_MESSAGE_START',messageId:'m',role:'assistant'},
        {type:'TEXT_MESSAGE_CONTENT',messageId:'m',delta:'Hel'},
        {type:'TEXT_MESSAGE_CONTENT',messageId:'m',delta:'lo'},
        {type:'TEXT_MESSAGE_END',messageId:'m'},
        {type:'MESSAGES_SNAPSHOT',messages:[{id:'m',role:'assistant',content:'Hello'}]},
        {type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId,outcome:{type:'cancelled'}},
      ])subscriber.next(event);
      subscriber.complete();
    });}
    run(){this.calls++;throw new Error('Подключение не должно запускать ход');}
  }
  const agent=new FixtureAgent({threadId:'t'}),received=[],finished=[],contents=[];
  const result=await agent.connectAgent({}, {
    onEvent:({event})=>received.push(event),
    onRunFinishedEvent:({outcome})=>finished.push(outcome),
    onMessagesChanged:({messages})=>contents.push(messages.map(message=>message.content)),
  });
  assert.equal(agent.calls,0);
  assert.deepEqual(finished,['cancelled']);
  assert.deepEqual(result.newMessages,[{id:'m',role:'assistant',content:'Hello'}]);
  assert.deepEqual(agent.messages,[{id:'m',role:'assistant',content:'Hello'}]);
  assert.ok(contents.some(content=>content.includes('Hel')));
  assert.ok(contents.some(content=>content.includes('Hello')));
  const encoded=new EventEncoder().encodeSSE(received[0]);
  assert.match(encoded,/data: .*RUN_STARTED/s);
});

test('detachActiveRun closes a live connect subscription before the source completes', async () => {
  const {AbstractAgent}=await import('@ag-ui/client');
  const {Observable}=await import('rxjs');
  let source,closed=false,completed=false,ready;
  const subscribed=new Promise(resolve=>{ready=resolve;});
  class FixtureAgent extends AbstractAgent {
    calls=0;
    connect(input){return new Observable(subscriber=>{
      source=subscriber;
      subscriber.next({type:'RUN_STARTED',threadId:input.threadId,runId:input.runId});
      ready();
      return ()=>{closed=true;};
    });}
    run(){this.calls++;throw new Error('Подключение не должно запускать ход');}
  }
  const agent=new FixtureAgent({threadId:'existing'});
  const connection=agent.connectAgent({}, {onRunFinalized:()=>{completed=true;}});
  await subscribed;
  assert.equal(source.closed,false);
  assert.equal(closed,false);
  assert.equal(completed,false);
  await agent.detachActiveRun();
  await connection;
  assert.equal(source.closed,true);
  assert.equal(closed,true);
  assert.equal(agent.isRunning,false);
  assert.equal(agent.calls,0);
});

test('separate phase metadata survives real SDK enforcement and snapshot replacement',async()=>{
  const {AbstractAgent}=await import('@ag-ui/client');
  const {Observable}=await import('rxjs');
  const generation='550e8400-e29b-41d4-a716-446655440000';
  const snapshot={projectId:'p',threadId:'t',generation,streamEpoch:generation,seq:0,state:'ready',messages:[{id:'old',role:'assistant',content:'old'}],messagePhases:{old:'commentary'},pendingRequests:[],truncation:{truncated:false,reason:'none'},activeTurnId:null,turnStatus:null,traceItems:[]};
  assert.equal(validateDto('ThreadSnapshot',snapshot),true);
  // AIDEV-NOTE: Fixture моделирует независимую границу метаданных, а не SDK message reducer.
  let messagePhases={...snapshot.messagePhases},messages=snapshot.messages;
  const observed=[],phaseUpdates=[];
  class FixtureAgent extends AbstractAgent{
    connect(input){return new Observable(subscriber=>{
      for(const event of [
        {type:'RUN_STARTED',threadId:input.threadId,runId:input.runId},
        {type:'TEXT_MESSAGE_START',messageId:'m',role:'assistant',phase:'commentary'},
        {type:'CUSTOM',name:'brai.agent.message.phase',value:{itemId:'m',phase:'commentary'}},
        {type:'TEXT_MESSAGE_CONTENT',messageId:'m',delta:'Hello'},
        {type:'TEXT_MESSAGE_END',messageId:'m'},
        {type:'CUSTOM',name:'brai.agent.message.phase',value:{itemId:'m',phase:'final_answer'}},
        {type:'MESSAGES_SNAPSHOT',messages:[{id:'m',role:'assistant',content:'Hello',phase:'final_answer'},{id:'unknown',role:'assistant',content:'No phase'}]},
        {type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId,outcome:{type:'success'}},
      ]){
        assert.equal(validateAguiEvent(event),true);
        if(event.type==='CUSTOM'){
          messagePhases={...messagePhases,[event.value.itemId]:event.value.phase};
          phaseUpdates.push(event.value.phase);
        }
        subscriber.next(event);
      }
      subscriber.complete();
    });}
    run(){throw new Error('Fixture не запускает ход');}
  }
  const agent=new FixtureAgent({threadId:'t',messages:snapshot.messages});
  await agent.connectAgent({}, {onEvent:({messages:next})=>{messages=next;observed.push({...messagePhases});}});
  assert.equal(agent.messages.find(message=>message.id==='m').phase,undefined);
  assert.equal(messages.find(message=>message.id==='m').phase,undefined);
  assert.deepEqual(phaseUpdates,['commentary','final_answer']);
  assert.ok(observed.length>0);
  assert.ok(observed.every(map=>map.m==='final_answer'));
  assert.equal(messagePhases.m,'final_answer');
  assert.equal(messagePhases.unknown,undefined);
  const retainedIds=new Set(messages.map(message=>message.id));
  messagePhases=Object.fromEntries(Object.entries(messagePhases).filter(([id])=>retainedIds.has(id)));
  assert.deepEqual(messagePhases,{m:'final_answer'});
  // Свежий снимок заменяет карту; terminal не восполняет отсутствующую фазу.
  const restored={...snapshot,messages,messagePhases:{m:null}};
  assert.equal(validateDto('ThreadSnapshot',restored),true);
  messagePhases={...restored.messagePhases};
  assert.deepEqual(messagePhases,{m:null});
});

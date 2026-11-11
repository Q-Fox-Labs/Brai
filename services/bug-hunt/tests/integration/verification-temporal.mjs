// ABOUTME: Проверяет новый bundle на отдельной очереди настоящего Temporal без изменений общего сервера.
// ABOUTME: Activities синтетические; тест доказывает restart/replay, но не сквозной model/runner flow.
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {Connection,Client} from "@temporalio/client";
import {deliverVerification} from "../../dist/verification-worker.js";
import {Worker,NativeConnection} from "@temporalio/worker";
const codePath=fileURLToPath(new URL("../../dist/verification-workflow-bundle.cjs",import.meta.url));
test("own Temporal queue survives worker restart and replays without new Activities",{timeout:90000},async()=>{
 const address="127.0.0.1:7233",namespace="brai",taskQueue="bug-hunt-fixture-"+randomUUID(),workflowId="bug-hunt-fixture/"+randomUUID(),id=randomUUID();
 const control=await Connection.connect({address,connectTimeout:"5 seconds"}),native=await NativeConnection.connect({address}),client=new Client({connection:control,namespace});
 let calls=0,firstResolve;const first=new Promise(r=>firstResolve=r);
 const activities={advance:async input=>{assert.equal(input,id);calls++;if(calls===1){firstResolve();return {terminal:false,wait_ms:2000,code:"SYNTHETIC_WAIT"};}return {terminal:true,wait_ms:0,code:"SYNTHETIC_COMPLETE"};}};
 let worker,run,handle;
 const create=()=>Worker.create({connection:native,namespace,taskQueue,workflowBundle:{codePath},activities,maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2,shutdownGraceTime:"2 seconds"});
 try{
  worker=await create();run=worker.run();
  let state="starting";const store={pending:async()=>[{id,workflow_id:workflowId,workflow_state:state}],workflow:async(got,value)=>{assert.equal(got,id);state=value;}};
  await deliverVerification(store,client,taskQueue);assert.equal(state,"active");handle=client.workflow.getHandle(workflowId);
  await deliverVerification(store,client,taskQueue);assert.equal(state,"active");
  await first;await new Promise(r=>setTimeout(r,100));worker.shutdown();await run;
  worker=await create();run=worker.run();await handle.signal("wake");await handle.result();
  assert.ok(calls>=2&&calls<=3);
  const history=await handle.fetchHistory(),before=calls;
  await Worker.runReplayHistory({workflowBundle:{codePath}},history);
  assert.equal(calls,before,"replay must not execute a new external Activity");
  const payloads=[];const walk=v=>{if(v instanceof Uint8Array)payloads.push(Buffer.from(v).toString("utf8"));else if(v&&typeof v==="object")for(const child of Object.values(v))walk(child);};walk(history);
  const serialized=JSON.stringify(history)+"\n"+payloads.join("\n");assert.ok(serialized.includes(id));assert.ok(!serialized.includes("observation"));assert.ok(!serialized.includes("prompt"));assert.ok(!serialized.includes("credentials"));
 }finally{
  if(handle)await handle.terminate("own synthetic fixture cleanup").catch(()=>{});
  worker?.shutdown();await run?.catch(()=>{});await Promise.all([control.close(),native.close()]);
 }
});

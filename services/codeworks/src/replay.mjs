// ABOUTME: Сохраняет и воспроизводит истории живых workflow перед сменой immutable артефакта.
// ABOUTME: Не меняет workflow и не возобновляет завершённые исполнения; секреты соединений не сохраняет.
import {Connection,Client} from '@temporalio/client';
import {Worker} from '@temporalio/worker';
import proto from '@temporalio/proto';
const {temporal}=proto;
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
/** Снимок history и replay кандидатом обязательны для всех уже запущенных незавершённых roots. */
export async function verifyWorkflowCompatibility(db,{address,namespace,bundlePath,historyDirectory}){
  const rows=(await db.query("SELECT workflow_id FROM codeworks.workflow_registry WHERE owner='temporal' AND state<>'completed' AND started_at IS NOT NULL ORDER BY workflow_id")).rows;
  await mkdir(historyDirectory,{recursive:true,mode:0o700});
  if(!rows.length)return {verified:0,workflows:[]};
  const connection=await Connection.connect({address,connectTimeout:'5 seconds'}),client=new Client({connection,namespace}),verified=[];
  try{
    for(const {workflow_id:id} of rows){
      const history=await client.workflow.getHandle(id).fetchHistory();
      const serialized=temporal.api.history.v1.History.toObject(history,{longs:String,enums:String,bytes:String});
      const file=path.join(historyDirectory,encodeURIComponent(id)+'.json');
      await writeFile(file,JSON.stringify(serialized),{mode:0o600});
      await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(file,'utf8'))),id);verified.push(id);
    }
    return {verified:verified.length,workflows:verified};
  }finally{await connection.close();}
}

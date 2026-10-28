// ABOUTME: Обслуживает необязательный индекс рабочей области через изолированный адаптер SocratiCode.
// ABOUTME: Владение и состояние хранятся в PostgreSQL; ожидания не удерживают Git-блокировки.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {command} from './git.mjs';
import {Fault} from './errors.mjs';
import {executionContext,withExecutionContext} from './execution-context.mjs';

/** Идентичность совпадает со штатным path-based projectPath SocratiCode. */
export const indexIdentity=absolutePath=>createHash('sha256').update(absolutePath).digest('hex').slice(0,12);

/** Создаёт optional адаптер. Конфигурация задаётся только оператором Codeworks, не клиентом prepare. */
export function createCodeIndex(pool,{configFile=process.env.CODEWORKS_CODE_INDEX_CONFIG,invoke=invokeEngine}={}) {
  const config=async()=>configFile?JSON.parse(await readFile(configFile,'utf8')):null;
  const save=(id,value)=>pool.query('UPDATE codeworks.workspaces SET code_index=$2 WHERE id=$1',[id,value]);
  const exclusive=async work=>{
    const db=await pool.connect();let acquired=false;
    const abort=new AbortController(),disconnected=()=>abort.abort(Error('INDEX_DATABASE_DISCONNECTED'));
    db.on('error',disconnected);
    try{
      acquired=(await db.query("SELECT pg_try_advisory_lock(hashtextextended('codeworks:index-maintenance',0)) AS acquired")).rows[0].acquired;
      if(!acquired)throw new Fault('BUSY');
      const outer=executionContext()?.signal;
      return await withExecutionContext({signal:outer?AbortSignal.any([outer,abort.signal]):abort.signal},work);
    }finally{
      if(acquired)await db.query("SELECT pg_advisory_unlock(hashtextextended('codeworks:index-maintenance',0))").catch(()=>{});
      db.removeListener('error',disconnected);db.release();
    }
  };
  return {
    /** Один проход: отсутствующий источник ждёт следующего таймера; чужой индекс не принимается. */
    async maintain(project,w){
      let state=w.code_index;
      if(w.removed_at||w.preparation_state!=='ready'||w.activation_state==='awaiting_first_write'||['skipped','removed'].includes(state?.state))return;
      try{
        const settings=await config(),source=settings?.sources?.[project.id]?.[w.kind];
        if(!source)return;
        if(!state){
          state={identity:indexIdentity(w.path),source_path:source,source_sha:w.base_sha,state:'waiting',last_success_at:null,error:null};
          await save(w.id,state);
        }
        if(state.identity!==indexIdentity(w.path)||state.source_path!==source||state.source_sha!==w.base_sha)throw Error('INDEX_OWNERSHIP_CONFLICT');
        await exclusive(async()=>{
          // AIDEV-NOTE: UUID поколения workflow проверяет Activity; строка дополнительно запрещает запись после cleanup/cancel.
          const live=(await pool.query("SELECT w.removed_at,w.activation_state,r.lifecycle FROM codeworks.workspaces w JOIN codeworks.workflow_registry r ON r.workspace_id=w.id WHERE w.id=$1",[w.id])).rows[0];
          if(!live||live.removed_at||live.activation_state==='awaiting_first_write'||live.lifecycle!=='active')return;
          const updating=!!state.last_success_at;
          await save(w.id,{...state,state:updating?'updating':'copying',error:null});
          const result=await invoke(updating?'update':'clone',settings,project,w,state);
          state={...state,state:result.state,error:result.reason??null,...(result.state==='ready'?{last_success_at:new Date().toISOString()}: {})};
          await save(w.id,state);
        });
      }catch(error){
        if(executionContext()?.signal?.aborted)throw error;
        if(error.code==='BUSY')return;
        if(!state){console.error('Codeworks index configuration unavailable');return;}
        // Ошибки транспорта могут содержать адреса/credentials: наружу только стабильный код.
        await save(w.id,{...state,state:'error',error:error.indexCode??'INDEX_MAINTENANCE_FAILED'});
      }
    },
    /** Проверяет все ресурсы под барьером; недоступное хранилище не считается пустым. */
    async inspect(project,w,{manifest}={}){
      const settings=await config();
      if(!settings)throw Error('INDEX_CONFIGURATION_REQUIRED_FOR_CLEANUP');
      const index=cleanupIdentity(project,w);
      return exclusive(()=>invoke('inspect',settings,project,w,index,manifest));
    },
    /** Повторно проверяет ресурсы даже после частичной или завершённой очистки. */
    async remove(project,w,{manifest}={}){
      const settings=await config();
      if(!settings)throw Error('INDEX_CONFIGURATION_REQUIRED_FOR_CLEANUP');
      const index=cleanupIdentity(project,w);
      return exclusive(async()=>{
        await invoke('inspect',settings,project,w,index,manifest);
        await invoke('remove',settings,project,w,index,manifest);
        if(w.code_index)await save(w.id,{...w.code_index,state:'removed',error:null});
      });
    },
  };
}

function cleanupIdentity(project,w){
  if(!w.ownership_token||!path.isAbsolute(w.path)||path.normalize(w.path)!==w.path||path.dirname(w.path)!==project.workspace_root)throw Error('INDEX_OWNERSHIP_CONFLICT');
  const identity=indexIdentity(w.path);
  if(w.code_index&&w.code_index.identity!==identity)throw Error('INDEX_OWNERSHIP_CONFLICT');
  return {...w.code_index,identity};
}

/** Отдельный процесс имеет собственные env/cache; общий MCP и службы не перенастраиваются. */
async function invokeEngine(action,config,project,workspace,index,manifest){
  const result=await command(process.execPath,[fileURLToPath(new URL('./code-index-engine.mjs',import.meta.url))],{
    input:JSON.stringify({action,config,project,workspace,index,manifest}),timeout:1800000,allowFailure:true,
  });
  const value=JSON.parse(result.stdout);
  if(result.code!==0){
    if(value.error==='INDEX_WRITER_BUSY')throw new Fault('BUSY');
    const error=Error('INDEX_ENGINE_FAILED');if(/^[A-Z_]{3,80}$/.test(value.error))error.indexCode=value.error;throw error;
  }
  return value;
}

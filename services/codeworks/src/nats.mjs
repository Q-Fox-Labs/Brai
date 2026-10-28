// ABOUTME: Предоставляет общий API Codeworks через NATS Services без JSON-RPC envelope.
// ABOUTME: Executor выводится из ACL-защищённого subject и не управляет правами агента.
import { allMethods } from './contracts.mjs';
import { safeFault, errorStatus } from './errors.mjs';
/** Регистрирует реальные endpoints и PING/INFO/STATS; ACL должны ограничивать executor часть subject. */
export async function runNats(nc,runtime,executors) {
  if(!executors.length||executors.some(e=>!(/^[a-z][a-z0-9_]{0,63}$/).test(e)))throw new Error('CODEWORKS_EXECUTORS_REQUIRED');
  const service=await nc.services.add({name:'service_codeworks',version:'2.0.0',queue:'service_codeworks',description:'Worktrees, branches and releases'});
  let active=0;
  for(const executor of executors)for(const method of allMethods) {
    service.addEndpoint(executor+'_'+method.replaceAll(/[.-]/g,'_'),{subject:'brai.codeworks.v2.'+executor+'.'+method,handler:async(error,msg)=>{
      if(error)return;
      try {
        if(active>=8)throw Object.assign(new Error('BUSY'),{code:'BUSY'});
        if(msg.data.length>65536)throw Object.assign(new Error('INVALID_ARGUMENT'),{code:'INVALID_ARGUMENT'});
        active++;
        try {
          let args;try{args=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(msg.data));}catch{throw Object.assign(new Error('INVALID_ARGUMENT'),{code:'INVALID_ARGUMENT'});}
          const result=await runtime.call(method,args,executor);
          msg.respond(JSON.stringify(result));
        }finally{active--;}
      }catch(error){const fault=error?.code==='BUSY'||error?.code==='INVALID_ARGUMENT'?{code:error.code,message:error.code,retryable:error.code==='BUSY'}:safeFault(error).dto();msg.respondError(errorStatus[fault.code],fault.code,Buffer.from(JSON.stringify(fault)));}
    }});
  }
  return service;
}

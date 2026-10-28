// ABOUTME: Исполняет фиксированный локальный Git шаг в отдельном процессе с flock FD 3.
// ABOUTME: Не обращается к PostgreSQL, GitHub или Ansible; использует JSON-RPC 2.0 через stdin/stdout.
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {createGit} from './git.mjs';
import {safeFault} from './errors.mjs';
const methods=new Set(['branch','registerCheckout','checkout','dependencies','cleanupLocal','cleanupStep']);
const failure=(id,code,message,data)=>({jsonrpc:'2.0',id,error:{code,message,...(data?{data}:{})}});
/** Обрабатывает один JSON-документ RPC, включая batch и notifications; mutate — фиксированный локальный порт. */
export async function handleGitStep(input,mutate){
  let request;try{request=JSON.parse(input);}catch{return failure(null,-32700,'Parse error');}
  const call=async item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||item.jsonrpc!=='2.0'||typeof item.method!=='string'||('id'in item&&item.id!==null&&!['string','number'].includes(typeof item.id)))return failure(null,-32600,'Invalid Request');
    const notification=!('id'in item),id=item.id??null;
    let response;
    if(item.method!=='git.mutate')response=failure(id,-32601,'Method not found');
    else{
      const p=item.params;
      if(!p||Array.isArray(p)||!methods.has(p.method)||!p.project||!p.workspace||!Array.isArray(p.args??[]))response=failure(id,-32602,'Invalid params');
      else try{response={jsonrpc:'2.0',id,result:(await mutate(p))??null};}
      catch(error){const fault=safeFault(error);response=failure(id,-32000,fault.message,{code:fault.code});}
    }
    return notification?null:response;
  };
  if(Array.isArray(request)){
    if(!request.length)return failure(null,-32600,'Invalid Request');
    const responses=[];for(const item of request){const response=await call(item);if(response)responses.push(response);}
    return responses.length?responses:null;
  }
  return call(request);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.env.CODEWORKS_LOCK_HELD!=='1')throw Error('LOCKED_GIT_STEP_REQUIRED');
  const git=createGit();
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
    const response=await handleGitStep(line,async({method,project,workspace,args=[]})=>{
      const result=method==='cleanupLocal'?await git.cleanup(project,workspace,...args,{localOnly:true}):method==='cleanupStep'?await git.cleanupStep(project,workspace,...args):await git[method](project,workspace,...(method==='checkout'?[{registered:true}]:[]));
      if(process.env.CODEWORKS_TEST_MODE==='1'&&process.env.CODEWORKS_TEST_CRASH_AFTER==='after-'+method)process.kill(process.pid,'SIGKILL');
      return result;
    });
    if(response)process.stdout.write(JSON.stringify(response)+'\n');break;
  }
}

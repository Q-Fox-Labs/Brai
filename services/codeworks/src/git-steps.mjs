// ABOUTME: Ограничивает flock локальными изменениями refs и собственных Git worktree.
// ABOUTME: GitHub, CI, Ansible и remote Git выполняются без общего файлового замка.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {command,createGit} from './git.mjs';
import {createFlowGit} from './git-flow.mjs';
import {Fault} from './errors.mjs';
/** Запускает один локальный шаг под унаследованным flock; crash родителя не освобождает замок живого Git. */
export async function localGitStep(method,project,workspace,args=[],{env={}}={}) {
  const common=['branch','registerCheckout','cleanupLocal','cleanupStep'].includes(method);
  const lock=path.join(project.common_dir,common?'codeworks.lock':'codeworks-workspace-'+workspace.id+'.lock');
  const script='exec 3>"$1" || exit 74; flock -n -E 75 3 || exit $?; export CODEWORKS_LOCK_HELD=1; exec "$2" "$3"';
  const result=await command('/bin/sh',['-c',script,'codeworks-git',lock,process.execPath,fileURLToPath(new URL('./git-step.mjs',import.meta.url))],{
    input:JSON.stringify({jsonrpc:'2.0',id:workspace.id,method:'git.mutate',params:{method,project,workspace,args}})+'\n',allowFailure:true,timeout:150000,env,
  });
  if(result.code===75)throw new Fault('BUSY','A conflicting local Git change is running.');
  if(result.code!==0)throw new Fault('GIT_FAILED');
  const response=JSON.parse(result.stdout);
  if(response.id!==workspace.id||response.jsonrpc!=='2.0')throw new Fault('GIT_FAILED');
  if(response.error)throw new Fault(response.error.data?.code??'GIT_FAILED',response.error.message);
  return response.result;
}
/** Подключает прежние Git проверки; только конфликтующие локальные изменения отправляет под flock. */
export function createActivityGit({flowGit=createFlowGit({requireLock:()=>{}}),step=localGitStep}={}) {
  const git=createGit({flowGit});
  return {git:{...git,
    branch:(p,w)=>step('branch',p,w),
    async checkout(p,w){await step('registerCheckout',p,w);await step('checkout',p,w);},
    dependencies:(p,w)=>step('dependencies',p,w),
    async cleanupStep(p,w,expected,phase,options={}){
      return phase==='remote'?git.cleanupStep(p,w,expected,phase,options):step('cleanupStep',p,w,[expected,phase,options]);
    },
    async cleanup(p,w,heads,head){
      if(!await git.cleanup(p,w,heads,head,{remoteOnly:true}))return false;
      return step('cleanupLocal',p,w,[heads,head]);
    },
  },flowGit};
}

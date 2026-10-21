// ABOUTME: Запускает настоящий Hermes CLI/gateway в readonly namespace с подписанным tool.
// ABOUTME: Полномочия передаются одноразовым FD, не env, profile или model arguments.
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {socketCall} from '../codeworks/src/agent-host.mjs';
import {sandboxArgs} from '../codeworks/src/agent-sandbox.mjs';

/** Получает управляемый descriptor и запускает один native Hermes процесс. */
export async function launchHermes(args=process.argv.slice(2)) {
  let adapter;
  if(process.env.CODEWORKS_ADAPTER_DESCRIPTOR) {
    adapter=JSON.parse(await readFile(process.env.CODEWORKS_ADAPTER_DESCRIPTOR,'utf8'));
    adapter.key=(await readFile(adapter.key_file)).toString('hex');
  } else adapter=await socketCall(process.env.CODEWORKS_CONTROL_SOCKET,{action:'adapter',executor_id:'hermes'});
  const e=adapter.executor;
  const sandbox=sandboxArgs({cwd:adapter.project.repo_path,local:e.local_mounts??[],hidden:[adapter.state_root,...adapter.hidden_paths,adapter.project.repo_path,adapter.project.workspace_root,...(e.hidden_paths??[])],aliases:e.mounts??[],bridge:adapter.bridge,socket:adapter.socket,profile:{source:e.profile,target:e.profile_target??e.profile},env:{...(e.env??{}),HERMES_HOME:e.profile_target??e.profile,CODEWORKS_AGENT_SOCKET:'/run/codeworks.sock',CODEWORKS_PROJECT_ROOT:adapter.project.repo_path}});
  // bwrap consumes FD 3 before exec; bootstrap removes this private tmpfs file before model dispatch.
  sandbox.splice(sandbox.length-1,0,'--perms','0400','--file','3','/run/codeworks-key');
  const child=spawn('/usr/bin/bwrap',[...sandbox,...e.command,'/run/codeworks-bridge/agent-hermes.py','--engine',e.engine,...args],{stdio:['inherit','inherit','inherit','pipe']});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(adapter.key+'\n');
  const stop=()=>child.kill('SIGKILL');process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);resolve(code??1);});});
}
if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)launchHermes().then(code=>{process.exitCode=code;}).catch(()=>{console.error('Codeworks Hermes adapter failed');process.exitCode=1;});

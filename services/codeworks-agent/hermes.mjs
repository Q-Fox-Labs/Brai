// ABOUTME: Запускает настоящий Hermes CLI/gateway в readonly namespace с подписанным tool.
// ABOUTME: Полномочия передаются одноразовым FD, не env, profile или model arguments.
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Duplex} from 'node:stream';
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
  const bootstrap={key:adapter.key,env:{},tools:[]};
  if(!args.some(value=>['--gateway','--conversation','--check-isolation','--check-owner-bridge'].includes(value))) {
    let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>65536)throw Error('CONVERSATION_LIMIT');}
    bootstrap.input=input;
  }
  let runtime,dispatch;
  if(e.owner_bridge) {
    const root=e.owner_bridge.root;
    const [{loadConfig},{startBraiTools},{createTrustedDispatcher}]=await Promise.all(['config','runtime','trusted'].map(name=>import(pathToFileURL(root+'/'+name+'.mjs'))));
    runtime=await startBraiTools(await loadConfig({BRAI_HERMES_CONFIG:e.owner_bridge.config,BRAI_HERMES_OWNER_ID:e.owner_bridge.owner_id}));
    dispatch=createTrustedDispatcher(runtime);
    bootstrap.tools=runtime.tools;
    bootstrap.plugin=e.owner_bridge.plugin;
    bootstrap.capability=randomBytes(32).toString('hex');
    // Only names are persisted in the descriptor. Values stay on the private consumed FD.
    for(const name of e.bootstrap_env??[])if(Object.hasOwn(process.env,name))bootstrap.env[name]=process.env[name];
  }
  const sandbox=sandboxArgs({cwd:adapter.project.repo_path,local:e.local_mounts??[],hidden:[adapter.state_root,...adapter.hidden_paths,adapter.project.repo_path,adapter.project.workspace_root,...(e.hidden_paths??[])],aliases:e.mounts??[],bridge:adapter.bridge,socket:adapter.socket,profile:{source:e.profile,target:e.profile_target??e.profile},env:{...(e.env??{}),HERMES_HOME:e.profile_target??e.profile,CODEWORKS_AGENT_SOCKET:'/run/codeworks.sock',CODEWORKS_PROJECT_ROOT:adapter.project.repo_path}});
  // bwrap consumes FD 3 before exec; bootstrap removes this private tmpfs file before model dispatch.
  sandbox.splice(sandbox.length-1,0,'--perms','0400','--file','3','/run/codeworks-key');
  const child=spawn('/usr/bin/bwrap',[...sandbox,...e.command,'/run/codeworks-bridge/agent-hermes.py','--engine',e.engine,...args],{stdio:['pipe','pipe','inherit','pipe']});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(JSON.stringify(bootstrap)+'\n');
  const stopBridge=serveOwnerBridge(Duplex.from({readable:child.stdout,writable:child.stdin}),runtime,dispatch,bootstrap.capability);

  const stop=()=>child.kill('SIGKILL');process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return new Promise((resolve,reject)=>{child.once('error',async error=>{stopBridge();await runtime?.close().catch(()=>{});reject(error);});child.once('close',async code=>{stopBridge();await runtime?.close().catch(()=>{});process.off('SIGTERM',stop);process.off('SIGINT',stop);resolve(code??1);});});
}

/** Serve one existing launcher's private duplex FD, never a model-visible listener. */
export function serveOwnerBridge(stream,runtime,trusted,capability) {
  const names=new Set(runtime?.tools.map(tool=>tool.name)??[]);
  let pending='',chain=Promise.resolve(),stopped=false;
  const stop=()=>{stopped=true;stream.destroy();};
  stream.on('error',()=>{});
  stream.on('data',chunk=>{
    pending+=chunk.toString('utf8');
    if(Buffer.byteLength(pending)>65536){stop();return;}
    let newline;
    while((newline=pending.indexOf('\n'))!==-1) {
      const line=pending.slice(0,newline);pending=pending.slice(newline+1);
      chain=chain.then(async()=>{
        let result,id=null;
        try {
          const request=JSON.parse(line);
          id=request?.id;
          if(!runtime||!request||typeof request!=='object'||Array.isArray(request)||typeof id!=='string'||!/^([a-f0-9]{32})$/.test(id))throw Error('PRIVATE_CALL_REJECTED');
          if(request.channel==='owner'&&Object.keys(request).every(key=>['id','channel','name','args'].includes(key))&&names.has(request.name))
            result={result:await runtime.call(request.name,request.args)};
          else if(request.channel==='trusted'&&Object.keys(request).every(key=>['id','channel','capability','request'].includes(key))&&capability&&request.capability===capability)
            result={result:await trusted(JSON.stringify(request.request))};
          else throw Error('PRIVATE_CALL_REJECTED');
        } catch(error) {result={error:/^[A-Z][A-Z0-9_]{0,80}$/.test(error.code??error.message)?error.code??error.message:'OWNER_API_UNAVAILABLE'};}
        const encoded=JSON.stringify({id,...result})+'\n';
        if(Buffer.byteLength(encoded)>1048576){stop();return;}
        if(!stopped)stream.write(encoded);
      }).catch(stop);
    }
  });
  return stop;
}

if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)launchHermes().then(code=>{process.exitCode=code;}).catch(error=>{const code=error.code??error.message;console.error('Codeworks Hermes adapter failed; CW_ERROR_'+(/^[A-Z][A-Z0-9_]{0,80}$/.test(code)?code:'OWNER_API_UNAVAILABLE'));process.exitCode=1;});

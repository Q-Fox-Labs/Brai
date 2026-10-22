// ABOUTME: Добавляет доверенный Codeworks tool к настоящему Codex app-server protocol.
// ABOUTME: Native threadId задаёт identity; процессы Codex видят host только readonly.
import {spawn} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile,chmod,unlink} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {socketCall,reclaimSocket} from '../codeworks/src/agent-host.mjs';
import {sandboxArgs} from '../codeworks/src/agent-sandbox.mjs';
const tool=JSON.parse(await readFile(new URL('../codeworks/src/agent-tools.json',import.meta.url),'utf8'));
const INPUT_BYTES=16*1024*1024,OUTPUT_BYTES=32*1024*1024,OUTPUT_PENDING_BYTES=OUTPUT_BYTES+2*1024*1024;

/** Native plugin catalogues exceed 16MiB; keep their protocol frames bounded separately from input. */
export function decodeNativeFrame(line) {
  if(Buffer.byteLength(line)>OUTPUT_BYTES)throw new Error('CODEX_NATIVE_OUTPUT_LIMIT');
  return JSON.parse(line);
}

/** Text frames retain order; the budget includes the next encoded frame and all pending bytes. */
export function forwardNativeFrame(ws,frame) {
  const encoded=JSON.stringify(frame),bytes=Buffer.byteLength(encoded);
  if(ws.readyState!==1||bytes>OUTPUT_BYTES||ws.bufferedAmount+bytes>OUTPUT_PENDING_BYTES) {
    if(ws.readyState===1)console.error('CODEX_WS_OUTPUT_LIMIT');
    ws.terminate();return false;
  }
  ws.send(encoded);return true;
}

const instructions='Use codeworks for ALL project reads, patches, files and commands. Native project paths are intentionally inaccessible. Do not request manual worktrees: codeworks automatically prepares one before the first code write. Use mode=read for inspection and mode=write for mutating commands. Route all subsequent reads through codeworks. Never retry a partly executed command.';

/** Допускает только открытые клиентом threads и реально начавшиеся native turns. */
export function createAdmission() {
  const threads=new Set(),expected=new Set(),active=new Map();
  return {
    thread(id){if(typeof id!=='string'||!id)throw new Error('NATIVE_THREAD_INVALID');threads.add(id);},
    expect(id){if(!threads.has(id))throw new Error('NATIVE_THREAD_NOT_ADMITTED');expected.add(id);},
    observe(frame){
      const p=frame.params??{};
      if(frame.method==='turn/started') {
        if(!expected.delete(p.threadId)||!p.turn?.id||active.has(p.threadId))throw new Error('NATIVE_TURN_NOT_ADMITTED');
        active.set(p.threadId,{id:p.turn.id,calls:new Set()});
      }
      if(frame.method==='item/started'&&p.item?.type==='subAgentActivity') {
        if(active.get(p.threadId)?.id!==p.turnId)throw new Error('NATIVE_PARENT_TURN_NOT_ADMITTED');
        const id=p.item.agentThreadId;
        if(typeof id!=='string'||!id)throw new Error('NATIVE_CHILD_INVALID');
        threads.add(id);
        if(!active.has(id)&&!p.item.id?.startsWith('subagent-completed-'))expected.add(id);
      }
      if(frame.method==='turn/completed') {
        if(active.get(p.threadId)?.id!==p.turn?.id)throw new Error('NATIVE_COMPLETED_TURN_NOT_ADMITTED');
        active.delete(p.threadId);
      }
    },
    tool(frame){
      const p=frame.params??{},turn=active.get(p.threadId);
      if(!turn||turn.id!==p.turnId||frame.id===undefined||turn.calls.has(frame.id)||turn.calls.size>=1024)throw new Error('NATIVE_TOOL_NOT_ADMITTED');
      turn.calls.add(frame.id);
    },
  };
}

/** Запускает защищённый native app-server; send получает неизменённые protocol frames. */
export async function managedCodex(control,send) {
  const adapter=await socketCall(control,{action:'adapter',executor_id:'codex'}),e=adapter.executor;
  const arguments_=[...sandboxArgs({cwd:adapter.project.repo_path,procExecutable:e.command[0],local:e.local_mounts??[],hidden:[adapter.state_root,...adapter.hidden_paths,adapter.project.repo_path,adapter.project.workspace_root,...(e.hidden_paths??[])],aliases:e.mounts??[],bridge:adapter.bridge,profile:{source:e.profile,target:e.profile_target??e.profile},env:{...(e.env??{}),CODEX_HOME:e.profile_target??e.profile}}),...e.command,'app-server','--listen','stdio://'];
  const child=spawn('/usr/bin/bwrap',arguments_,{stdio:['pipe','pipe','pipe']});
  const pending=new Map(),admission=createAdmission();let closed=false;
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  const write=frame=>{if(closed)return;const bytes=JSON.stringify(frame)+'\n';if(Buffer.byteLength(bytes)>INPUT_BYTES||child.stdin.writableLength>2097152){console.error('CODEX_NATIVE_INPUT_LIMIT');child.kill('SIGKILL');return;}child.stdin.write(bytes);};
  async function agentCall(nativeId,request) {
    const payload=JSON.stringify({native_session_id:nativeId,request});
    return socketCall(adapter.socket,{payload,signature:createHmac('sha256',Buffer.from(adapter.key,'hex')).update(payload).digest('hex')});
  }
  const reader=createInterface({input:child.stdout});
  reader.on('line',line=>{void (async()=>{
    const frame=decodeNativeFrame(line);
    admission.observe(frame);
    if(frame.method==='item/tool/call'&&frame.params?.tool===tool.name) {
      try {
        admission.tool(frame);
        const result=await agentCall(frame.params.threadId,frame.params.arguments);
        write({id:frame.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}});
      }catch(error){write({id:frame.id,result:{success:false,contentItems:[{type:'inputText',text:'Codeworks: '+error.message+'. No automatic retry.'}]}});}
      return;
    }
    const request=pending.get(frame.id);if(request){pending.delete(frame.id);if(frame.result?.thread?.id){
      const id=frame.result.thread.id;
      if(request.method==='thread/resume'&&id!==request.threadId)throw new Error('NATIVE_RESUME_ID_MISMATCH');
      admission.thread(id);
      if(request.method!=='thread/resume')await agentCall(id,{action:'status'});
    }}
    send(frame);
  })().catch(error=>{console.error(error.message==='CODEX_NATIVE_OUTPUT_LIMIT'?'CODEX_NATIVE_OUTPUT_LIMIT':'CODEX_NATIVE_FRAME_REJECTED');child.kill('SIGKILL');});});
  child.on('error',()=>{closed=true;});child.on('close',()=>{closed=true;reader.close();});
  return {
    child,
    /** Переписывает только начало/возобновление thread; tool identity не берётся из model args. */
    async receive(input) {
      const frame=structuredClone(input),p=frame.params??{};
      if(frame.method==='initialize')frame.params={...p,capabilities:{...p.capabilities,experimentalApi:true}};
      if(['thread/start','thread/resume','thread/fork'].includes(frame.method)) {
        if(p.cwd&&path.resolve(p.cwd)!==adapter.project.repo_path){send({id:frame.id,error:{code:-32602,message:'PROJECT_NOT_MANAGED'}});return;}
        if(frame.method!=='thread/start') {
          const lookup=await socketCall(control,{action:'lookup_native',executor_id:'codex',native_session_id:p.threadId});
          if(!lookup.managed){send({id:frame.id,error:{code:-32602,message:'LEGACY_THREAD_NOT_MANAGED: start a new managed chat.'}});return;}
        }
        frame.params={...p,cwd:adapter.project.repo_path,developerInstructions:[p.developerInstructions,instructions].filter(Boolean).join('\n'),sandbox:'read-only'};
        delete frame.params.permissions;
        if(frame.method==='thread/start')frame.params.dynamicTools=[...(p.dynamicTools??[]).filter(t=>t.name!==tool.name),{type:'function',...tool}];
        pending.set(frame.id,{method:frame.method,threadId:p.threadId});
      }
      if(frame.method==='turn/start') {
        try{admission.expect(p.threadId);}catch{send({id:frame.id,error:{code:-32602,message:'NATIVE_THREAD_NOT_ADMITTED'}});return;}
      }
      write(frame);
    },
    /** Kill PID namespace init; ни один native терминал не переживает завершение adapter. */
    close() {child.kill('SIGKILL');},
  };
}

/** Обслуживает штатный Unix WebSocket endpoint desktop либо protocol stdio. */
export async function main() {
  const control=process.env.CODEWORKS_CONTROL_SOCKET;if(!control)throw new Error('CONTROL_SOCKET_REQUIRED');
  const listen=process.argv.find(arg=>arg.startsWith('--listen='));
  if(!listen) {
    const proxy=await managedCodex(control,frame=>process.stdout.write(JSON.stringify(frame)+'\n'));
    const input=createInterface({input:process.stdin});
    for await(const line of input)await proxy.receive(JSON.parse(line));
    proxy.close();return;
  }
  const file=listen.slice('--listen=unix://'.length);
  if(!listen.startsWith('--listen=unix:///'))throw new Error('UNIX_LISTENER_REQUIRED');
  const server=createServer(),wss=new WebSocketServer({server,maxPayload:INPUT_BYTES,perMessageDeflate:false});
  wss.on('connection',ws=>{
    if(wss.clients.size>8){ws.close(1013);return;}
    const started=managedCodex(control,frame=>forwardNativeFrame(ws,frame));
    void started.catch(()=>ws.terminate());
    void started.then(proxy=>proxy.child.once('close',()=>ws.close(1011,'Native app-server closed'))).catch(()=>{});
    let queue=Promise.resolve();
    ws.on('message',data=>{queue=queue.then(async()=>{const proxy=await started;await proxy.receive(JSON.parse(data.toString()));}).catch(()=>ws.terminate());});
    ws.on('close',()=>void started.then(proxy=>proxy.close()).catch(()=>{}));ws.on('error',()=>void started.then(proxy=>proxy.close()).catch(()=>{}));
  });
  await reclaimSocket(file);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});await chmod(file,0o600);
  async function stop(){for(const client of wss.clients)client.terminate();wss.close();server.close();await unlink(file).catch(()=>{});}
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}
if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(()=>{console.error('Codeworks Codex adapter failed');process.exitCode=1;});

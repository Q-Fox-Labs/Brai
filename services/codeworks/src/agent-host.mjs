// ABOUTME: Исполняет файловые операции агентов и останавливает реальные writer-процессы.
// ABOUTME: Одна реализация обслуживает Codex/Hermes; модели не получают control socket или БД.
import {createServer,createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,chmod,lstat,realpath,readdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sandboxArgs,workspaceMounts} from './agent-sandbox.mjs';
import Ajv from 'ajv';
const bridge=fileURLToPath(new URL('.',import.meta.url));
const forbidden=new Set(['.git','node_modules','.env','.secrets','.agents','.codex']);
const under=(root,target)=>target===root||target.startsWith(root+'/');
const fail=code=>{throw new Error(code);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Нормализует существующие ancestors, включая alias; не требует существования нового файла. */
async function canonical(target,follow=true) {
  if(!follow)return path.join(await canonical(path.dirname(target)),path.basename(target));
  try{return await realpath(target);}catch(error){if(error.code!=='ENOENT')throw error;return path.join(await canonical(path.dirname(target)),path.basename(target));}
}

/** Один ограниченный JSON frame на соединение; ошибки не раскрывают host inputs. */
export async function socketCall(socket,request) {
  return new Promise((resolve,reject)=>{
    const stream=createConnection(socket);let text='';
    stream.setTimeout(180000,()=>stream.destroy(new Error('AGENT_TIMEOUT')));
    stream.on('connect',()=>stream.end(JSON.stringify(request)+'\n'));
    stream.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>2097152)stream.destroy(new Error('OUTPUT_LIMIT'));});
    stream.on('error',reject);
    stream.on('end',()=>{try{const response=JSON.parse(text);if(response.error)reject(new Error(response.error));else resolve(response);}catch(error){reject(error);}});
  });
}

/** Создаёт host с явным runtime.call; запуск разрешён только в управляемом immutable install. */
export async function createAgentHost(config,call) {
  if(!path.isAbsolute(config.state_root)||!Array.isArray(config.projects)||!config.projects.length)fail('AGENT_HOST_CONFIGURATION');
  if(config.require_immutable!==false) {
    for(const name of ['agent-host.mjs','agent-sandbox.mjs','agent-files.py','agent-proxy.py','agent-hermes.py','agent-tools.json']) {
      const item=await lstat(path.join(bridge,name));
      if(!item.isFile()||item.uid!==0||(item.mode&0o022))fail('AGENT_HOST_MUTABLE_CODE');
    }
    const directory=await lstat(bridge);
    if(directory.uid!==0||(directory.mode&0o022))fail('AGENT_HOST_MUTABLE_CODE');
  }
  await mkdir(config.state_root,{recursive:true,mode:0o700});
  const lock=spawn('/usr/bin/flock',['-n','-E','75',path.join(config.state_root,'host.lock'),'/bin/sh','-c','printf locked; cat >/dev/null'],{stdio:['pipe','pipe','ignore']});
  await new Promise((resolve,reject)=>{lock.stdout.once('data',()=>resolve());lock.once('error',()=>reject(new Error('HOST_LOCK_BUSY')));lock.once('close',()=>reject(new Error('HOST_LOCK_BUSY')));});
  const tool=JSON.parse(await readFile(path.join(bridge,'agent-tools.json'),'utf8'));
  const valid=new Ajv({strict:false}).compile(tool.inputSchema);
  const sessions=new Map(),servers=[],processes=new Map();let closing=false;
  async function persist(session) {
    const file=path.join(config.state_root,session.id+'.json'),temporary=file+'.pending';
    await writeFile(temporary,JSON.stringify(session),{mode:0o600});await rename(temporary,file);
  }
  async function project(session) {
    if(!config.projects.includes(session.project_id))fail('PROJECT_DENIED');
    const p=(await call('project.get',{project_id:session.project_id},session.executor_id)).project;
    if(under(p.repo_path,p.workspace_root)||under(p.workspace_root,p.repo_path))fail('SEPARATE_WORKSPACE_ROOT_REQUIRED');
    return p;
  }
  function live(session) {if(closing||session.revoked)fail('WRITER_FENCED');}
  async function status(session) {
    if(!session.workspace_id)return {session_id:session.id,workspace:null};
    return call('status',{project_id:session.project_id,workspace_id:session.workspace_id},session.executor_id);
  }
  async function root(session,write=false) {
    live(session);
    const p=await project(session);
    if(session.workspace_id) {
      const result=await status(session),w=result.workspace;
      if(w.preparation_state!=='ready')fail('WORKSPACE_NOT_READY');
      if(w.writer.state!=='active'||w.writer.executor_id!==session.executor_id||w.writer.session_id!==session.id)fail('WRITER_FENCED');
      return {project:p,root:w.path,workspace:w};
    }
    if(!write)return {project:p,root:p.repo_path,workspace:null};
    const accepted=await call('prepare-write',{project_id:session.project_id,idempotency_key:'agent-prepare-'+session.id,workspace_key:session.workspace_key,kind:session.kind,session_id:session.id},session.executor_id);
    session.workspace_id=accepted.workspace_id;await persist(session);
    const until=Date.now()+150000;
    while(Date.now()<until) {
      live(session);
      const {operation}=await call('operation-status',{project_id:session.project_id,operation_id:accepted.operation_id},session.executor_id);
      if(operation.status==='failed')fail(operation.error?.code??'PREPARATION_FAILED');
      if(operation.status==='succeeded')return root(session);
      await pause(100);
    }
    fail('PREPARATION_PENDING');
  }
  async function relative(p,current,target,follow=true) {
    if(typeof target!=='string'||!target||target.includes('\0')||target.includes('\\'))fail('PATH_DENIED');
    const input=path.isAbsolute(target)?target:path.resolve(current,target);
    const resolved=await canonical(input,follow);
    let result;
    if(under(current,resolved))result=path.relative(current,resolved);
    else if(under(p.repo_path,resolved))result=path.relative(p.repo_path,resolved);
    else fail('PATH_DENIED');
    if(!result||result.split('/').some(part=>forbidden.has(part)||part.startsWith('.env.')))fail('PATH_DENIED');
    if(!p.allowed_paths.some(prefix=>prefix==='.'||under(prefix,result))||p.excluded_paths.some(prefix=>under(prefix,result)))fail('PATH_DENIED');
    return result;
  }
  async function run(session,args,input,{write=false,docs=[]}={}) {
    live(session);
    if([...processes.values()].filter(p=>!p.closed).length>=32)fail('BUSY');
    if(processes.size>=256)for(const [id,entry] of processes)if(entry.closed){processes.delete(id);break;}
    const context=await root(session),p=context.project;
    const mounts=workspaceMounts(p,context.root,write);
    // The readonly root alias must be mounted before a narrower docs grant.
    mounts.local=docs.map(prefix=>[path.join(context.root,prefix),path.join(context.root,prefix)]);
    // Shell inspection must not expose existing excluded credentials/configuration.
    mounts.masked=[];
    for(const prefix of p.excluded_paths.filter(prefix=>!['.git','node_modules'].includes(prefix))) {
      try {
        const item=await lstat(path.join(context.root,prefix));
        for(const base of new Set([context.root,p.repo_path]))mounts.masked.push({target:path.join(base,prefix),directory:item.isDirectory()});
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    // Исключённые префиксы остаются readonly даже внутри writable области.
    if(write)for(const prefix of p.excluded_paths) {
      const file=path.join(context.root,prefix);
      try{await lstat(file);mounts.aliases.push([file,file]);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const commandId=randomUUID();let stdout='',stderr='',overflow=false;
    live(session);
    const child=spawn(config.bwrap??'/usr/bin/bwrap',[...sandboxArgs({cwd:context.root,...mounts,bridge,hidden:[config.state_root,...(config.hidden_paths??[]),...(config.command_hidden_paths??[])],env:{CODEWORKS_SESSION_ID:session.id}}),...args],{stdio:['pipe','pipe','pipe']});
    const entry={id:commandId,session:session.id,write,child,stdout:()=>stdout,stderr:()=>stderr,code:null,closed:false};
    processes.set(commandId,entry);
    const timer=setTimeout(()=>child.kill('SIGKILL'),Math.min(config.command_timeout_ms??120000,600000));
    function capture(which,chunk) {
      if(overflow)return;
      if(which==='stdout')stdout+=chunk;else stderr+=chunk;
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>1048576){overflow=true;child.kill('SIGKILL');}
    }
    child.stdout.on('data',chunk=>capture('stdout',chunk));child.stderr.on('data',chunk=>capture('stderr',chunk));
    child.on('error',()=>{stderr='PROCESS_START_FAILED';});
    entry.done=new Promise(resolve=>child.once('close',code=>{clearTimeout(timer);entry.code=code??-1;entry.closed=true;resolve();}));
    child.stdin.on('error',()=>{});
    if(input!==undefined)child.stdin.end(input);
    return entry;
  }
  async function worker(session,request,options) {
    const context=await root(session);
    const entry=await run(session,['/usr/bin/python3','/run/codeworks-bridge/agent-files.py'],JSON.stringify({...request,root:context.root}),options);
    await entry.done;processes.delete(entry.id);
    if(entry.code!==0){config.onError?.(new Error('FILE_WORKER: '+entry.stderr()+' '+entry.stdout()));fail('FILE_OPERATION_REJECTED');}
    return JSON.parse(entry.stdout());
  }
  async function action(session,request) {
    live(session);
    if(!valid(request))fail('INVALID_ARGUMENT');
    if(request.action==='status')return status(session);
    if(request.action==='poll'||request.action==='stdin') {
      const entry=processes.get(request.command_id);
      if(!entry||entry.session!==session.id)fail('COMMAND_DENIED');
      if(request.action==='stdin') {
        if(entry.closed)fail('COMMAND_CLOSED');
        entry.child.stdin.write(String(request.input??''));
        if(request.eof)entry.child.stdin.end();
      }
      await Promise.race([entry.done,pause(100)]);
      return {command_id:entry.id,done:entry.closed,exit_code:entry.code,stdout:entry.stdout(),stderr:entry.stderr()};
    }
    let context=await root(session);
    if(request.action==='read') {
      const file=await relative(context.project,context.root,request.path);
      return {...await worker(session,{action:'read',path:file}),root:context.root};
    }
    if(request.action==='command') {
      if(!['read','write'].includes(request.mode)||!Array.isArray(request.argv)||!request.argv.length||request.argv.some(s=>typeof s!=='string'||s.includes('\0')))fail('COMMAND_MODE_REQUIRED');
      if(request.mode==='write')context=await root(session,true);
      const entry=await run(session,request.argv,request.input,{write:request.mode==='write'});
      await Promise.race([entry.done,pause(100)]);
      return {command_id:entry.id,done:entry.closed,exit_code:entry.code,stdout:entry.stdout(),stderr:entry.stderr(),root:context.root};
    }
    let operations=request.operations;
    if(request.action==='patch')operations=(await worker(session,{action:'parse',patch:request.patch})).operations;
    else if(request.action!=='batch')fail('ACTION_DENIED');
    if(!Array.isArray(operations)||!operations.length||operations.length>128)fail('INVALID_ARGUMENT');
    operations=await Promise.all(operations.map(async op=>{
      const result={...op,path:await relative(context.project,context.root,op.path,!['delete','rename','symlink'].includes(op.op))};
      if(op.to!==undefined)result.to=await relative(context.project,context.root,op.to,false);
      if(op.op==='symlink') {
        if(typeof op.target!=='string'||path.isAbsolute(op.target))fail('PATH_DENIED');
        await relative(context.project,context.root,path.resolve(context.root,path.dirname(result.path),op.target));
      }
      return result;
    }));
    const paths=operations.flatMap(op=>[op.path,...(op.to?[op.to]:[])]);
    const docs=(context.project.documentation_paths??[]).filter(prefix=>paths.some(file=>under(prefix,file)));
    const docsOnly=!session.workspace_id&&operations.every(op=>op.op!=='symlink')&&paths.every(file=>/\.(md|txt|rst|adoc)$/.test(file)&&docs.some(prefix=>under(prefix,file)));
    if(!docsOnly)context=await root(session,true);
    // До первой мутации проверяется весь batch, включая destinations и patch context.
    await worker(session,{action:'batch',operations,check_only:true});
    return {...await worker(session,{action:'batch',operations},{write:!docsOnly,docs:docsOnly?docs:[]}),root:context.root,workspace_id:session.workspace_id??null};
  }
  async function listen(file,handler) {
    try {
      const item=await lstat(file);if(!item.isSocket()||item.uid!==process.getuid())fail('SOCKET_OCCUPIED');
      await unlink(file);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const server=createServer({allowHalfOpen:true},stream=>{
      let input='';stream.setTimeout(180000,()=>stream.destroy());
      stream.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>1048576)stream.destroy();});
      stream.on('end',async()=>{
        try{const response=await handler(JSON.parse(input));stream.end(JSON.stringify(response)+'\n');}
        catch(error){config.onError?.(error);const code=/^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)?error.message:'AGENT_REQUEST_FAILED';stream.end(JSON.stringify({error:code})+'\n');}
      });stream.on('error',()=>{});
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});await chmod(file,0o600);servers.push({server,file});
  }
  async function expose(session) {
    let queue=Promise.resolve();
    await listen(path.join(config.state_root,session.id+'.sock'),request=>{
      const result=queue.then(()=>action(session,request));queue=result.catch(()=>{});return result;
    });
  }
  /** Перекрывает admission до сигнала, убивает namespace init и ждёт закрытия всех pipe/FD. */
  async function quiesce({workspace,executorId,sessionId}) {
    const affected=[...sessions.values()].filter(s=>s.workspace_id===workspace.id&&s.executor_id===executorId&&s.id===sessionId);
    for(const session of affected){session.revoked=true;await persist(session);}
    const active=[...processes.values()].filter(p=>affected.some(s=>s.id===p.session)&&!p.closed);
    for(const entry of active)entry.child.kill('SIGKILL');
    await Promise.all(active.map(entry=>entry.done));
    if([...processes.values()].some(p=>affected.some(s=>s.id===p.session)&&!p.closed))fail('WRITER_BUSY');
  }
  // После рестарта namespaces прежнего host погибли (die-with-parent + PID namespace).
  for(const file of await readdir(config.state_root))if(/^[0-9a-f-]{36}\.json$/.test(file)) {
    const session=JSON.parse(await readFile(path.join(config.state_root,file),'utf8'));
    sessions.set(session.id,session);
  }
  // Только собственные persisted sockets можно восстановить; неизвестный control socket — конфликт.
  for(const session of sessions.values())await expose(session);
  const adapterKeys=new Map();
  const nativeSessions=new Map([...sessions.values()].filter(s=>s.native_key).map(s=>[s.native_key,Promise.resolve(s)]));
  for(const executor of ['codex','hermes']) {
    const keyPath=config.adapter_keys?.[executor]??path.join(config.state_root,executor+'.key');let key;
    try{key=await readFile(keyPath);}catch(error){if(error.code!=='ENOENT')throw error;key=randomBytes(32);await writeFile(keyPath,key,{mode:0o600});}
    if(key.length!==32)fail('ADAPTER_KEY_INVALID');
    adapterKeys.set(executor,key);
    await listen(path.join(config.state_root,executor+'.adapter.sock'),async envelope=>{
      if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string')fail('ADAPTER_DENIED');
      const expected=createHmac('sha256',key).update(envelope.payload).digest();
      const actual=Buffer.from(envelope.signature,'hex');
      if(actual.length!==expected.length||!timingSafeEqual(expected,actual))fail('ADAPTER_DENIED');
      const {native_session_id:identity,request}=JSON.parse(envelope.payload);
      if(typeof identity!=='string'||!identity||identity.length>255)fail('ADAPTER_DENIED');
      const nativeKey=executor+':'+identity;
      if(!nativeSessions.has(nativeKey))nativeSessions.set(nativeKey,(async()=>{
        const id=randomUUID(),session={id,native_key:nativeKey,project_id:config.adapter_project_id,executor_id:executor,kind:'feature',workspace_key:id,revoked:false};
        await project(session);await persist(session);sessions.set(id,session);await expose(session);return session;
      })());
      const session=await nativeSessions.get(nativeKey);
      // Scoped socket queue also serializes same-thread calls arriving through different adapters.
      return socketCall(path.join(config.state_root,session.id+'.sock'),request);
    });
    if(config.adapter_socket_mode)await chmod(path.join(config.state_root,executor+'.adapter.sock'),Number.parseInt(config.adapter_socket_mode,8));
  }
  await listen(path.join(config.state_root,'control.sock'),async request=>{
    if(request.action==='lookup_native'){
      const session=await nativeSessions.get(request.executor_id+':'+request.native_session_id);
      return {managed:!!session,...(session?{session_id:session.id,workspace_id:session.workspace_id??null,revoked:session.revoked}:{})};
    }
    if(request.action==='adapter') {
      if(!adapterKeys.has(request.executor_id))fail('ADAPTER_DENIED');
      const p=(await call('project.get',{project_id:config.adapter_project_id},request.executor_id)).project;
      return {socket:path.join(config.state_root,request.executor_id+'.adapter.sock'),key:adapterKeys.get(request.executor_id).toString('hex'),project:p,executor:config.executors[request.executor_id],bridge,state_root:config.state_root,hidden_paths:config.hidden_paths??[]};
    }
    if(request.action==='open') {
      let session;
      if(request.resume)session=sessions.get(request.resume);
      else {
        if(!['codex','hermes'].includes(request.executor_id)||!['feature','hotfix'].includes(request.kind??'feature'))fail('INVALID_ARGUMENT');
        const id=randomUUID();session={id,project_id:request.project_id,executor_id:request.executor_id,kind:request.kind??'feature',workspace_key:request.workspace_key??id,revoked:false};
        await project(session);await persist(session);sessions.set(id,session);await expose(session);
      }
      if(!session)fail('SESSION_NOT_FOUND');live(session);
      return {session_id:session.id,socket:path.join(config.state_root,session.id+'.sock'),project:await project(session),executor:config.executors[session.executor_id],bridge};
    }
    const session=sessions.get(request.session_id);if(!session)fail('SESSION_NOT_FOUND');
    if(request.action==='quiesce') {
      const current=await status(session);if(!current.workspace)fail('WORKSPACE_NOT_READY');
      return call('attach-or-transfer',{project_id:session.project_id,idempotency_key:'agent-quiesce-'+session.id,workspace_id:current.workspace.id,session_id:session.id,expected_epoch:current.workspace.writer.epoch,mode:'quiesce',writes_stopped:true},session.executor_id);
    }
    if(request.action==='attach') {
      live(session);
      const current=await call('status',{project_id:session.project_id,workspace_id:request.workspace_id},session.executor_id);
      const result=await call('attach-or-transfer',{project_id:session.project_id,idempotency_key:'agent-attach-'+session.id,workspace_id:request.workspace_id,session_id:session.id,expected_epoch:current.workspace.writer.epoch,mode:'attach'},session.executor_id);
      session.workspace_id=request.workspace_id;await persist(session);return result;
    }
    if(request.action==='status')return status(session);
    fail('ACTION_DENIED');
  });
  return {
    quiesce,
    /** Закрывает admission и останавливает всех собственных детей перед остановкой core. */
    async close() {
      closing=true;for(const entry of processes.values())if(!entry.closed)entry.child.kill('SIGKILL');
      await Promise.all([...processes.values()].map(p=>p.done));
      await Promise.all(servers.map(({server})=>new Promise(resolve=>server.close(resolve))));
      for(const {file} of servers)await unlink(file).catch(()=>{});
      lock.stdin.end();
    },
  };
}

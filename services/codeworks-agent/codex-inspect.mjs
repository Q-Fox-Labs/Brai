// ABOUTME: Предоставляет независимые команды диагностики в OS readonly namespace.
// ABOUTME: Один private socket существующего proxy; cwd, mounts, timeout и identity не берутся из argv.
import {createServer,createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {lstat,realpath,chmod,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {sandboxArgs,workspaceMounts} from '../codeworks/src/agent-sandbox.mjs';
import {reclaimSocket} from '../codeworks/src/agent-host.mjs';

const LIMIT=1024*1024,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates the entire readonly request; command text never grants write permissions. */
export function validateInspect(request) {
  if(!request||request.action!=='inspect'||!UUID.test(request.native_session_id??'')||Object.keys(request).some(key=>!['action','native_session_id','argv'].includes(key)))throw new Error('INSPECT_REQUEST_INVALID');
  if(!Array.isArray(request.argv)||request.argv.length<1||request.argv.length>128||request.argv.some(arg=>typeof arg!=='string'||arg.length>2048||arg.includes('\0'))||!request.argv[0])throw new Error('INSPECT_ARGV_INVALID');
}

/** Calls the fixed host with a short deadline; failures do not disable readonly diagnostics. */
async function hostCall(socket,request) {
  return new Promise((resolve,reject)=>{
    const stream=createConnection(socket);let data='';
    stream.setTimeout(1000,()=>stream.destroy(new Error('HOST_UNAVAILABLE')));
    stream.on('connect',()=>stream.end(JSON.stringify(request)+'\n'));
    stream.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>262144)stream.destroy(new Error('HOST_RESPONSE_LIMIT'));});
    stream.on('error',reject);stream.on('end',()=>{try{const result=JSON.parse(data);if(result.error)throw new Error(result.error);resolve(result);}catch(error){reject(error);}});
  });
}

/** Builds an inspector from protected configuration; no database or host is needed at startup. */
export function createReadonlyInspector({descriptor,controlSocket,execute=spawn,call=hostCall}) {
  const known=new Map();let running=0;
  return async request=>{
    validateInspect(request);
    if(running>=4)throw new Error('INSPECT_BUSY');
    running++;
    try {
      const project=descriptor.project;
      let root=known.get(request.native_session_id)??project.repo_path,source_fallback=!known.has(request.native_session_id);
      try {
        const adapter=await call(controlSocket,{action:'adapter',executor_id:'codex'});
        const payload=JSON.stringify({native_session_id:request.native_session_id,request:{action:'status'}});
        const status=await call(adapter.socket,{payload,signature:createHmac('sha256',Buffer.from(adapter.key,'hex')).update(payload).digest('hex')});
        if(status.workspace?.path) {
          const candidate=await realpath(status.workspace.path),base=await realpath(project.workspace_root);
          if(!candidate.startsWith(base+path.sep))throw new Error('INSPECT_WORKSPACE_INVALID');
          root=candidate;if(known.size>=256)known.delete(known.keys().next().value);known.set(request.native_session_id,root);source_fallback=false;
        } else {root=project.repo_path;known.delete(request.native_session_id);source_fallback=false;}
      }catch(error){if(error.message==='INSPECT_WORKSPACE_INVALID')throw error;}
      const mounts=workspaceMounts(project,root,false);mounts.masked=[];
      for(const prefix of project.excluded_paths.filter(prefix=>!['.git','node_modules'].includes(prefix))) {
        try {
          const item=await lstat(path.join(root,prefix));
          for(const base of new Set([root,project.repo_path]))mounts.masked.push({target:path.join(base,prefix),directory:item.isDirectory()});
        }catch(error){if(error.code!=='ENOENT')throw error;}
      }
      const args=sandboxArgs({cwd:root,...mounts,hidden:[descriptor.state_root,...descriptor.hidden_paths,...(descriptor.command_hidden_paths??[])],env:{}});
      args.splice(args.length-1,0,'--unshare-net');
      return await new Promise((resolve,reject)=>{
        let stdout='',stderr='',encoded=0,stopped=false;
        const child=execute('/usr/bin/bwrap',[...args,...request.argv],{stdio:['ignore','pipe','pipe']});
        const timer=setTimeout(()=>{stopped=true;child.kill('SIGKILL');},8000);
        function capture(which,chunk) {
          let text=chunk.toString();const budget=LIMIT-512-encoded;
          if(Buffer.byteLength(JSON.stringify(text))-2>budget) {
            let lo=0,hi=text.length;
            while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Buffer.byteLength(JSON.stringify(text.slice(0,mid)))-2<=budget)lo=mid;else hi=mid-1;}
            text=text.slice(0,lo);stopped=true;child.kill('SIGKILL');
          }
          encoded+=Buffer.byteLength(JSON.stringify(text))-2;
          if(which==='stdout')stdout+=text;else stderr+=text;
        }
        child.stdout.on('data',chunk=>capture('stdout',chunk));child.stderr.on('data',chunk=>capture('stderr',chunk));
        child.on('error',error=>{clearTimeout(timer);reject(error);});
        child.on('close',code=>{clearTimeout(timer);resolve({stdout,stderr,exit_code:code??(stopped?124:1),root,source_fallback});});
      });
    }finally{running--;}
  };
}

/** Starts a bounded newline-JSON readonly port inside the existing proxy process. */
export async function startInspectSocket(file,inspect) {
  const server=createServer({allowHalfOpen:true},stream=>{
    let data='',handled=false;
    stream.setTimeout(11000,()=>stream.destroy());
    stream.on('data',chunk=>{
      if(handled)return;
      data+=chunk;
      if(Buffer.byteLength(data)>65536){stream.destroy();return;}
      if(data.includes('\n')) {
        handled=true;
        void (async()=>{
          try{if(data.trim().split('\n').length!==1)throw new Error('INSPECT_ONE_REQUEST_REQUIRED');stream.end(JSON.stringify(await inspect(JSON.parse(data)))+'\n');}
          catch(error){stream.end(JSON.stringify({error:error.message})+'\n');}
        })();
      }
    });
    stream.on('error',()=>{});
  });
  server.maxConnections=16;
  await reclaimSocket(file);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
  await chmod(file,0o600);
  return async()=>{await new Promise(resolve=>server.close(resolve));await unlink(file).catch(()=>{});};
}

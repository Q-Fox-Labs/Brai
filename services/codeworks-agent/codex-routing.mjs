// ABOUTME: Маршрутизирует обычный native protocol по серверному cwd и thread identity.
// ABOUTME: Admin остаётся upstream; Brai не получает native write/exec и клиентские permission overrides.
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const SETTINGS=new Set(['thread/start','thread/resume','thread/fork','turn/start']);
const FS_READ=new Set(['fs/readFile','fs/readDirectory','fs/getMetadata','fs/watch','fs/unwatch']);
const BLOCKED=new Set(['config/value/write','config/batchWrite','externalAgentConfig/import','environment/add','environment/update']);
const OFF_FEATURES=['shell_tool','code_mode','code_mode_only','js_repl','js_repl_tools_only'];

/** Canonicalizes missing descendants through their nearest existing parent, including symlinks. */
export async function canonicalPath(value) {
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error('ABSOLUTE_PATH_REQUIRED');
  let head=path.resolve(value),tail=[];
  for(;;) {
    try{return path.join(await realpath(head),...tail);}
    catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;const parent=path.dirname(head);if(parent===head)throw error;tail.unshift(path.basename(head));head=parent;}
  }
}

/** Builds immutable startup model metadata; rejects empty or unknown catalogue shape. */
export function readonlyCatalogue(input) {
  if(!Array.isArray(input?.models)||!input.models.length)throw new Error('MODEL_CATALOGUE_REQUIRED');
  return {...input,models:input.models.map(model=>({...model,apply_patch_tool_type:null,shell_type:'disabled',tool_mode:'direct',node_repl_disabled:true}))};
}

/** Overrides every model-controlled launch surface with this backend's fixed policy. */
export function enforceBrai(frame,{cwd,catalogue,mcpCommand,controlSocket,inspectSocket}) {
  if(!SETTINGS.has(frame.method))return structuredClone(frame);
  const out=structuredClone(frame),p=out.params??={};
  p.cwd=cwd;p.approvalPolicy='never';
  delete p.permissions;delete p.runtimeWorkspaceRoots;delete p.environments;delete p.dynamicTools;delete p.history;delete p.path;delete p.config;
  delete p.sandboxPolicy;delete p.permissionProfile;delete p.additionalPermissions;
  if(frame.method==='thread/start'||frame.method==='turn/start')p.environments=[];
  if(frame.method==='turn/start')p.sandboxPolicy={type:'readOnly'};else p.sandbox='read-only';
  if(frame.method!=='turn/start') {
    const config={approval_policy:'never',sandbox_mode:'read-only',model_catalog_json:catalogue,mcp_servers:{workspace:{command:mcpCommand[0],args:mcpCommand.slice(1),env:{CODEWORKS_CONTROL_SOCKET:controlSocket,...(inspectSocket?{CODEWORKS_INSPECT_SOCKET:inspectSocket}:{})},required:true}}};
    for(const feature of OFF_FEATURES)config['features.'+feature]=false;
    // AIDEV-NOTE: Do not merge arbitrary client MCP/config tables: they can install another writer.
    p.config=config;
  }
  return out;
}

/** Routes one client connection; children are opened lazily and requests stay ordered. */
export function createNativeRouter({roots,upstream,brai,send,resolvePath=canonicalPath,claimThread=()=>true,releaseThreads=()=>{}}) {
  const routes=new Map(),pending=new Map(),internal=new Map();
  const prefix='cw-router-'+randomUUID()+'-';
  const serverRequests=new Map();
  let sequence=0,initialize,initialized,managed,closed=false,braiSeen=false;
  const inside=(p,root)=>p===root||p.startsWith(root+path.sep);
  async function isBrai(value) {
    if(typeof value!=='string'||!path.isAbsolute(value))return false;
    const canonical=await resolvePath(value);
    return roots.some(root=>inside(canonical,root));
  }
  function error(id,message){if(id!==undefined)send({id,error:{code:-32000,message}});}
  function observe(route,frame) {
    if(closed)return;
    if(frame.id!==undefined&&internal.has(frame.id)) {
      const request=internal.get(frame.id);internal.delete(frame.id);clearTimeout(request.timer);
      if(frame.error)request.reject(new Error(frame.error.message));else request.resolve(frame.result);return;
    }
    const key=route+':'+String(frame.id),request=pending.get(key);
    if(request) {
      pending.delete(key);
      if(frame.result?.thread?.id){if(route==='brai'&&!claimThread(frame.result.thread.id)){error(frame.id,'THREAD_ALREADY_CONNECTED');return;}routes.set(frame.result.thread.id,route);}
    }
    // Keep a backend's thread notifications on the same owning route.
    const id=frame.params?.threadId??frame.params?.thread?.id;
    if(id&&routes.has(id)&&routes.get(id)!==route)return;
    if(frame.method&&frame.id!==undefined) {
      const id=prefix+route+'-'+String(frame.id);serverRequests.set(id,{route,id:frame.id});send({...frame,id});return;
    }
    send(frame);
  }
  const upstreamReady=Promise.resolve(upstream(frame=>observe('admin',frame)));
  void upstreamReady.catch(()=>{}); // The first receive reports the connection error without an unhandled rejection.
  async function requestAdmin(method,params) {
    const connection=await upstreamReady,id=prefix+(++sequence);
    const result=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{internal.delete(id);reject(new Error('NATIVE_LOOKUP_TIMEOUT'));},10000);
      internal.set(id,{resolve,reject,timer});
    });
    await connection.receive({id,method,params});return result;
  }
  async function managedConnection() {
    if(!managed)managed=(async()=>{
      if(!initialize)throw new Error('INITIALIZE_REQUIRED');
      const connection=await brai(frame=>observe('brai',frame));
      const id=prefix+(++sequence);
      const ready=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{internal.delete(id);reject(new Error('BRAI_INITIALIZE_TIMEOUT'));},10000);
        internal.set(id,{resolve,reject,timer});
      });
      await connection.receive({...initialize,id});await ready;
      if(initialized)await connection.receive(initialized);
      return connection;
    })();
    return managed;
  }
  async function routeThread(id) {
    if(routes.has(id))return routes.get(id);
    const result=await requestAdmin('thread/read',{threadId:id,includeTurns:false});
    const route=await isBrai(result?.thread?.cwd)?'brai':'admin';
    routes.set(id,route);return route;
  }
  return {
    /** Handles a decoded client frame without classifying shell text or trusting client identities. */
    async receive(input) {
      if(closed)throw new Error('ROUTER_CLOSED');
      const frame=structuredClone(input),p=frame.params??{};
      if(frame.method==='initialize')initialize=structuredClone(frame);
      if(frame.method==='initialized')initialized=structuredClone(frame);
      if(!frame.method) {
        // Native server-request responses retain their source backend.
        const origin=serverRequests.get(frame.id);
        if(!origin){error(frame.id,'SERVER_REQUEST_NOT_ADMITTED');return;}
        serverRequests.delete(frame.id);
        return (origin.route==='brai'?await managedConnection():await upstreamReady).receive({...frame,id:origin.id});
      }
      if(frame.method.startsWith('fs/')&&!FS_READ.has(frame.method)) {
        const targets=['path','sourcePath','destinationPath'].map(key=>p[key]).filter(Boolean);
        for(const target of targets)if(await isBrai(target)){error(frame.id,'BRAI_UNTHREADED_WRITE_DENIED');return;}
        if(!targets.length&&braiSeen){error(frame.id,'BRAI_UNTHREADED_WRITE_DENIED');return;}
      }
      if(frame.method==='command/exec'&&(braiSeen||await isBrai(p.cwd))){error(frame.id,'BRAI_UNTHREADED_COMMAND_DENIED');return;}
      if(BLOCKED.has(frame.method)&&braiSeen){error(frame.id,'BRAI_CONTROL_OVERRIDE_DENIED');return;}
      let route='admin';
      if(frame.method==='thread/start')route=await isBrai(p.cwd)?'brai':'admin';
      else if(typeof p.threadId==='string') {
        try{route=await routeThread(p.threadId);}catch(cause){error(frame.id,'THREAD_ROUTE_LOOKUP_FAILED: '+cause.message);return;}
      }
      if(route==='brai') {
        if(p.threadId&&!claimThread(p.threadId)){error(frame.id,'THREAD_ALREADY_CONNECTED');return;}
        braiSeen=true;
        // AIDEV-NOTE: unsubscribe removes a subscriber, not the runtime. Never cold-copy a live writer.
        if(['thread/resume','thread/fork'].includes(frame.method)) {
          let cursor;
          do {
            const result=await requestAdmin('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});
            if(result?.data?.includes(p.threadId)){error(frame.id,'LEGACY_THREAD_RECONNECT_REQUIRED: cold resume the same chat after its previous runtime has stopped');return;}
            cursor=result?.nextCursor;
          }while(cursor);
        }
      }
      const connection=route==='brai'?await managedConnection():await upstreamReady;
      if(frame.id!==undefined){if(pending.size>=4096){error(frame.id,'NATIVE_PENDING_LIMIT');return;}pending.set(route+':'+String(frame.id),{method:frame.method});}
      await connection.receive(frame);
    },
    /** Shuts down only children owned by this connection; the upstream native daemon survives. */
    async close() {
      closed=true;
      for(const request of internal.values()){clearTimeout(request.timer);request.reject(new Error('ROUTER_CLOSED'));}
      internal.clear();
      (await upstreamReady).close();
      if(managed)await (await managed.catch(()=>null))?.close();
      releaseThreads();
    },
  };
}

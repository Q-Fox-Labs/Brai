// ABOUTME: Маршрутизирует обычный native protocol по серверному cwd и thread identity.
// ABOUTME: Admin остаётся upstream; Brai не получает native write/exec и клиентские permission overrides.
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const SETTINGS=new Set(['thread/start','thread/resume','thread/fork','turn/start','thread/settings/update']);
// Exact 0.163 client thread API; new endpoints require admission review before forwarding.
const BRAI_THREAD_METHODS=new Set("thread/start thread/resume thread/fork thread/archive thread/delete thread/unsubscribe thread/increment_elicitation thread/decrement_elicitation thread/name/set thread/prediction/request thread/goal/set thread/goal/get thread/goal/clear thread/queue/add thread/queue/list thread/queue/update thread/queue/delete thread/queue/reorder thread/queue/start thread/metadata/update thread/attachment/add thread/attachment/list thread/attachmentOwner/list thread/attachment/remove thread/section/move thread/settings/update thread/memoryMode/set thread/unarchive thread/compact/start thread/backgroundTerminals/clean thread/backgroundTerminals/list thread/backgroundTerminals/terminate thread/revert thread/list thread/search thread/searchOccurrences thread/loaded/list thread/read thread/readState/update thread/turns/list thread/items/list thread/items/read thread/inject_items turn/start turn/settings/update turn/steer turn/interrupt thread/realtime/start thread/realtime/appendAudio thread/realtime/appendText thread/realtime/appendSpeech thread/realtime/stop thread/timeline/list thread/realtime/listVoices review/start mcpServerStatus/list".split(' '));
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
  const policyUpdate=frame.method==='turn/start'||frame.method==='thread/settings/update';
  if(policyUpdate)p.sandboxPolicy={type:'readOnly'};else p.sandbox='read-only';
  if(!policyUpdate) {
    const config={approval_policy:'never',sandbox_mode:'read-only',model_catalog_json:catalogue,mcp_servers:{workspace:{command:mcpCommand[0],args:mcpCommand.slice(1),env:{CODEWORKS_CONTROL_SOCKET:controlSocket,...(inspectSocket?{CODEWORKS_INSPECT_SOCKET:inspectSocket}:{})},required:true,default_tools_approval_mode:'approve',omit_tools_from:['deferred','code_mode']}}};
    for(const feature of OFF_FEATURES)config['features.'+feature]=false;
    // AIDEV-NOTE: Do not merge arbitrary client MCP/config tables: they can install another writer.
    p.config=config;
  }
  return out;
}

/** Маршрутизирует общее соединение; attachmentRoot задаётся доверенной конфигурацией, не клиентом. */
export function createNativeRouter({roots,workspaceRoots=[],attachmentRoot,visualizationRoot,upstream,brai,send,resolvePath=canonicalPath,claimThread=()=>true,releaseThreads=()=>{}}) {
  const routes=new Map(),pending=new Map(),internal=new Map();
  const prefix='cw-router-'+randomUUID()+'-';
  const serverRequests=new Map();
  let sequence=0,initialize,initialized,managed,closed=false,braiSeen=false;
  const inside=(p,root)=>p===root||p.startsWith(root+path.sep);
  async function isBrai(value) {
    if(typeof value!=='string'||!path.isAbsolute(value))return false;
    const canonical=await resolvePath(value);
    return [...roots,...workspaceRoots].some(root=>inside(canonical,root));
  }

  // AIDEV-NOTE: Desktop загружает вложения без threadId на общем соединении.
  // Разрешена только его отдельная область; config и project writers остаются закрыты.
  async function attachmentWrite(frame) {
    const p=frame.params??{},method=frame.method;
    if(typeof attachmentRoot!=='string'||!path.isAbsolute(attachmentRoot)||p.environmentId!=null)return false;
    const target=method==='fs/copy'?p.destinationPath:p.path;
    if(typeof target!=='string'||!path.isAbsolute(target))return false;
    const root=path.resolve(attachmentRoot),relative=path.relative(root,target),parts=relative.split(path.sep);
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parts[0]);
    const registry=method==='fs/writeFile'&&relative==='pasted-text-attachments.json';
    const directory=['fs/createDirectory','fs/remove'].includes(method)&&uuid&&parts.length===1;
    const file=['fs/writeFile','fs/copy','fs/remove'].includes(method)&&uuid&&parts.length===2;
    if(!registry&&!directory&&!file)return false;
    return await resolvePath(root)===root&&await resolvePath(target)===path.resolve(target);
  }

  // AIDEV-NOTE: Desktop создаёт папку визуализаций до каждого текстового turn.
  // Это только mkdir служебного каталога; запись файлов и команды не разрешаются.
  async function visualizationDirectory(frame) {
    const p=frame.params??{};
    if(frame.method!=='fs/createDirectory'||p.environmentId!=null||typeof visualizationRoot!=='string'||!path.isAbsolute(visualizationRoot)||typeof p.path!=='string'||!path.isAbsolute(p.path))return false;
    const root=path.resolve(visualizationRoot),relative=path.relative(root,p.path);
    if(!/^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(relative))return false;
    return await resolvePath(root)===root&&await resolvePath(p.path)===path.resolve(p.path);
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
      // Native fs/process RPCs have no authoritative thread ownership. Admit their
      // writer capability only on an Admin-only connection, outside protected roots.
      // Treat entire execution families as writers; argv never proves readonly.
      const writer=frame.method.startsWith('fs/')&&!FS_READ.has(frame.method)?'filesystem':
        frame.method.startsWith('command/')||frame.method.startsWith('process/')?'execution':null;
      if(writer) {
        const targets=(writer==='filesystem'?['path','sourcePath','destinationPath']:['cwd']).map(key=>p[key]).filter(Boolean);
        if(braiSeen&&!(writer==='filesystem'&&(await attachmentWrite(frame)||await visualizationDirectory(frame)))){error(frame.id,writer==='filesystem'?'BRAI_UNTHREADED_WRITE_DENIED':'BRAI_UNTHREADED_COMMAND_DENIED');return;}
        for(const target of targets)if(await isBrai(target)){error(frame.id,writer==='filesystem'?'BRAI_UNTHREADED_WRITE_DENIED':'BRAI_UNTHREADED_COMMAND_DENIED');return;}
      }
      if(BLOCKED.has(frame.method)&&braiSeen){error(frame.id,'BRAI_CONTROL_OVERRIDE_DENIED');return;}
      let route='admin';
      if(frame.method==='thread/start')route=await isBrai(p.cwd)?'brai':'admin';
      else if(typeof p.threadId==='string') {
        try{route=await routeThread(p.threadId);}catch(cause){error(frame.id,'THREAD_ROUTE_LOOKUP_FAILED: '+cause.message);return;}
      }
      if(route==='brai') {
        if(!BRAI_THREAD_METHODS.has(frame.method)){error(frame.id,'BRAI_NATIVE_THREAD_CAPABILITY_DENIED');return;}
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

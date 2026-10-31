// ABOUTME: Подключает NATS Services, Artifacts HTTP и Temporal к потребностям Приёма.
// ABOUTME: Ни адрес назначения, ни файловый URL не берутся из входного payload.
import { createHash } from 'node:crypto';
import { headers, type NatsConnection } from 'nats';
import { Client } from '@temporalio/client';
import {contactInput,checkContact,checkContactHistory,contactError} from './contact-contract.js';
import {channelRequest,checkResolution,channelError} from './channel-contract.js';
import type { Config } from './config.js';
import { Fault, type Attachment, type Data, type Message, type Packet, type Ports } from './types.js';
const timeout=15000;
/** Выдаёт детерминированный UUID для неизменяемого факта истории. */
function uuid(key:string):string {const h=createHash('sha256').update(key).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
/** Создаёт реальные адаптеры; недоступность никогда не заменяется синтетикой. */
export function createPorts(nc:NatsConnection,client:Client,cfg:Config):Ports {
 let activeUploads=0;
 async function rpc(subject:string,input:unknown,isChannel=false,isContact=false,deadline=timeout):Promise<Data> {
  let reply;
  const bytes=Buffer.from(JSON.stringify(input));if(bytes.length>(isChannel||isContact?65536:1048576))throw new Fault('DEPENDENCY_REQUEST_TOO_LARGE');
  try { reply=await nc.request(subject,bytes,{timeout:deadline}); } catch {throw new Fault('DEPENDENCY_UNAVAILABLE',true);}
  if((isChannel||isContact)&&reply.data.length>131072)throw new Fault(isContact?'INVALID_CONTACT_RESULT':'INVALID_CHANNEL_RESULT');
  if(reply.headers?.get('Nats-Service-Error-Code')) {
   const status=Number(reply.headers.get('Nats-Service-Error-Code'));
   if(isChannel){let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reply.data));}catch{throw new Fault('INVALID_CHANNEL_RESULT');}throw channelError(value,status);}
   if(isContact){let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reply.data));}catch{throw new Fault('INVALID_CONTACT_RESULT');}throw contactError(value,status);}
   throw new Fault(status>=500?'DEPENDENCY_UNAVAILABLE':'DEPENDENCY_REJECTED',status>=500);
  }
  try {const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reply.data));if(!value || typeof value!=='object' || Array.isArray(value)) throw Error();return value;} catch {throw new Fault(isContact?'INVALID_CONTACT_RESULT':isChannel?'INVALID_CHANNEL_RESULT':'INVALID_DEPENDENCY_RESULT');}
 }
 async function artifact(id:string,owner:string):Promise<Data> {
  const a=await rpc('brai.artifacts.v1.get',{artifactId:id});
  if(a.ownerId!==owner) throw new Fault('FORBIDDEN_ARTIFACT');
  return a;
 }
 return {
  async call(name,p,operationId,extra={}) {
   if(name==='channel'){
    const reply=(extra.replyContext??null) as Data|null;
    const result=await rpc(cfg.ports.channel.subject,channelRequest(p,reply),true);checkResolution(p,result,reply);return result;
   }
   if(name==='contact'){if(!p.contactRequest)throw new Fault('CONTACT_CONTEXT_VERSION_UNSUPPORTED');const result=await rpc(cfg.ports.contact.subject,p.contactRequest,false,true);checkContact(p,result);return result;}
   return rpc(cfg.ports[name].subject,{packetId:p.id,operationId,ownerId:p.ownerId,scenario:p.scenario,event:p.original,prepared:p.prepared??null,context:p.context??null,inboxRef:p.inboxRef??null,priorResults:Object.values(p.jobs).filter(j=>name==='memory' && j.kind==='understand' && j.state==='succeeded').map(j=>({kind:j.kind,result:j.result})),...extra});
  },
  async prepareContact(p,signal){
   signal?.throwIfAborted();
   const candidate=(p.original.data as Message).author.photoArtifactId;
   let ready=false,diagnostic:Data|undefined;
   if(typeof candidate==='string'){
    try{const a=await rpc('brai.artifacts.v1.get',{artifactId:candidate},false,false,1000);ready=a.ownerId===p.ownerId&&a.status==='ready'&&String(a.artifactId).toLowerCase()===candidate.toLowerCase();if(!ready)diagnostic={code:'PHOTO_UNAVAILABLE'};}
    catch{signal?.throwIfAborted();diagnostic={code:'PHOTO_UNAVAILABLE'};}
   }
   signal?.throwIfAborted();const value=contactInput(p,ready);if(diagnostic)value.diagnostics.push(diagnostic);return value;
  },
  async prepareFiles(p,signal) {
   if(activeUploads>=2) throw new Fault('UPLOAD_BUSY',true);
   activeUploads++;
   try {
   const items=(p.original.data as Message).attachments, result:Data[]=[];
   for(let position=0;position<items.length;position++) {
    const item:Attachment=items[position];let a:Data;
    if(item.artifactId) {a=await artifact(item.artifactId,p.ownerId);}
    else {
     const base=cfg.sources[p.source].fileBaseUrl;
     if(!base) throw new Fault('SOURCE_FILES_NOT_CONFIGURED');
     if(item.fileId==='.' || item.fileId==='..') throw new Fault('INVALID_ARGUMENT');
     const prefix=new URL(base);prefix.pathname=prefix.pathname.replace(/\/$/,'')+'/';
     const sourceUrl=new URL(encodeURIComponent(item.fileId!),prefix);
     if(sourceUrl.origin!==prefix.origin || !sourceUrl.pathname.startsWith(prefix.pathname)) throw new Fault('INVALID_ARGUMENT');
     const ext=item.filename.includes('.')?item.filename.split('.').pop()!:'';
     const key='intake/'+createHash('sha256').update(p.ownerId+'/'+p.source+'/'+p.original.data.materialId+'/'+item.fileId).digest('hex');
     const prepared=await rpc('brai.artifacts.v1.prepare',{requestId:key,ownerId:p.ownerId,kind:'original',metadata:{title:item.filename,filename:item.filename,extension:ext,mimeType:item.mimeType,source:'intake'}});
     a=prepared.artifact as Data;
     if(!a || typeof a.artifactId!=='string' || a.ownerId!==p.ownerId) throw new Fault('INVALID_ARTIFACT_RESULT');
     if(a.status!=='ready') {
      const upload=new URL(String(prepared.uploadUrl));
      if(upload.origin!==new URL(cfg.artifactBaseUrl).origin) throw new Fault('INVALID_ARTIFACT_ORIGIN');
      const input=await fetch(sourceUrl,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1800000)]):AbortSignal.timeout(1800000),redirect:'error'});
      if(!input.ok || !input.body) throw new Fault('SOURCE_FILE_UNAVAILABLE',input.status>=500);
      let size=0;
      const body=input.body.pipeThrough(new TransformStream({transform(chunk,controller){size+=chunk.length;if(size>2147483648)throw new Fault('FILE_TOO_LARGE');controller.enqueue(chunk);}}));
      const init:RequestInit & {duplex:'half'}={method:'PUT',body,duplex:'half',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1800000)]):AbortSignal.timeout(1800000),redirect:'error'};
      const saved=await fetch(upload,init);
      if(!saved.ok && saved.status!==409) throw new Fault('ARTIFACT_UPLOAD_UNAVAILABLE',true);
      a=await artifact(String(a.artifactId),p.ownerId);
     }
    }
    if(a.status!=='ready') throw new Fault('ARTIFACT_NOT_READY',true);
    result.push({artifactId:a.artifactId,position,filename:item.filename,mimeType:item.mimeType,caption:item.caption??null});
   }
   return result;
   } finally {activeUploads--;}
  },
  async publish(subject,event,id,ownerId) {const h=headers();h.set('Brai-Owner-Id',ownerId);h.set('Brai-Intake-Packet-Id',id.split('/')[0]);await nc.jetstream().publish(subject,Buffer.from(JSON.stringify(event)),{msgID:id,headers:h});},
  async startWorkflow(p) {
   try {await client.workflow.start('intakeMessageV1',{workflowId:p.workflowId!,taskQueue:cfg.taskQueue,args:[p.id],workflowIdConflictPolicy:'USE_EXISTING',workflowIdReusePolicy:'REJECT_DUPLICATE'});}
   catch(e) {
    if(!(e instanceof Error) || e.name!=='WorkflowExecutionAlreadyStartedError') throw e;
    const status=await client.workflow.getHandle(p.workflowId!).describe();
    if(status.status.name!=='RUNNING' && p.state!=='completed') throw new Fault('WORKFLOW_CLOSED',true);
   }
  },
  async signalWorkflow(p) {await client.workflow.getHandle(p.workflowId!).signal('changed');},
  async history(p,phase) {
   if(phase==='complete'&&p.original.type==='message.incoming'&&p.contact){checkContact(p,p.contact);for(const event of p.contact.historyEvents as Data[]){const saved=await rpc('brai.history.v1.append.service_contacts',event);checkContactHistory(event,saved);}}
   await rpc('brai.history.v1.append.service_intake',{id:uuid(p.id+'/'+phase),type_id:phase==='receive'?1105:1106,occurred_at:phase==='receive'?p.receivedAt:p.completedAt,actor_id:null,scope_type:'user',scope_id:p.ownerId,object_type:'intake_packet',object_id:p.id,data:{phase:phase==='receive'?'registered':'completed',scenario:p.scenario}});
  }
 };
}

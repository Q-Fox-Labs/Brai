// ABOUTME: Подключает Auth, Artifacts и штатный HTTP Transcription к Дневнику.
// ABOUTME: Только защищённый diary binding делегирует проверенный личный principal.
import {createHash,timingSafeEqual} from 'node:crypto';
import {serviceDataScope} from '../../auth/contracts/service-data-scope.mjs';
import {DiaryFault,id} from './domain.mjs';
import {correctWithLuna} from './luna.mjs';
/** Ограничивает чтение ответа до JSON parse без усечения. */
export async function boundedJson(response,max=2*1024*1024){
 if(!response.body)throw new DiaryFault('BAD_REPLY',502);const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new DiaryFault('TOO_LARGE',413);parts.push(value);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,size)));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Секреты и URLs только из конфигурации; transport не журналирует payload. */
export function createAdapters(cfg,nc){
 const request=async(subject,input)=>{
  let reply;try{reply=await nc.request(subject,Buffer.from(JSON.stringify(input)),{timeout:10000});}catch{throw new DiaryFault('DEPENDENCY_UNAVAILABLE',503);}
  if(reply.headers?.has('Nats-Service-Error'))throw new DiaryFault('DEPENDENCY_UNAVAILABLE',503);
  if(reply.data.length>2*1024*1024)throw new DiaryFault('BAD_REPLY',502);return JSON.parse(Buffer.from(reply.data).toString());
 };
 const active=async(owner,profileId)=>{
  const r=await request('brai.auth.v2.identity-get',{userId:owner});
  if(r.user?.id!==owner||r.user?.profileId!==profileId||r.user?.status!=='active')throw new DiaryFault('USER_REVOKED',403);
  return r.user;
 };
 async function authenticate(req){
  const authorization=req.headers.authorization??'';
  if(authorization.startsWith('Bearer ')){
   const digest=createHash('sha256').update(authorization.slice(7)).digest();
   const binding=cfg.mcpBindings.find(b=>timingSafeEqual(createHash('sha256').update(b.token).digest(),digest));
   if(!binding)throw new DiaryFault('UNAUTHORIZED',401);
   return active(binding.userId,binding.profileId);
  }
  const headers={cookie:req.headers.cookie??''};
  const r=await request('brai.auth.v1.session',{headers,body:{}});
  if(r.status!==200||!r.body?.user?.id||r.body.user.status!=='active'||r.body.session?.userId!==r.body.user.id||!(Date.parse(r.body.session.expiresAt)>Date.now())||!r.body.user.profileId)throw new DiaryFault('UNAUTHORIZED',401);
  if(req.headers['x-brai-user']!==r.body.user.id)throw new DiaryFault('ACCOUNT_CHANGED',401);
  return r.body.user;
 }
 function artifactReady(a,e){
  if(a.ownerId!==e.ownerId||a.source!=='diary'||a.kind!=='original'||a.filename!==e.audioInput.filename||a.mimeType!==e.audioInput.mimeType)throw new DiaryFault('ARTIFACT_OWNER_MISMATCH',403);
  return a;
 }
 async function prepared(e){
  const p=await request('brai.artifacts.v1.prepare',{requestId:'diary:audio:'+e.ownerId+':'+e.requestId,ownerId:e.ownerId,kind:'original',metadata:{title:e.audioInput.filename,filename:e.audioInput.filename,extension:e.audioInput.filename.split('.').at(-1).slice(0,32),mimeType:e.audioInput.mimeType,source:'diary',details:{entryId:e.id,role:'original'}}});
  artifactReady(p.artifact,e);
  const url=new URL(p.uploadUrl);
  if(url.origin!==cfg.artifactsUploadOrigin||!/^\/upload\/[A-Za-z0-9_-]{16,512}$/.test(url.pathname)||url.username||url.password||url.search||url.hash)throw new DiaryFault('BAD_REPLY',502);
  return p;
 }
 async function transcription(e,method,params){
  await active(e.ownerId,e.profileId);
  const principal={ownerId:e.ownerId,scopeType:'user',scopeId:serviceDataScope(e.profileId),permissions:['transcription:use']};
  const response=await fetch(cfg.transcriptionOrigin+'/internal/identity/transcription',{method:'POST',headers:{Authorization:'Bearer '+cfg.transcriptionToken,'content-type':'application/json',origin:cfg.origin},body:JSON.stringify({method,params,principal}),signal:AbortSignal.timeout(20000),redirect:'error'});
  const value=await boundedJson(response);
  if(!response.ok)throw new DiaryFault(value.errorCode==='RESULT_UNAVAILABLE'?'TRANSCRIPT_LOST':'TRANSCRIPTION_'+(/^[A-Z_]{1,64}$/.test(value.errorCode??'')?value.errorCode:'BAD_REPLY'),response.status);
  return value;
 }
 return {authenticate,active,prepared,
  async transcriptionStatus(e){return transcription(e,'request.submit',{clientIdempotencyKey:e.id,audioArtifactId:e.audioArtifactId,requestedModel:null,deadlineAt:null});},
  async artifact(e){return (await prepared(e)).artifact;},
  async file(e){const a=(await prepared(e)).artifact;if(a.status!=='ready')throw new DiaryFault('NOT_READY',409);const url=new URL(a.internalUrl);if(url.origin!==cfg.artifactsInternalOrigin||url.pathname!=='/files/'+id(a.artifactId)||url.username||url.password||url.search||url.hash)throw new DiaryFault('BAD_REPLY',502);return {artifact:a,url:url.href};},
  async transcribe(e){
   const submitted=await transcription(e,'request.submit',{clientIdempotencyKey:e.transcriptionRetry?.key??e.id,audioArtifactId:e.audioArtifactId,requestedModel:null,deadlineAt:null});
   const record=submitted.request??submitted;
   if(['failed','outcome_unknown','cancelled'].includes(record.taskState))throw new DiaryFault('TRANSCRIPTION_FAILED',409);
   const response=await transcription(e,'result.get',{requestId:record.requestId});
   if(response.state==='available'&&response.result)return {text:response.result.text,provenance:{requestId:record.requestId,actualModel:response.result.actualModel,receivedAt:new Date().toISOString()}};
   if(['lost','expired'].includes(response.state))throw new DiaryFault('TRANSCRIPT_LOST',409);
   return null;
  },
  async correct(e){await active(e.ownerId,e.profileId);return correctWithLuna(cfg.luna,e);}
 };
}

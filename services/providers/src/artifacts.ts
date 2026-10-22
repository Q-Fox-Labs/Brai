// ABOUTME: Читает text/plain и сохраняет точные output bytes через публичный artifacts API.
// ABOUTME: Проверяет владельца, состояние, origin и hash; URLs не выходят в модель или результат.
import { createHash } from 'node:crypto';
import type { NatsConnection } from 'nats';
import { validateRequest, validateResponse, subjects, type Artifact } from '../../artifacts/contracts/index.mjs';
import { IMAGE_MODEL } from './image.js';
import { Failure } from './core.js';
export const ARTIFACT_LIMITS=Object.freeze({textBytes:65536,outputBytes:16777216,pendingBytes:33554432,timeoutMs:15000,ttlMs:86400000});
export type TextArtifact={artifactId:string;text:string};
export type PendingOutput={ownerId:string;operationId:string;inputHash:string;requestId:string;bytes:Buffer;sha256:string;expiresAt:number};
export interface ArtifactPort {
  text(ownerId:string,artifactIds:string[],signal:AbortSignal):Promise<TextArtifact[]>;
  save(output:PendingOutput,signal:AbortSignal):Promise<{artifactId:string;status:'ready';sizeBytes:number;sha256:string}>;
}
/** Ограничивает поток до конкатенации; timeout задаётся caller signal. */
export async function boundedBytes(body:ReadableStream<Uint8Array>|null,limit:number) {
  if(!body)throw new Error('ARTIFACT_BODY');const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('ARTIFACT_BODY_LIMIT');}chunks.push(value);}return Buffer.concat(chunks);}finally{reader.releaseLock();}
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Только доверенные exact origins; metadata и HTTP завершаются в конечный срок. */
export function artifactsPort(nc:Pick<NatsConnection,'request'>,config:{internalOrigin:string;uploadOrigin:string}):ArtifactPort {
  function origin(value:string){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('INVALID_ARTIFACT_ORIGIN');return u.origin;}
  const internal=origin(config.internalOrigin),upload=origin(config.uploadOrigin);
  function url(value:string,expected:string,path:RegExp){const u=new URL(value);if(u.origin!==expected||u.username||u.password||u.search||u.hash||!path.test(u.pathname))throw new Error('ARTIFACT_ORIGIN');return u;}
  async function call(subject:string,input:unknown,signal:AbortSignal){
    signal.throwIfAborted();if(!validateRequest(subject,input))throw new Error('ARTIFACT_REQUEST');
    const msg=await nc.request(subject,new TextEncoder().encode(JSON.stringify(input)),{timeout:ARTIFACT_LIMITS.timeoutMs});signal.throwIfAborted();
    if(msg.headers?.get('Nats-Service-Error'))throw new Error('ARTIFACT_SERVICE');
    if(msg.data.byteLength>131072)throw new Error('ARTIFACT_METADATA_LIMIT');
    const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(msg.data));if(!validateResponse(subject,data))throw new Error('ARTIFACT_RESPONSE');return data;
  }
  const get=async(id:string,signal:AbortSignal)=>await call(subjects.get,{artifactId:id},signal) as Artifact;
  function ready(a:Artifact,owner:string){if(a.ownerId!==owner||a.status!=='ready'||a.deletedAt||!a.internalUrl||a.sizeBytes===null||a.sha256===null)throw new Error('ARTIFACT_NOT_READY');}
  return {
    async text(owner,ids,signal){
      try{let total=0;const out:TextArtifact[]=[];
        for(const id of ids){const timeout=AbortSignal.any([signal,AbortSignal.timeout(ARTIFACT_LIMITS.timeoutMs)]);const a=await get(id,timeout);ready(a,owner);if(a.artifactId.toLowerCase()!==id.toLowerCase())throw new Error('ARTIFACT_ID');
          if(a.mimeType!=='text/plain'||a.sizeBytes!>ARTIFACT_LIMITS.textBytes||total+a.sizeBytes!>ARTIFACT_LIMITS.textBytes)throw new Error('ARTIFACT_SIZE_OR_MIME');
          const address=url(a.internalUrl!,internal,new RegExp('^/files/'+id+'$','i'));
          const res=await fetch(address,{redirect:'error',signal:timeout});if(!res.ok){await res.body?.cancel();throw new Error('ARTIFACT_HTTP');}
          const bytes=await boundedBytes(res.body,ARTIFACT_LIMITS.textBytes-total);if(bytes.length!==a.sizeBytes||sha(bytes)!==a.sha256)throw new Error('ARTIFACT_HASH');
          const after=await get(id,timeout);ready(after,owner);if(after.sha256!==a.sha256||after.sizeBytes!==a.sizeBytes||after.mimeType!==a.mimeType||after.internalUrl!==a.internalUrl)throw new Error('ARTIFACT_CHANGED');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw new Error('ARTIFACT_TEXT');total+=bytes.length;out.push({artifactId:id,text});
        }return out;
      }catch{throw new Failure('INVALID_ARTIFACT','not_sent');}
    },
    async save(output,signal){
      const timeout=AbortSignal.any([signal,AbortSignal.timeout(ARTIFACT_LIMITS.timeoutMs)]);
      const prepared=await call(subjects.prepare,{requestId:output.requestId,ownerId:output.ownerId,kind:'original',metadata:{title:'Generated image',filename:'image.png',extension:'png',mimeType:'image/png',source:'providers',details:{operationId:output.operationId,provider:'openrouter',model:IMAGE_MODEL}}},timeout) as {artifact:Artifact;uploadUrl:string};
      const a=prepared.artifact;if(a.ownerId!==output.ownerId||a.requestId!==output.requestId)throw new Error('ARTIFACT_OWNER');
      if(a.status!=='ready'){
        if(a.status!=='pending'&&a.status!=='failed')throw new Error('ARTIFACT_STATE');
        const address=url(prepared.uploadUrl,upload,/^\/upload\/[A-Za-z0-9_-]+$/);
        // AIDEV-NOTE: Потеря PUT ответа не меняет requestId/bytes. get ниже подтверждает ready даже после409.
        try{const res=await fetch(address,{method:'PUT',redirect:'error',signal:timeout,headers:{'content-type':'image/png'},body:new Uint8Array(output.bytes)});await res.body?.cancel();}catch{timeout.throwIfAborted();}
      }
      const saved=await get(a.artifactId,timeout);ready(saved,output.ownerId);if(saved.sizeBytes!==output.bytes.length||saved.sha256!==output.sha256||saved.mimeType!=='image/png')throw new Error('ARTIFACT_HASH');
      return {artifactId:saved.artifactId,status:'ready',sizeBytes:saved.sizeBytes!,sha256:saved.sha256!};
    }
  };
}

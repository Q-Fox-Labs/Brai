// ABOUTME: Задаёт единственный image профиль и проверяет точный PNG без внешних загрузок.
// ABOUTME: Provider dataURI и normalized b64_json обязаны содержать одинаковые bytes.
import { Failure } from './core.js';
import { canonical, type Json } from './json.js';
export const IMAGE_MODEL='google/gemini-2.5-flash-image';
export const IMAGE_LIMIT=16777216;
export type ImageRequest={operationId:string;ownerId:string;provider:string;model:string;deadlineAt:string;prompt:string;size:'1024x1024';quality:'standard'|'low';n:1;responseFormat:'b64_json';artifactIds?:string[]};
export type ImageCompletion={bytes:Buffer;actualModel:string;usage:Json|null};
export type ImagePort=(input:ImageRequest,signal:AbortSignal)=>Promise<ImageCompletion>;
/** Закрытый upstream wire ожидается от stock OpenRouter image adapter. */
export function imageWire(input:ImageRequest){return {model:input.model,messages:[{role:'user',content:input.prompt}],n:1,image_config:{aspect_ratio:'1:1',image_size:'1K'},max_tokens:2048,provider:{only:['google-vertex/global'],order:['google-vertex/global'],require_parameters:true,allow_fallbacks:false}};}
/** Проверяет канонический base64, PNG IHDR и ровно1024×1024; максимум16MiB. */
export function imageBytes(value:unknown):Buffer {
  if(typeof value!=='string'||value.length>Math.ceil(IMAGE_LIMIT/3)*4||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Failure('UPSTREAM_PROTOCOL','unknown');
  const b=Buffer.from(value,'base64');if(b.length<33||b.length>IMAGE_LIMIT||b.toString('base64')!==value||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||b.toString('ascii',12,16)!=='IHDR'||b.readUInt32BE(16)!==1024||b.readUInt32BE(20)!==1024)throw new Failure('UPSTREAM_PROTOCOL','unknown');return b;
}
/** Сохраняет raw usage до stock нормализации и отклоняет иной model/count/format. */
export function rawImage(value:unknown):ImageCompletion {
 const raw=value as any;if(!raw||raw.model!==IMAGE_MODEL||!Array.isArray(raw.choices)||raw.choices.length!==1||!Array.isArray(raw.choices[0]?.message?.images)||raw.choices[0].message.images.length!==1)throw new Failure('UPSTREAM_PROTOCOL','unknown');
 const uri=raw.choices[0].message.images[0]?.image_url?.url;if(typeof uri!=='string'||!uri.startsWith('data:image/png;base64,'))throw new Failure('UPSTREAM_PROTOCOL','unknown');
 const usage=raw.usage??null;if(usage!==null&&Buffer.byteLength(canonical(usage))>8192)throw new Failure('UPSTREAM_PROTOCOL','unknown');return {bytes:imageBytes(uri.slice(22)),actualModel:raw.model,usage};
}

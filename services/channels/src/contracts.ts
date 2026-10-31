// ABOUTME: Проверяет owner DTO и нормализует устойчивые ключи Каналов.
// ABOUTME: Использует схемы владельцев без параллельных копий History DTO.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Ajv} from 'ajv';
import formatsModule from 'ajv-formats';
import {Fault,type Data} from './types.js';
const ajv=new Ajv({strict:false});
(formatsModule as unknown as (a:Ajv)=>void)(ajv);
const load=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const common=load('../schemas/common.schema.json'),api=load('../schemas/api.schema.json');
ajv.addSchema(load('../../history/schemas/common.schema.json'));
ajv.addSchema(load('../../history/schemas/messages.schema.json'));
ajv.addSchema(common);ajv.addSchema(api);
const validators=new Map<string,ReturnType<Ajv['compile']>>();
export const operations=Object.keys(api.definitions).filter(k=>k.endsWith('Request')).map(k=>k.slice(0,-7));
/** Канонический JSON: ключи сортируются, порядок массива сохраняется. */
export function canonical(v:any):string {
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 return JSON.stringify(v);
}
/** Хеширует нормализованное предметное содержимое. */
export function hash(v:any):string{return createHash('sha256').update(canonical(v)).digest('hex');}
/** Проверяет допустимость UTF-8/JSON и ограничивает глубину. */
export function representable(v:any,depth=0):boolean {
 if(depth>64)return false;
 if(typeof v==='number')return Number.isFinite(v);
 if(typeof v==='string')return !v.includes('\u0000')&&![...v].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;});
 if(v&&typeof v==='object')return Object.entries(v).every(([k,x])=>representable(k,depth+1)&&representable(x,depth+1));
 return true;
}
/** Валидирует именованный owner DTO; имя не берётся из входного payload. */
export function validate(name:string,value:any,commonType=false):boolean {
 const key=(commonType?'common/':'api/')+name;
 if(!validators.has(key))validators.set(key,ajv.compile({$ref:(commonType?common.$id:api.$id)+'#/definitions/'+name}));
 return !!validators.get(key)!(value)&&representable(value);
}
/** Применяет только объявленные defaults и нормализацию множества разрешённых авторов. */
export function request(op:string,value:any):Data {
 if(!operations.includes(op)||!validate(op+'Request',value))throw new Fault(value?.type&& (value.type.code!=='telegram'||value.type.version!==1)?'UNSUPPORTED_PROFILE':'INVALID_ARGUMENT');
 const v=structuredClone(value);
 if(op.endsWith('.list')){v.limit??=50;v.cursor??=null;}
 if(op==='resolve')v.initialFields??={};
 if(v.settings){v.settings.allowedActorIds.sort();checkExtensions(v.settings.extensions);}
 return v;
}
/** Отвергает слишком глубокие/большие расширения, не анализируя их как код. */
export function checkExtensions(v:any):void {
 if(Buffer.byteLength(JSON.stringify(v))>8192)throw new Fault('INVALID_ARGUMENT');
 const walk=(x:any,d:number):boolean=>d<=8&&(!x||typeof x!=='object'||Object.values(x).every(y=>walk(y,d+1)));
 if(!walk(v,0))throw new Fault('INVALID_ARGUMENT');
}
/** Сериализует ответ до COMMIT, чтобы непередаваемый результат не фиксировался. */
export function response(op:string,value:Data):Buffer {
 if(!validate(op+'Response',value))throw new Fault('NOT_READY');
 const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>131072)throw new Fault('RESPONSE_TOO_LARGE');return bytes;
}
export const profile:Data=load('../profiles/telegram.v1.json');

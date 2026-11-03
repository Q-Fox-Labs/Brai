// ABOUTME: Проверяет DTO Контактов и канонизирует предметные запросы.
// ABOUTME: History DTO читаются из поставляемых схем владельца.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Ajv} from 'ajv';
import formats from 'ajv-formats';
import {Fault,type Data} from './types.js';
const ajv=new Ajv({strict:false});
(formats as unknown as (a:Ajv)=>void)(ajv);
const load=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const common=load('../schemas/common.schema.json'),api=load('../schemas/api.schema.json');
for(const s of [load('../../history/schemas/common.schema.json'),load('../../history/schemas/messages.schema.json'),common,api])ajv.addSchema(s);
const validators=new Map<string,ReturnType<Ajv['compile']>>();
export const operations=['resolve','profile.observe','contacts.get','contacts.list','operations.get','status'];
export const fields=['name','username','photoArtifactId'];
/** Возвращает канонический JSON, сохраняя порядок массивов и написание строк. */
export function canonical(v:any):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
/** Хеширует полный нормализованный запрос. */
export function hash(v:any):string{return createHash('sha256').update(canonical(v)).digest('hex');}
/** Отвергает JSON, непредставимый в PostgreSQL, и чрезмерную глубину. */
export function representable(v:any,d=0):boolean {if(d>64)return false;if(typeof v==='number')return Number.isFinite(v);if(typeof v==='string')return !v.includes('\u0000')&&![...v].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;});return !v||typeof v!=='object'||Object.entries(v).every(([k,x])=>representable(k,d+1)&&representable(x,d+1));}
/** Проверяет именованный DTO без изменения входа. */
export function valid(name:string,v:any,shared=false):boolean {const key=(shared?'c/':'a/')+name;if(!validators.has(key))validators.set(key,ajv.compile({$ref:(shared?common.$id:api.$id)+'#/definitions/'+name}));return representable(v)&&!!validators.get(key)!(v);}
/** Применяет объявленные defaults; timestamp нормализует репозиторий до хеша. */
export function request(op:string,v:any):Data {
 if(!operations.includes(op))throw new Fault('INVALID_REQUEST');
 if(v?.identity?.namespace!==undefined&&v.identity.namespace!=='telegram'||v?.namespace!==undefined&&v.namespace!=='telegram')throw new Fault('UNSUPPORTED_NAMESPACE');
 if(!valid(op+'Request',v))throw new Fault('INVALID_REQUEST');
 const q=structuredClone(v);if(op==='contacts.list'){q.limit??=50;q.cursor??=null;}return q;
}
/** Проверяет передаваемость результата до COMMIT. */
export function response(op:string,v:Data):Buffer {if(!valid(op+'Response',v))throw new Fault('INTERNAL');const b=Buffer.from(JSON.stringify(v));if(b.length>131072)throw new Fault('RESULT_TOO_LARGE');return b;}

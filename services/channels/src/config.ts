// ABOUTME: Читает защищённую конфигурацию и проверяет явные полномочия caller.
// ABOUTME: Ошибки не раскрывают URL или credentials и возникают до подключения к сети.
import {readFileSync} from 'node:fs';
import {operations,representable} from './contracts.js';
import type {Caller} from './types.js';
export interface Config {databaseUrl:string;natsUrl:string;natsOptionsFile:string;cursorKeyFile:string;callers:Record<string,Caller>;}
const source=/^[a-z][a-z0-9_]{0,63}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:any,expected:string[])=>object(v)&&Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
const list=(v:any,valid:(x:any)=>boolean)=>Array.isArray(v)&&v.every(valid)&&new Set(v).size===v.length;
const text=(v:any)=>typeof v==='string'&&v.length>0&&v.length<=255&&/\S/.test(v);
function url(v:any,protocols:string[]):boolean{try{return typeof v==='string'&&protocols.includes(new URL(v).protocol);}catch{return false;}}
/** Проверяет настройки и binding теми же типами ID, которые использует wire-контракт. */
export function validateConfig(v:any):Config {
 if(!representable(v)||!keys(v,['databaseUrl','natsUrl','natsOptionsFile','cursorKeyFile','callers'])||!url(v.databaseUrl,['postgres:','postgresql:'])||!url(v.natsUrl,['nats:','tls:'])||!['natsOptionsFile','cursorKeyFile'].every(k=>typeof v[k]==='string'&&v[k].startsWith('/')&&v[k].length<=4096)||!object(v.callers))throw Error('INVALID_CHANNELS_CONFIG');
 const result=structuredClone(v);
 for(const [id,raw]of Object.entries(v.callers)){
  const b=raw as Caller;
  if(!source.test(id)||!keys(b,['ownerIds','operations','sourceIds','replySourceIds','connectionIds'])||!list(b.ownerIds,text)||!list(b.operations,x=>typeof x==='string'&&operations.includes(x)&&x!=='status')||!list(b.sourceIds,x=>typeof x==='string'&&source.test(x))||!list(b.replySourceIds,x=>typeof x==='string'&&source.test(x))||b.connectionIds!==null&&!list(b.connectionIds,x=>typeof x==='string'&&uuid.test(x)))throw Error('INVALID_CALLER_BINDING');
  if(b.connectionIds!==null)result.callers[id].connectionIds=b.connectionIds.map(x=>x.toLowerCase());
 }
 return result;
}
/** Возвращает только явно заданный runtime JSON. */
export function loadConfig():Config {const file=process.env.CHANNELS_CONFIG;if(!file)throw Error('MISSING_CHANNELS_CONFIG');return validateConfig(JSON.parse(readFileSync(file,'utf8')));}

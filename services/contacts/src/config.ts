// ABOUTME: Проверяет runtime configuration до сетевых соединений.
// ABOUTME: Полномочия берутся из защищённого файла, не из пользовательского payload.
import {readFileSync} from 'node:fs';
import {operations,representable,valid} from './contracts.js';
import type {Caller} from './types.js';
export interface Config {databaseUrl:string;natsUrl:string;natsOptionsFile:string;cursorKeyFile:string;callers:Record<string,Caller>;}
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:any,n:string[])=>object(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const list=(v:any,fn:(x:any)=>boolean)=>Array.isArray(v)&&v.every(fn)&&new Set(v).size===v.length;
const url=(v:any,protocols:string[])=>{try{return typeof v==='string'&&protocols.includes(new URL(v).protocol);}catch{return false;}};
/** Отвергает неверные bindings, URL и пути без раскрытия их значений. */
export function validateConfig(v:any):Config {
 if(!representable(v)||!keys(v,['databaseUrl','natsUrl','natsOptionsFile','cursorKeyFile','callers'])||!url(v.databaseUrl,['postgres:','postgresql:'])||!url(v.natsUrl,['nats:','tls:'])||!['natsOptionsFile','cursorKeyFile'].every(k=>typeof v[k]==='string'&&v[k].startsWith('/')&&v[k].length<=4096)||!object(v.callers))throw Error('INVALID_CONTACTS_CONFIG');
 for(const[id,b]of Object.entries(v.callers) as [string,any][]){if(!valid('source',id,true)||!keys(b,['ownerIds','sourceIds','operations'])||!list(b.ownerIds,x=>valid('id',x,true))||!list(b.sourceIds,x=>valid('source',x,true))||!list(b.operations,x=>typeof x==='string'&&operations.includes(x)&&x!=='status'))throw Error('INVALID_CALLER_BINDING');}
 return structuredClone(v);
}
/** Читает только явно заданный защищённый JSON, без .env. */
export function loadConfig():Config {if(!process.env.CONTACTS_CONFIG)throw Error('MISSING_CONTACTS_CONFIG');return validateConfig(JSON.parse(readFileSync(process.env.CONTACTS_CONFIG,'utf8')));}

// ABOUTME: Читает защищённую конфигурацию и явные полномочия caller.
// ABOUTME: Не читает .env и не хранит Telegram token в настройках канала.
import {readFileSync} from 'node:fs';
import {operations} from './contracts.js';
import type {Caller} from './types.js';
export interface Config {databaseUrl:string;natsUrl:string;natsOptionsFile:string;cursorKeyFile:string;callers:Record<string,Caller>;}
/** Проверяет конфигурацию до подключения к сети, не раскрывая её значения. */
export function validateConfig(v:any):Config {
 if(!v||typeof v!=='object'||!['databaseUrl','natsUrl','natsOptionsFile','cursorKeyFile'].every(k=>typeof v[k]==='string'&&v[k])||!v.callers||typeof v.callers!=='object'||Array.isArray(v.callers))throw Error('INVALID_CHANNELS_CONFIG');
 for(const [id,raw]of Object.entries(v.callers)){
  const b=raw as Caller;
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(id)||!b||!['ownerIds','operations','sourceIds','replySourceIds'].every(k=>Array.isArray((b as any)[k])&&(b as any)[k].every((x:any)=>typeof x==='string'&&x))||new Set(b.operations).size!==b.operations.length||b.operations.some(x=>!operations.includes(x)||x==='status')||b.connectionIds!==null&&(!Array.isArray(b.connectionIds)||b.connectionIds.some(x=>typeof x!=='string'||!x)))throw Error('INVALID_CALLER_BINDING');
 }
 return v;
}
/** Возвращает только явно заданный runtime JSON. */
export function loadConfig():Config {const file=process.env.CHANNELS_CONFIG;if(!file)throw Error('MISSING_CHANNELS_CONFIG');return validateConfig(JSON.parse(readFileSync(file,'utf8')));}

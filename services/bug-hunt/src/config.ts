// ABOUTME: Читает защищённые явные параметры экземпляра bug-hunt.
// ABOUTME: Не принимает настройки или credentials из предметного запроса.
import {readFileSync,lstatSync} from "node:fs";
import {GENERATION,EXTERNAL_PROJECTION_POLICY,prepareExternalProjection} from "./projection.js";
import type {Observation} from "./contracts.js";
import {generationPattern} from "./generations.js";
import {isAbsolute} from "node:path";

export interface Config {
 databaseURL:string;installationId:string;cursorKey:string;
 nats:{servers:string[];user?:string;password?:string;credsFile?:string;inboxPrefix:string};
 mcp:{host:string;port:number;allowedHosts:string[];allowedOrigins:string[];principalsFile:string;maxConnections:number};
 processing?:ProcessingConfig;
 maxReports:number;reportsPerMinute:number;maxDatabaseBytes:number;artifactsEnabled:boolean;
}
/** Читает обычный закрытый JSON-файл без symlink и общедоступных прав. */
export function readPrivate(path:string):any {
 if(!isAbsolute(path))throw new Error("INVALID_CONFIG");
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||![0,process.getuid?.()].includes(stat.uid)||stat.size>65536)throw new Error("INVALID_CONFIG");
 return JSON.parse(readFileSync(path,"utf8"));
}
/** Загружает runtime без owner credentials; миграция использует отдельный вход. */
export function config():Config {
 const cfg=readPrivate(process.env.BRAI_BUG_HUNT_CONFIG??"");
 const positive=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0;
 if(typeof cfg.databaseURL!=="string"||!cfg.databaseURL||typeof cfg.installationId!=="string"||!cfg.installationId||
 typeof cfg.cursorKey!=="string"||Buffer.byteLength(cfg.cursorKey)<32||!Array.isArray(cfg.nats?.servers)||!cfg.nats.servers.length||
 typeof cfg.nats.inboxPrefix!=="string"||!cfg.nats.inboxPrefix||
 typeof cfg.mcp?.host!=="string"||!Number.isSafeInteger(cfg.mcp.port)||cfg.mcp.port<0||cfg.mcp.port>65535||
 !Array.isArray(cfg.mcp.allowedHosts)||!cfg.mcp.allowedHosts.length||!Array.isArray(cfg.mcp.allowedOrigins)||
 typeof cfg.mcp.principalsFile!=="string"||!positive(cfg.mcp.maxConnections)||cfg.mcp.maxConnections>32||
 !positive(cfg.maxReports)||cfg.maxReports>1000000||!positive(cfg.reportsPerMinute)||cfg.reportsPerMinute>6000||!positive(cfg.maxDatabaseBytes)||cfg.maxDatabaseBytes<16777216||typeof cfg.artifactsEnabled!=="boolean")throw new Error("INVALID_CONFIG");
 cfg.processing=processingConfig(cfg.processing);
 return cfg;
}

/** Защищённая проекция привязана к хешу оригинала и проверена оператором до внешней отправки. */
export interface ApprovedExternalProjection {
 ownerId:string;inputHash:string;text:string;excludedFields:string[];policyVersion:string;
}
export interface ProcessingConfig {
 targetGeneration:string;
 enabled:boolean;embeddingEnabled:boolean;classificationEnabled:boolean;
 externalAllowedOwners:string[];externalProjections:ApprovedExternalProjection[];
 externalProjectionPolicy:typeof EXTERNAL_PROJECTION_POLICY|null;
 deadlineMs:number;intervalMs:number;heartbeatMs:number;leaseMs:number;
 intakeReserveBytes:number;maxDerivativeBytes:number;
 dailyLimits:{embedding:{owner:number;global:number};classification:{owner:number;global:number}};
}
/** Проверяет ограниченные настройки worker; отсутствие конфигурации сохраняет выключенный фон. */
export function processingConfig(value:unknown):ProcessingConfig {
 if(value!==undefined&&(!value||typeof value!=="object"||Array.isArray(value)))throw new Error("INVALID_PROCESSING_CONFIG");
 const raw=(value??{}) as Record<string,any>;
 if(Object.keys(raw).some(k=>!["targetGeneration","enabled","embeddingEnabled","classificationEnabled","externalAllowedOwners","externalProjections","externalProjectionPolicy","deadlineMs","intervalMs","heartbeatMs","leaseMs","intakeReserveBytes","maxDerivativeBytes","dailyLimits"].includes(k)))throw new Error("INVALID_PROCESSING_CONFIG");
 const number=(key:string,fallback:number,min:number,max:number)=>{
  const n=raw[key]??fallback;
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error("INVALID_PROCESSING_CONFIG");return n;
 };
 const flag=(key:string)=>{const v=raw[key]??false;if(typeof v!=="boolean")throw new Error("INVALID_PROCESSING_CONFIG");return v;};
 const owners=raw.externalAllowedOwners??[],projections=raw.externalProjections??[];
 if(!Array.isArray(owners)||owners.length>100||!owners.every(v=>typeof v==="string"&&v.length>0&&v.length<=255)||
 !Array.isArray(projections)||projections.length>100)throw new Error("INVALID_PROCESSING_CONFIG");
 const externalProjectionPolicy=raw.externalProjectionPolicy??null;
 if(externalProjectionPolicy!==null&&externalProjectionPolicy!==EXTERNAL_PROJECTION_POLICY)throw new Error("INVALID_PROCESSING_CONFIG");
 const seen=new Set<string>();
 for(const p of projections){
  if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(k=>!["ownerId","inputHash","text","excludedFields","policyVersion"].includes(k))||
   !owners.includes(p.ownerId)||!/^[0-9a-f]{64}$/.test(p.inputHash)||typeof p.text!=="string"||!p.text.trim()||Buffer.byteLength(p.text)>8192||
   /\b(?:https?:\/\/|bearer\s|password\s*[:=]|api[_-]?key\s*[:=]|cookie\s*[:=])/iu.test(p.text)||
   !Array.isArray(p.excludedFields)||!p.excludedFields.every((x:unknown)=>typeof x==="string"&&x.length<=100)||
   typeof p.policyVersion!=="string"||!p.policyVersion||p.policyVersion.length>100)throw new Error("INVALID_PROCESSING_CONFIG");
  const key=JSON.stringify([p.ownerId,p.inputHash]);if(seen.has(key))throw new Error("INVALID_PROCESSING_CONFIG");seen.add(key);
 }
 const daily=(branch:string,owner:number,global:number)=>{
  const v=raw.dailyLimits?.[branch]??{owner,global};
  if(!Number.isSafeInteger(v.owner)||!Number.isSafeInteger(v.global)||v.owner<0||v.global<0||v.owner>100000||v.global>100000||v.owner>v.global)throw new Error("INVALID_PROCESSING_CONFIG");
  return {owner:v.owner,global:v.global};
 };
 const targetGeneration=raw.targetGeneration===undefined?GENERATION:raw.targetGeneration;if(typeof targetGeneration!=="string"||!generationPattern.test(targetGeneration))throw new Error("INVALID_PROCESSING_CONFIG");
 const cfg:ProcessingConfig={targetGeneration,enabled:flag("enabled"),embeddingEnabled:flag("embeddingEnabled"),classificationEnabled:flag("classificationEnabled"),
  externalProjectionPolicy,externalAllowedOwners:[...owners],externalProjections:projections.map(p=>({...p,excludedFields:[...p.excludedFields]})),
  deadlineMs:number("deadlineMs",30000,1000,30000),intervalMs:number("intervalMs",5000,1000,60000),
  heartbeatMs:number("heartbeatMs",5000,1000,10000),leaseMs:number("leaseMs",30000,10000,300000),
  intakeReserveBytes:number("intakeReserveBytes",67108864,16777216,1073741824),
  maxDerivativeBytes:number("maxDerivativeBytes",268435456,16777216,1073741824),
  dailyLimits:{embedding:daily("embedding",100,1000),classification:daily("classification",20,100)}};
 if(cfg.heartbeatMs*3>cfg.leaseMs)throw new Error("INVALID_PROCESSING_CONFIG");
 return cfg;
}

/** Применяет защищённую политику к проверенному immutable входу; точная ручная проекция имеет приоритет. */
export function approvedProjection(settings:ProcessingConfig,ownerId:string,inputHash:string,observation?:Observation) {
 if(!settings.classificationEnabled||!settings.externalAllowedOwners.includes(ownerId))return null;
 const p=settings.externalProjections.find(p=>p.ownerId===ownerId&&p.inputHash===inputHash);
 if(p)return {text:p.text,excluded_fields:[...p.excludedFields],policy_version:p.policyVersion};
 return settings.externalProjectionPolicy===EXTERNAL_PROJECTION_POLICY&&observation?prepareExternalProjection(observation,[ownerId]):null;
}

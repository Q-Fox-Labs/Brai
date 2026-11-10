// ABOUTME: Читает защищённые явные параметры экземпляра bug-hunt.
// ABOUTME: Не принимает настройки или credentials из предметного запроса.
import {readFileSync,lstatSync} from "node:fs";
import {isAbsolute} from "node:path";

export interface Config {
 databaseURL:string;installationId:string;cursorKey:string;
 nats:{servers:string[];user?:string;password?:string;credsFile?:string;inboxPrefix:string};
 mcp:{host:string;port:number;allowedHosts:string[];allowedOrigins:string[];principalsFile:string;maxConnections:number};
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
 return cfg;
}

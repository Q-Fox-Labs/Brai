// ABOUTME: Определяет границу ядра Каналов и его транзакционного хранилища.
// ABOUTME: Не импортирует SQL, NATS или внутренний код соседей.
export type Data=Record<string,any>;
export interface Caller { ownerIds:string[]; operations:string[]; sourceIds:string[]; replySourceIds:string[]; connectionIds:string[] | null; }
export interface Entity { id:string; ownerId:string; currentVersion:number; [key:string]:any; }
export interface Context { deadline:number; }
export interface Repository {
 lockKey(key:string):Promise<void>; now(previous?:string):Promise<string>; timestamp(value:string):Promise<string>; ready():Promise<void>;
 profile(type?:Data):Promise<Data|null>;
 connection(id:string,lock?:'read'|'write'):Promise<Entity|null>;
 connectionBySource(source:string):Promise<Entity|null>;
 channel(id:string,lock?:'read'|'write'):Promise<Entity|null>;
 channelByAddress(connectionId:string,address:Data):Promise<Entity|null>;
 version(kind:'connection'|'channel',id:string,version?:number,asOf?:string):Promise<Data|null>;
 insertIdentity(kind:'connection'|'channel',entity:Entity):Promise<void>;
 insertVersion(kind:'connection'|'channel',entity:Entity,value:Data):Promise<void>;
 receipt(callerId:string,ownerId:string,id:string):Promise<Data|null>;
 saveReceipt(callerId:string,receipt:Data):Promise<void>;
 resolution(callerId:string,ownerId:string,operationId:string):Promise<Data|null>;
 resolutionById(id:string):Promise<Data|null>;
 saveResolution(callerId:string,input:Data,hash:string,result:Data):Promise<void>;
 list(kind:'profile'|'connection'|'channel',ownerId:string|undefined,connectionIds:string[]|null,after:string|null,limit:number,filter?:string):Promise<Data[]>;
}
export interface Store { transaction<T>(context:Context,work:(repo:Repository)=>Promise<T>):Promise<T>; }
const codes:Record<string,number>={INVALID_ARGUMENT:400,FORBIDDEN:403,NOT_FOUND:404,CHANNEL_NOT_FOUND:404,AMBIGUOUS_CHANNEL:409,DISABLED:409,VERSION_CONFLICT:409,REQUEST_ID_CONFLICT:409,DESTINATION_CONFLICT:409,HISTORICAL_CONTEXT_UNAVAILABLE:409,INVALID_RULE_SET:422,UNSUPPORTED_PROFILE:422,REQUEST_TOO_LARGE:413,RESPONSE_TOO_LARGE:413,BUSY:503,NOT_READY:503};
export class Fault extends Error {
 readonly status:number; readonly retryable:boolean;
 constructor(public code:string){super(code);this.name='ChannelsFault';this.status=codes[code]??503;this.retryable=this.status===503;}
}

// ABOUTME: Определяет порты и ошибки самостоятельных Контактов.
// ABOUTME: Ядро не зависит от PostgreSQL, NATS или чужого runtime.
export type Data=Record<string,any>;
export interface Caller {ownerIds:string[];sourceIds:string[];operations:string[];}
export interface Context {deadline:number;}
export interface Repository {
 lock(key:string):Promise<void>; timestamp(value?:string):Promise<string>; ready():Promise<void>;
 operation(caller:string,owner:string,id:string):Promise<Data|null>;
 saveOperation(caller:string,op:string,q:Data,hash:string,result:Data,time:string):Promise<void>;
 identity(owner:string,external:string):Promise<Data|null>;
 createIdentity(value:Data,createdAt:string):Promise<void>; updateIdentity(value:Data):Promise<void>;
 contact(owner:string,id:string):Promise<Data|null>; list(owner:string,after:string|null,limit:number,external?:string):Promise<Data[]>;
}
export interface Store {transaction<T>(context:Context,work:(r:Repository)=>Promise<T>):Promise<T>;}
const codes:Record<string,number>={INVALID_REQUEST:400,UNSUPPORTED_NAMESPACE:400,FORBIDDEN:403,NOT_FOUND:404,REQUEST_ID_CONFLICT:409,INVALID_CURSOR:400,REQUEST_TOO_LARGE:413,RESULT_TOO_LARGE:413,BUSY:503,DATABASE_UNAVAILABLE:503,DEADLINE_EXCEEDED:504,INTERNAL:500};
export class Fault extends Error {
 readonly status:number;readonly retryable:boolean;
 constructor(public code:string){super(code);this.name='ContactsFault';this.status=codes[code]??500;this.retryable=['BUSY','DATABASE_UNAVAILABLE','DEADLINE_EXCEEDED'].includes(code);}
}

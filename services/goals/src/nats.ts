// ABOUTME: Подключает внутренний NATS Service для проверенного Web.
// ABOUTME: Личные данные запросов и ответов не попадают в журнал.
import { connect, type NatsConnection, type ServiceMsg } from "nats";
import { invoke, operations } from "./api.js";
import { GoalsFault, type createDomain } from "./domain.js";

const status: Record<string, number> = {INVALID_ARGUMENT:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,INTERNAL:500};
function parse(data: Uint8Array): Record<string,unknown> {
  if (data.byteLength > 131_072) throw new GoalsFault("INVALID_ARGUMENT");
  let result: unknown;
  try { result = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data)); }
  catch { throw new GoalsFault("INVALID_ARGUMENT"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new GoalsFault("INVALID_ARGUMENT");
  return result as Record<string,unknown>;
}
async function respond(msg: ServiceMsg, domain: ReturnType<typeof createDomain>): Promise<void> {
  try {
    const data = parse(msg.data);
    if (Object.keys(data).some(key => !["user_id","operation","input"].includes(key)) ||
        typeof data.user_id !== "string" || !data.user_id.trim() ||
        typeof data.operation !== "string" || !operations.includes(data.operation)) throw new GoalsFault("INVALID_ARGUMENT");
    const result = await invoke(domain,data.user_id,"web",data.operation,data.input);
    const bytes = Buffer.from(JSON.stringify(result));
    if (bytes.length > 1_048_576) throw new GoalsFault("INTERNAL");
    msg.respond(bytes);
  } catch (error) {
    const code = error instanceof GoalsFault ? error.code : "INTERNAL";
    msg.respondError(status[code] ?? 500,code,Buffer.from(JSON.stringify({code,message:code,retryable:false})));
  }
}

/** Подключает сервис к операторски настроенному NATS с ACL. */
export async function startNats(domain: ReturnType<typeof createDomain>, config: {servers:string[];user:string;password:string;inbox:string}) {
  const nc: NatsConnection = await connect({servers:config.servers,user:config.user,pass:config.password,inboxPrefix:config.inbox,name:"service_goals",maxReconnectAttempts:-1});
  try {
    const service = await nc.services.add({name:"service_goals",version:"0.1.0",description:"Brai goals",queue:"service_goals"});
    service.addEndpoint("request",{subject:"brai.goals.v1.request",queue:"service_goals",handler:(error,msg) => {if (!error) void respond(msg,domain);}});
    return {async close() {await service.stop();await nc.close();}};
  } catch (error) {await nc.close();throw error;}
}

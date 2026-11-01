// ABOUTME: Обращается к сервису целей только с владельцем проверенной сессии.
// ABOUTME: Не повторяет команды при неизвестном результате.
import { GatewayError, natsConnection } from "./gateway";

const allowed = new Set(["goals_overview","goals_list","goals_get","goals_history","goals_restore","goals_delete","goals_goal_put","goals_focus_put","goals_entry_put","goals_resource_put","goals_need_put","goals_allocation_put"]);
const statuses: Record<string,number> = {INVALID_ARGUMENT:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,INTERNAL:500};
function object(value: unknown): value is Record<string,unknown> {return !!value && typeof value === "object" && !Array.isArray(value);}

/** Передаёт фиксированную операцию; личность задаётся только сервером. */
export async function goalsRequest(owner: string, operation: string, input: unknown): Promise<unknown> {
  if (!allowed.has(operation) || !object(input)) throw new GatewayError(400,"INVALID_ARGUMENT","not-published");
  const mutation = operation.endsWith("_put") || operation === "goals_restore" || operation === "goals_delete";
  const args = mutation ? {...input,source:"Ручное изменение в интерфейсе Brai"} : input;
  let nc;
  try {nc = await natsConnection();} catch {throw new GatewayError(503,"UNAVAILABLE","not-published");}
  if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503,"UNAVAILABLE","not-published");
  let reply;
  try {reply = await nc.request("brai.goals.v1.request",Buffer.from(JSON.stringify({user_id:owner,operation,input:args})),{timeout:10_000});}
  catch {throw new GatewayError(503,mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE",mutation ? "unknown" : "query");}
  if (reply.data.byteLength > 1_048_576) throw new GatewayError(502,"BAD_REPLY",mutation ? "unknown" : "query");
  let result: unknown;
  try {result = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(reply.data));}
  catch {throw new GatewayError(502,"BAD_REPLY",mutation ? "unknown" : "query");}
  if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) {
    if (!object(result) || typeof result.code !== "string") throw new GatewayError(502,"BAD_REPLY",mutation ? "unknown" : "query");
    const status = statuses[result.code];
    if (!status || reply.headers.get("Nats-Service-Error") !== result.code || reply.headers.get("Nats-Service-Error-Code") !== String(status)) throw new GatewayError(502,"BAD_REPLY",mutation ? "unknown" : "query");
    throw new GatewayError(status,result.code,mutation && status >= 500 ? "unknown" : "query");
  }
  if (!object(result)) throw new GatewayError(502,"BAD_REPLY",mutation ? "unknown" : "query");
  return result;
}

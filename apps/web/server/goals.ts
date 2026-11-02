// ABOUTME: Читает сервис целей только с владельцем проверенной web-сессии.
// ABOUTME: Вебу разрешены только обзор и история; изменение выполняется через MCP.
import { GatewayError, natsConnection } from "./gateway";

const allowed = new Set(["goals_overview","goals_history"]);
const statuses: Record<string,number> = {INVALID_ARGUMENT:400,NOT_FOUND:404,CONFLICT:409,FORBIDDEN:403,INTERNAL:500};
function object(value: unknown): value is Record<string,unknown> {return !!value && typeof value === "object" && !Array.isArray(value);}

/** Передаёт только операцию чтения; личность задаётся сервером. */
export async function goalsRequest(owner: string, operation: string, input: unknown): Promise<unknown> {
  if (!allowed.has(operation) || !object(input)) throw new GatewayError(400,"INVALID_ARGUMENT","not-published");
  let nc;
  try {nc = await natsConnection();} catch {throw new GatewayError(503,"UNAVAILABLE","not-published");}
  if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503,"UNAVAILABLE","not-published");
  let reply;
  try {reply = await nc.request("brai.goals.v1.request",Buffer.from(JSON.stringify({user_id:owner,operation,input})),{timeout:10_000});}
  catch {throw new GatewayError(503,"UNAVAILABLE","query");}
  if (reply.data.byteLength > 1_048_576) throw new GatewayError(502,"BAD_REPLY","query");
  let result: unknown;
  try {result = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(reply.data));}
  catch {throw new GatewayError(502,"BAD_REPLY","query");}
  if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) {
    if (!object(result) || typeof result.code !== "string") throw new GatewayError(502,"BAD_REPLY","query");
    const status = statuses[result.code];
    if (!status || reply.headers.get("Nats-Service-Error") !== result.code || reply.headers.get("Nats-Service-Error-Code") !== String(status)) throw new GatewayError(502,"BAD_REPLY","query");
    throw new GatewayError(status,result.code,"query");
  }
  if (!object(result)) throw new GatewayError(502,"BAD_REPLY","query");
  return result;
}

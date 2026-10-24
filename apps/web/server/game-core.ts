// ABOUTME: Читает каноническую карту GameCore через NATS Services.
// ABOUTME: Браузер не задаёт владельца и получает только BoardData владельца сессии.
import { GatewayError, natsConnection } from "./gateway";
import type { BoardData } from "../app/game-core/model";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses: Record<string, number> = { INVALID_ARGUMENT: 400, NOT_FOUND: 404, CONFLICT: 409, INVALID_STATE: 409, RESULT_INVALID: 422, FORBIDDEN: 403, BUSY: 503, DATABASE_UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, INTERNAL: 500 };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function boardData(value: unknown): value is BoardData {
 if (!object(value) || !Array.isArray(value.elements) || !Array.isArray(value.moves) || !Array.isArray(value.resources)) return false;
 const elementIds = new Set<string>();
 for (const element of value.elements) {
  if (!object(element) || typeof element.id !== "string" || !uuid.test(element.id) || elementIds.has(element.id) ||
      !(element.parentId === null || typeof element.parentId === "string" && uuid.test(element.parentId)) ||
      typeof element.revision !== "string" || typeof element.kind !== "string" || typeof element.status !== "string" ||
      typeof element.title !== "string" || typeof element.description !== "string" || !strings(element.input) || !strings(element.output)) return false;
  elementIds.add(element.id);
 }
 if (value.elements.some((element: BoardData["elements"][number]) => element.parentId && !elementIds.has(element.parentId))) return false;
 const moveIds = new Set<string>();
 for (const move of value.moves) {
  if (!object(move) || typeof move.id !== "string" || !uuid.test(move.id) || typeof move.ownerId !== "string" || !uuid.test(move.ownerId) || !elementIds.has(move.ownerId) ||
      typeof move.targetId !== "string" || !uuid.test(move.targetId) || typeof move.title !== "string" || typeof move.kind !== "string" || typeof move.status !== "string" ||
      !(move.previousId === null || typeof move.previousId === "string" && uuid.test(move.previousId)) || typeof move.attemptId !== "string" || typeof move.executor !== "string" ||
      !elementIds.has(move.targetId) || !strings(move.input) || !strings(move.output) || move.attempts !== undefined && (!Array.isArray(move.attempts) || move.attempts.some((attempt: unknown) => !object(attempt) || typeof attempt.id !== "string" || typeof attempt.status !== "string"))) return false;
  if (moveIds.has(move.id)) return false;
  moveIds.add(move.id);
 }
 if (value.moves.some((move: BoardData["moves"][number]) => move.previousId && !moveIds.has(move.previousId))) return false;
 if (value.attempts !== undefined && (!Array.isArray(value.attempts) || value.attempts.some((attempt: unknown) => !object(attempt) || typeof attempt.id !== "string" || typeof attempt.status !== "string"))) return false;
 return value.resources.every((resource: unknown) => object(resource) && typeof resource.id === "string" && (resource.attemptId === null || typeof resource.attemptId === "string") && typeof resource.title === "string" && typeof resource.content === "string");
}

/** Передаёт только известный subject и owner-контекст через существующее соединение web. */
async function requestValue(subject: string, request: unknown): Promise<unknown> {
 let reply;
 try {
  const nc = await natsConnection();
  if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503, "UNAVAILABLE");
  reply = await nc.request(subject, Buffer.from(JSON.stringify(request)), { timeout: 10_000 });
 } catch (error) {
  if (error instanceof GatewayError) throw error;
  throw new GatewayError((error as { code?: string })?.code === "TIMEOUT" ? 504 : 503, "UNAVAILABLE");
 }
 if (reply.data.byteLength > 524_288) throw new GatewayError(502, "BAD_REPLY");
 let value: unknown;
 try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.data)); }
 catch { throw new GatewayError(502, "BAD_REPLY"); }
 if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) {
  if (!object(value) || typeof value.code !== "string") throw new GatewayError(502, "BAD_REPLY");
  const status = statuses[value.code];
  if (!status || reply.headers.get("Nats-Service-Error") !== value.code || reply.headers.get("Nats-Service-Error-Code") !== String(status)) throw new GatewayError(502, "BAD_REPLY");
  throw new GatewayError(status, value.code);
 }
 return value;
}

/** Включает ручные команды только в явно настроенном DEV контуре. */
export function manualStatusEnabled(): boolean {
 return process.env.BRAI_ENVIRONMENT === "dev" && process.env.GAME_CORE_DEV_STATUS_ENABLED === "true";
}

type FileArtifact = { artifactId: string; ownerId: string; filename: string; status: string; internalUrl?: string };
async function artifactForOwner(userId: string, id: string): Promise<FileArtifact> {
 if (!uuid.test(id)) throw new GatewayError(404, "NOT_FOUND");
 const value = await requestValue("brai.artifacts.v1.get", { artifactId: id });
 if (!object(value) || value.artifactId !== id || value.ownerId !== userId || typeof value.filename !== "string" || typeof value.status !== "string") throw new GatewayError(404, "NOT_FOUND");
 return value as FileArtifact;
}

/** Загружает только граф владельца; имена файлов разрешает через контракт Artifacts. */
export async function loadGameCoreBoard(userId: string): Promise<BoardData> {
 const value = await requestValue("brai.game-core.v1.query.graph", { user_id: userId });
 if (!boardData(value)) throw new GatewayError(502, "BAD_REPLY");
 const resources = value.resources as (BoardData["resources"][number] & {artifactIds?: string[]; artifacts?: {id:string;name:string;available:boolean}[]})[];
 for (const resource of resources) {
  if (!resource.artifactIds?.length) continue;
  resource.artifacts = [];
  for (const id of resource.artifactIds) {
   try { const a = await artifactForOwner(userId, id); resource.artifacts.push({id,name:a.filename,available:a.status==="ready"}); }
   catch (error) { if (error instanceof GatewayError && error.status === 404) resource.artifacts.push({id,name:"Файл недоступен",available:false}); else throw error; }
  }
 }
 const available=await requestValue('brai.game-core.v1.query.moves',{user_id:userId}) as {items:{id:string;required_resource_ids:string[]}[]};
 for (const move of value.moves) move.requiredResourceIds=available.items.find(item=>item.id===move.id)?.required_resource_ids??move.requiredResourceIds;
 return Object.assign(value, { manualStatusEnabled: manualStatusEnabled(),readyMoveIds:available.items.map(m=>m.id) });
}

/** Меняет один DEV статус; сервис проверяет владельца и записывает атомарный аудит. */
export async function changeElementStatus(userId: string, value: unknown): Promise<BoardData> {
 if (!manualStatusEnabled()) throw new GatewayError(403, "FORBIDDEN");
 if (!object(value) || Object.keys(value).sort().join(",") !== "id,kind,request_id,status" ||
     typeof value.id !== "string" || !uuid.test(value.id) || typeof value.request_id !== "string" || !uuid.test(value.request_id) ||
     !["element","move"].includes(String(value.kind)) || typeof value.status !== "string") throw new GatewayError(400,"INVALID_ARGUMENT");
 const allowed = value.kind === "element" ? ["draft","active","completed","cancelled"] : ["planned","claimed","succeeded","cancelled"];
 if (!allowed.includes(value.status)) throw new GatewayError(400,"INVALID_ARGUMENT");
 await requestValue("brai.game-core.v1.command.dev-status", { ...value, user_id: userId });
 return loadGameCoreBoard(userId);
}

/** Выдаёт байты лишь файла, связанного с ресурсом текущего владельца; URL Artifacts остаётся на сервере. */
export async function readElementArtifact(userId: string, id: string, signal: AbortSignal): Promise<Response> {
 const graph = await requestValue("brai.game-core.v1.query.graph", { user_id: userId });
 if (!boardData(graph)) throw new GatewayError(502,"BAD_REPLY");
 if (!graph.resources.some(resource => (resource as {artifactIds?:string[]}).artifactIds?.includes(id))) throw new GatewayError(404,"NOT_FOUND");
 const artifact = await artifactForOwner(userId,id);
 if (artifact.status !== "ready" || !artifact.internalUrl) throw new GatewayError(404,"NOT_FOUND");
 const origin = process.env.GAME_CORE_ARTIFACTS_INTERNAL_ORIGIN;
 if (!origin) throw new GatewayError(503,"UNAVAILABLE");
 const url = new URL(artifact.internalUrl);
 if (url.origin !== origin || url.username || url.password || url.search || url.hash || !/^\/files\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new GatewayError(502,"BAD_REPLY");
 const upstream = await fetch(url, {cache:"no-store",redirect:"error",signal});
 if (!upstream.ok || !upstream.body) throw new GatewayError(404,"NOT_FOUND");
 const filename = encodeURIComponent(artifact.filename).replace(/['()*]/g, char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
 return new Response(upstream.body,{headers:{"Cache-Control":"no-store","Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename="download"; filename*=UTF-8''${filename}`,"X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"}});
}

/** Создаёт только исходный черновик и существующую Операцию; готовый план не подставляется. */
export async function createTaskDraft(userId:string,value:unknown):Promise<BoardData> {
 if(!object(value)||Object.keys(value).some(k=>!['title','request','request_id'].includes(k))||typeof value.title!=='string'||!value.title.trim()||value.title.length>1000||typeof value.request!=='string'||!value.request.trim()||value.request.length>16000||typeof value.request_id!=='string'||!uuid.test(value.request_id))throw new GatewayError(400,'INVALID_ARGUMENT');
 const {createHash}=await import('node:crypto');
 const stable=(label:string)=>{const h=createHash('sha256').update(`${userId}:${value.request_id}:${label}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
 const id=stable('task'),move=stable('plan'),resource=stable('input');
 const graph=await loadGameCoreBoard(userId);
 const existing=graph.elements.find(e=>e.id===id);
 if(existing){if(existing.title!==value.title||!graph.resources.some(r=>r.id===resource&&r.content===value.request))throw new GatewayError(409,'CONFLICT');return graph;}
 await requestValue('brai.game-core.v1.command.create',{user_id:userId,elements:[{id,kind:'task',title:value.title,initial_resources:[{id:resource,title:'Поручение Игрока',content:value.request}]}],moves:[{id:move,element_id:id,kind:'operation',purpose:'plan',title:'Поставить Задачу',instructions:'Прочитать пакет входов и правил. Зафиксировать независимые критерии, собрать предметный план и пройти проверку. Решение Игрока сохраняется отдельно.'}]});
 return loadGameCoreBoard(userId);
}

/** Запускает существующую постановку либо сохраняет реальный результат Action проверенного владельца. */
export async function performElementWorkflow(userId:string,sessionId:string,value:unknown):Promise<BoardData> {
 if(!object(value)||Object.keys(value).some(k=>!['operation','move_id','revision_id','request_id','decision','comment','values'].includes(k))||!['start','action'].includes(String(value.operation))||typeof value.move_id!=='string'||!uuid.test(value.move_id)||typeof value.revision_id!=='string'||!uuid.test(value.revision_id)||typeof value.request_id!=='string'||!uuid.test(value.request_id))throw new GatewayError(400,'INVALID_ARGUMENT');
 const graph=await loadGameCoreBoard(userId),move=graph.moves.find(m=>m.id===value.move_id),target=graph.elements.find(e=>e.id===move?.targetId);
 if(!move||!target)throw new GatewayError(404,'NOT_FOUND');
 if(target.revision!==value.revision_id)throw new GatewayError(409,'CONFLICT');
 const available=await requestValue('brai.game-core.v1.query.moves',{user_id:userId}) as {items:{id:string;required_resource_ids:string[]}[]};
 if(value.operation==='start'){
  if(move.kind!=='operation'||!['plan','start'].includes(move.purpose??''))throw new GatewayError(403,'FORBIDDEN');
  if(move.status==='claimed')return graph;
  await requestValue('brai.game-core.v1.command.claim',{user_id:userId,move_id:move.id,idempotency_key:`planning:${move.id}:${target.revision}`,executor_kind:'agent',input_resource_ids:[...new Set([...(available.items.find(m=>m.id===move.id)?.required_resource_ids??[]),...target.input])]});
  return loadGameCoreBoard(userId);
 }
 const planning=(move.fields as {planning?:{decision?:string;output_contracts:{key:string;name:string}[]}})?.planning;
 if(move.kind!=='action'||!planning)throw new GatewayError(403,'FORBIDDEN');
 const stage=planning.decision==='confirm'?'planning':planning.decision==='final'?'final':null;
 const allowed=stage==='planning'?['approved','changes','cancelled']:stage==='final'?['success','changes','cancelled']:['done'];
 if(!allowed.includes(String(value.decision))||typeof value.comment!=='string'||value.comment.length>16000||stage&&!value.comment.trim()||!object(value.values))throw new GatewayError(400,'INVALID_ARGUMENT');
 const resources=planning.output_contracts.map((contract,index)=>{
  const decision=stage&&index===planning.output_contracts.length-1;
  const content=decision?value.comment:(value.values as Record<string,unknown>)[contract.key];
  if(typeof content!=='string'||!content.trim()||content.length>16000)throw new GatewayError(400,'RESULT_REQUIRED');
  return {output_key:contract.key,title:contract.name,content,metadata:decision?{element_id:target.id,revision_id:target.revision,stage:value.decision==='changes'?'review':stage,outcome:value.decision,channel:'web',session_id:sessionId}:{}};
 });
 if(move.status==='succeeded')return graph;
 let attemptId=move.attemptId;
 if(move.status==='claimed'){
  if(move.executor!=='human'||!graph.attempts?.some(a=>a.id===attemptId&&a.status==='running'))throw new GatewayError(409,'INVALID_STATE');
 }else{
  const required=available.items.find(m=>m.id===move.id)?.required_resource_ids;
  if(!required)throw new GatewayError(409,'INVALID_STATE');
  const claim=await requestValue('brai.game-core.v1.command.claim',{user_id:userId,move_id:move.id,idempotency_key:`web:${sessionId}:${value.request_id}`,executor_kind:'human',input_resource_ids:required}) as {attempt:{id:string}};
  attemptId=claim.attempt.id;
 }
 await requestValue('brai.game-core.v1.command.complete',{user_id:userId,attempt_id:attemptId,result:{resources}});
 return loadGameCoreBoard(userId);
}

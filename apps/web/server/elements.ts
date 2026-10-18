// ABOUTME: Читает каноническую карту Elements через NATS Services.
// ABOUTME: Браузер не задаёт владельца и получает только BoardData владельца сессии.
import { GatewayError, natsConnection } from "./gateway";
import type { BoardData } from "../app/elements/model";

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

/** Запрашивает граф текущего пользователя по обязательному контракту game-core. */
export async function loadElementsBoard(userId: string): Promise<BoardData> {
 const request = { user_id: userId };
 let reply;
 try {
  const nc = await natsConnection();
  if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503, "UNAVAILABLE");
  reply = await nc.request("brai.elements.v1.query.graph", Buffer.from(JSON.stringify(request)), { timeout: 10_000 });
 } catch (error) {
  if (error instanceof GatewayError) throw error;
  const timeout = (error as { code?: string })?.code === "TIMEOUT";
  throw new GatewayError(timeout ? 504 : 503, timeout ? "DEADLINE_EXCEEDED" : "UNAVAILABLE");
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
 if (!boardData(value)) throw new GatewayError(502, "BAD_REPLY");
 return value;
}

// ABOUTME: Определяет DTO, лимиты и проверку входов сервиса элементов.
// ABOUTME: Схемы транспорта не зависят от PostgreSQL и прикладных адаптеров.
import AjvImport, { type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";

const Ajv = AjvImport as unknown as typeof AjvImport.default;
const addFormats = addFormatsImport as unknown as typeof addFormatsImport.default;

export const limits = Object.freeze({ maxRequestBytes: 65_536, maxResponseBytes: 524_288, active: 8, queue: 64, deadlineMs: 10_000, maxPageSize: 100 });
export const subjects = Object.freeze({ graph: "brai.elements.v1.query.graph", timeline: "brai.elements.v1.query.timeline", element: "brai.elements.v1.query.element", moves: "brai.elements.v1.query.moves", create: "brai.elements.v1.command.create", revise: "brai.elements.v1.command.revise", claim: "brai.elements.v1.command.claim", complete: "brai.elements.v1.command.complete", activate: "brai.elements.v1.command.activate", events: "brai.elements.v1.events.>" });
export const errorStatus: Record<ErrorCode, number> = { INVALID_ARGUMENT: 400, NOT_FOUND: 404, CONFLICT: 409, INVALID_STATE: 409, RESULT_INVALID: 422, FORBIDDEN: 403, BUSY: 503, DATABASE_UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, INTERNAL: 500 };

export type ElementKind = "level" | "mission" | "quest" | "goal" | "task";
export type ElementStatus = "draft" | "active" | "completed";
export type MoveKind = "action" | "operation";
export type MoveStatus = "planned" | "claimed" | "succeeded";
export type LinkRole = "launch" | "input" | "output" | "accept";
export type ExecutorKind = "human" | "agent" | "system";
export type AttemptStatus = "running" | "succeeded" | "failed";
export type ErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "RESULT_INVALID" | "FORBIDDEN" | "BUSY" | "DATABASE_UNAVAILABLE" | "DEADLINE_EXCEEDED" | "INTERNAL";
export interface ElementRevision { id: string; element_id: string; revision: number; title: string; description: string; result_spec: Record<string, unknown>; created_by: string; created_at: string }
export interface Element { id: string; owner_id: string; kind: ElementKind; parent_id: string | null; status: ElementStatus; current_revision: ElementRevision; child_count?: number }
export interface Move { id: string; owner_id: string; kind: MoveKind; title: string; instructions: string; result_schema: Record<string, unknown>; status: MoveStatus; created_at: string }
export interface MoveLink { move_id: string; element_id: string; revision_id: string; role: LinkRole; required: boolean; position: number }
export interface MoveAttempt { id: string; move_id: string; executor_kind: ExecutorKind; executor_id: string | null; status: AttemptStatus; input: Record<string, unknown>; result: unknown; error_code: string | null; started_at: string; finished_at: string | null }
export interface OperationContext { deadlineAt: number; signal: AbortSignal; actorId?: string | null }
export interface Page<T> { items: T[]; next_cursor: string | null }
export interface Graph { elements: Element[]; moves: Move[]; links: MoveLink[] }
export interface TimelineItem { attempt: MoveAttempt; move: Move; element_ids: string[] }
export interface EventEnvelope { event_id: string; event_version: 1; event_type: string; occurred_at: string; owner_id: string; actor: { kind: ExecutorKind; id?: string | null }; aggregate: { kind: "element" | "move" | "attempt"; id: string }; data: Record<string, unknown>; notification?: { type_code: string; title: string; text: string; data?: Record<string, unknown> } }

const uuid = { type: "string", format: "uuid" };
const idString = { type: "string", minLength: 1, maxLength: 255 };
const schema = { $schema: "http://json-schema.org/draft-07/schema#", $id: "https://brai.app/schemas/elements/messages.schema.json", definitions: {
  owner: idString, elementId: uuid, elementKind: { enum: ["level", "mission", "quest", "goal", "task"] }, moveKind: { enum: ["action", "operation"] }, linkRole: { enum: ["launch", "input", "output", "accept"] }, executorKind: { enum: ["human", "agent", "system"] }, page: { type: "integer", minimum: 1, maximum: 100 },
  graphRequest: { type: "object", additionalProperties: false, properties: { user_id: idString, root_id: uuid, depth: { type: "integer", minimum: 0, maximum: 20 } }, required: ["user_id"] },
  timelineRequest: { type: "object", additionalProperties: false, properties: { user_id: idString, element_id: uuid, limit: { $ref: "#/definitions/page" }, cursor: { type: "string", maxLength: 2048 } }, required: ["user_id"] },
  elementRequest: { type: "object", additionalProperties: false, properties: { user_id: idString, element_id: uuid }, required: ["user_id", "element_id"] },
  movesRequest: { type: "object", additionalProperties: false, properties: { user_id: idString, element_id: uuid, limit: { $ref: "#/definitions/page" } }, required: ["user_id"] },
  createElement: { type: "object", additionalProperties: false, properties: { user_id: idString, id: uuid, kind: { $ref: "#/definitions/elementKind" }, parent_id: { anyOf: [uuid, { type: "null" }] }, title: { type: "string", minLength: 1, maxLength: 256 }, description: { type: "string", maxLength: 8192 }, result_spec: { type: "object" } }, required: ["user_id", "kind", "title", "description", "result_spec"] },
  revise: { type: "object", additionalProperties: false, properties: { user_id: idString, element_id: uuid, title: { type: "string", minLength: 1, maxLength: 256 }, description: { type: "string", maxLength: 8192 }, result_spec: { type: "object" } }, required: ["user_id", "element_id", "title", "description", "result_spec"] },
  createMove: { type: "object", additionalProperties: false, properties: { user_id: idString, id: uuid, kind: { $ref: "#/definitions/moveKind" }, title: { type: "string", minLength: 1, maxLength: 256 }, instructions: { type: "string", maxLength: 8192 }, result_schema: { type: "object" } }, required: ["user_id", "kind", "title", "instructions", "result_schema"] },
  link: { type: "object", additionalProperties: false, properties: { user_id: idString, move_id: uuid, element_id: uuid, revision_id: uuid, role: { $ref: "#/definitions/linkRole" }, required: { type: "boolean" }, position: { type: "integer", minimum: 0 } }, required: ["user_id", "move_id", "element_id", "role"] },
  activate: { type: "object", additionalProperties: false, properties: { user_id: idString, element_id: uuid }, required: ["user_id", "element_id"] },
  claim: { type: "object", additionalProperties: false, properties: { user_id: idString, move_id: uuid, attempt_id: uuid, idempotency_key: idString, executor_kind: { $ref: "#/definitions/executorKind" }, executor_id: { anyOf: [idString, { type: "null" }] }, input: { type: "object" } }, required: ["user_id", "move_id", "idempotency_key", "executor_kind", "input"] },
  complete: { type: "object", additionalProperties: false, properties: { user_id: idString, attempt_id: uuid, result: {} }, required: ["user_id", "attempt_id", "result"] },
  fail: { type: "object", additionalProperties: false, properties: { user_id: idString, attempt_id: uuid, error_code: { type: "string", minLength: 1, maxLength: 128 } }, required: ["user_id", "attempt_id", "error_code"] },
  error: { type: "object", additionalProperties: false, properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } }, required: ["code", "message", "retryable"] },
} };
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema(schema);
const validators: Record<string, ValidateFunction> = Object.fromEntries(Object.keys(schema.definitions).map(name => [name, ajv.compile({ $ref: `${schema.$id}#/definitions/${name}` })]));
const names: Record<string, string> = { graph: "graphRequest", timeline: "timelineRequest", element: "elementRequest", moves: "movesRequest", create: "createElement", revise: "revise", move: "createMove", link: "link", activate: "activate", claim: "claim", complete: "complete", fail: "fail" };
export function validate(name: string, value: unknown): boolean { return !!validators[names[name] ?? name]?.(value); }
export function validateSchema(value: unknown): value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return false; try { ajv.compile(value); return true; } catch { return false; } }
export function validateResult(schemaValue: Record<string, unknown>, result: unknown): boolean { try { return !!ajv.compile(schemaValue)(result); } catch { return false; } }
export function parseJson(data: Uint8Array): unknown { if (data.byteLength > limits.maxRequestBytes) throw new Error("REQUEST_TOO_LARGE"); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }

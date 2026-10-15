// ABOUTME: Реализует прикладные правила Elements, Moves и попыток выполнения.
// ABOUTME: Ядро получает транзакционное хранилище портом и не знает PostgreSQL, NATS или MCP.
import { randomUUID } from "node:crypto";
import { limits, validate, validateResult, validateSchema, type Element, type ElementKind, type ElementRevision, type ElementStatus, type EventEnvelope, type ExecutorKind, type Graph, type LinkRole, type Move, type MoveAttempt, type MoveKind, type MoveLink, type OperationContext, type Page, type TimelineItem } from "./contracts.js";

export class ElementsFault extends Error {
  readonly retryable: boolean;
  constructor(readonly code: import("./contracts.js").ErrorCode) { super(code); this.name = "ElementsFault"; this.retryable = ["BUSY", "DATABASE_UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(code); }
}
export interface ElementDraft { id?: string; kind: ElementKind; parent_id: string | null; title: string; description: string; result_spec: Record<string, unknown> }
export interface MoveDraft { id?: string; kind: MoveKind; title: string; instructions: string; result_schema: Record<string, unknown> }
export interface LinkDraft { move_id: string; element_id: string; revision_id?: string; role: LinkRole; required?: boolean; position?: number }
export interface StructureDraft { elements: Array<ElementDraft & { id: string }>; moves: Array<MoveDraft & { id: string }>; links: LinkDraft[] }
export interface ElementsTransaction {
  createElement(input: ElementDraft, actorId: string | null): Promise<Element>;
  reviseElement(input: { element_id: string; title: string; description: string; result_spec: Record<string, unknown> }, actorId: string | null): Promise<Element>;
  createMove(input: MoveDraft): Promise<Move>;
  linkMove(input: LinkDraft): Promise<MoveLink>;
  activateElement(elementId: string, actorId: string | null): Promise<Element>;
  claimMove(input: { move_id: string; attempt_id: string; idempotency_key: string; executor_kind: ExecutorKind; executor_id: string | null; input: Record<string, unknown> }, actorId: string | null): Promise<{ attempt: MoveAttempt; move: Move }>;
  completeAttempt(attemptId: string, result: unknown, actorId: string | null): Promise<{ attempt: MoveAttempt; move: Move; completed_elements: string[] }>;
  failAttempt(attemptId: string, errorCode: string, actorId: string | null): Promise<MoveAttempt>;
  createStructure(input: StructureDraft, actorId: string | null): Promise<{ elements: Element[]; moves: Move[]; links: MoveLink[] }>;
}
export interface ElementsStore {
  transaction<T>(ownerId: string, context: OperationContext | undefined, run: (tx: ElementsTransaction) => Promise<T>): Promise<T>;
  element(ownerId: string, id: string, context?: OperationContext): Promise<Element | null>;
  graph(ownerId: string, rootId: string | null, depth: number, context?: OperationContext): Promise<Graph>;
  availableMoves(ownerId: string, elementId: string | null, context?: OperationContext): Promise<Move[]>;
  timeline(ownerId: string, elementId: string | null, limit: number, cursor: string | null, context?: OperationContext): Promise<Page<TimelineItem>>;
  pendingOutbox(limit: number): Promise<Array<{ id: string; subject: string; payload: EventEnvelope }>>;
  markOutboxPublished(id: string): Promise<void>;
  ready(): Promise<void>;
}
export interface ElementsHandlers {
  structureCreate(value: unknown, context?: OperationContext): Promise<unknown>;
  elementCreate(value: unknown, context?: OperationContext): Promise<Element>;
  elementRevise(value: unknown, context?: OperationContext): Promise<Element>;
  elementGet(value: unknown, context?: OperationContext): Promise<Element>;
  moveCreate(value: unknown, context?: OperationContext): Promise<Move>;
  moveLink(value: unknown, context?: OperationContext): Promise<MoveLink>;
  elementActivate(value: unknown, context?: OperationContext): Promise<Element>;
  graphGet(value: unknown, context?: OperationContext): Promise<Graph>;
  timelineGet(value: unknown, context?: OperationContext): Promise<Page<TimelineItem>>;
  movesAvailable(value: unknown, context?: OperationContext): Promise<{ items: Move[] }>;
  moveClaim(value: unknown, context?: OperationContext): Promise<unknown>;
  moveComplete(value: unknown, context?: OperationContext): Promise<unknown>;
  moveFail(value: unknown, context?: OperationContext): Promise<unknown>;
  ready(): Promise<void>;
}

const parentKind: Record<ElementKind, ElementKind | null> = { level: null, mission: "level", quest: "mission", goal: "quest", task: "goal" };
const childKind: Record<ElementKind, ElementKind | null> = { level: "mission", mission: "quest", quest: "goal", goal: "task", task: null };
const now = () => new Date().toISOString();
function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ElementsFault("INVALID_ARGUMENT"); return value as Record<string, any>; }
function copy(value: unknown): any { try { return JSON.parse(JSON.stringify(value)); } catch { throw new ElementsFault("INVALID_ARGUMENT"); } }
function input(operation: string, value: unknown): Record<string, any> { if (!validate(operation, value)) throw new ElementsFault("INVALID_ARGUMENT"); return copy(value); }
function checkContext(context?: OperationContext): void { if (context && (context.signal.aborted || performance.now() >= context.deadlineAt)) throw new ElementsFault("DEADLINE_EXCEEDED"); }
function response<T>(value: T): T { if (Buffer.byteLength(JSON.stringify(value), "utf8") > limits.maxResponseBytes) throw new ElementsFault("INTERNAL"); return value; }
function event(ownerId: string, actorKind: ExecutorKind, actorId: string | null, eventType: string, aggregate: EventEnvelope["aggregate"], data: Record<string, unknown>): EventEnvelope { return { event_id: randomUUID(), event_version: 1, event_type: eventType, occurred_at: now(), owner_id: ownerId, actor: { kind: actorKind, id: actorId }, aggregate, data }; }
export function hierarchyParent(kind: ElementKind): ElementKind | null { return parentKind[kind]; }
export function hierarchyChild(kind: ElementKind): ElementKind | null { return childKind[kind]; }
export function validateElementDraft(draft: ElementDraft): void { if (draft.parent_id === null && draft.kind !== "level") throw new ElementsFault("INVALID_ARGUMENT"); if (draft.kind === "task" && draft.parent_id === null) throw new ElementsFault("INVALID_ARGUMENT"); if (!validateSchema(draft.result_spec)) throw new ElementsFault("INVALID_ARGUMENT"); }
export function validateMoveDraft(draft: MoveDraft): void { if (!validateSchema(draft.result_schema)) throw new ElementsFault("INVALID_ARGUMENT"); }
export function validateLink(move: Move, element: Element, link: LinkDraft): void {
  if (link.role === "accept" || link.role === "launch") { if (move.kind !== "operation") throw new ElementsFault("INVALID_ARGUMENT"); }
  if (link.revision_id && link.revision_id !== element.current_revision.id) throw new ElementsFault("CONFLICT");
}
export function canActivate(kind: ElementKind, childCount: number, accepts: number): void { if (kind !== "task" && (childCount < 2 || childCount > 6)) throw new ElementsFault("INVALID_STATE"); if (accepts !== 1) throw new ElementsFault("INVALID_STATE"); }
export function createElementsHandlers(store: ElementsStore): ElementsHandlers {
  async function run(ownerId: string, context: OperationContext | undefined, fn: (tx: ElementsTransaction) => Promise<any>): Promise<any> { checkContext(context); return store.transaction(ownerId, context, async tx => { checkContext(context); const result = await fn(tx); checkContext(context); return result; }); }
  return {
    ready: () => store.ready(),
    async structureCreate(value, context) {
      const raw = object(value); const ownerId = raw.user_id; if (typeof ownerId !== "string" || !ownerId || ownerId.length > 255 || !Array.isArray(raw.elements) || !Array.isArray(raw.moves) || !Array.isArray(raw.links) || raw.elements.length === 0) throw new ElementsFault("INVALID_ARGUMENT");
      const elements = raw.elements.map((item: any) => { const parsed = input("create", { ...item, user_id: ownerId, parent_id: item?.parent_id ?? null }); if (typeof item?.id !== "string") throw new ElementsFault("INVALID_ARGUMENT"); return { id: item.id, kind: parsed.kind, parent_id: parsed.parent_id, title: parsed.title, description: parsed.description, result_spec: parsed.result_spec }; });
      const moves = raw.moves.map((item: any) => { const parsed = input("move", { ...item, user_id: ownerId }); if (typeof item?.id !== "string") throw new ElementsFault("INVALID_ARGUMENT"); return { id: item.id, kind: parsed.kind, title: parsed.title, instructions: parsed.instructions, result_schema: parsed.result_schema }; });
      const links = raw.links.map((item: any) => { const parsed = input("link", { ...item, user_id: ownerId }); return { move_id: parsed.move_id, element_id: parsed.element_id, revision_id: parsed.revision_id, role: parsed.role, required: parsed.required, position: parsed.position }; });
      const draft: StructureDraft = { elements, moves, links }; const ids = new Set(draft.elements.map(x => x.id)); if (ids.size !== draft.elements.length || new Set(draft.moves.map(x => x.id)).size !== draft.moves.length) throw new ElementsFault("CONFLICT"); const byId = new Map(draft.elements.map(item => [item.id, item]));
      for (const item of draft.elements) { validateElementDraft(item); if (item.parent_id) { const parent = byId.get(item.parent_id); if (!parent) throw new ElementsFault("NOT_FOUND"); if (hierarchyParent(item.kind) !== parent.kind) throw new ElementsFault("INVALID_ARGUMENT"); } }
      for (const item of draft.elements) { const seen = new Set<string>(); let current: string | null = item.id; while (current) { if (seen.has(current)) throw new ElementsFault("INVALID_ARGUMENT"); seen.add(current); current = byId.get(current)?.parent_id ?? null; } }
      for (const item of draft.moves) validateMoveDraft(item);
      for (const link of draft.links) if (!ids.has(link.element_id) || !draft.moves.some(move => move.id === link.move_id)) throw new ElementsFault("NOT_FOUND");
      for (const move of draft.moves) if (!draft.links.some(link => link.move_id === move.id)) throw new ElementsFault("INVALID_STATE");
      return response(await run(ownerId, context, tx => tx.createStructure(draft, context?.actorId ?? null)));
    },
    async elementCreate(value, context) { const raw = input("create", value); const draft = { id: raw.id, kind: raw.kind, parent_id: raw.parent_id ?? null, title: raw.title, description: raw.description, result_spec: raw.result_spec }; validateElementDraft(draft); return response(await run(raw.user_id, context, tx => tx.createElement(draft, context?.actorId ?? null))); },
    async elementRevise(value, context) { const raw = input("revise", value); return response(await run(raw.user_id, context, tx => tx.reviseElement({ element_id: raw.element_id, title: raw.title, description: raw.description, result_spec: raw.result_spec }, context?.actorId ?? null))); },
    async moveCreate(value, context) { const raw = input("move", value); const draft = { id: raw.id, kind: raw.kind, title: raw.title, instructions: raw.instructions, result_schema: raw.result_schema }; validateMoveDraft(draft); return response(await run(raw.user_id, context, tx => tx.createMove(draft))); },
    async moveLink(value, context) { const raw = input("link", value); return response(await run(raw.user_id, context, tx => tx.linkMove({ move_id: raw.move_id, element_id: raw.element_id, revision_id: raw.revision_id, role: raw.role, required: raw.required, position: raw.position }))); },
    async elementActivate(value, context) { const raw = input("activate", value); return response(await run(raw.user_id, context, tx => tx.activateElement(raw.element_id, context?.actorId ?? null))); },
    async graphGet(value, context) { const raw = input("graph", value); return response(await store.graph(raw.user_id, raw.root_id ?? null, raw.depth ?? 20, context)); },
    async elementGet(value, context) { const raw = input("element", value); const result = await store.element(raw.user_id, raw.element_id, context); if (!result) throw new ElementsFault("NOT_FOUND"); return response(result); },
    async timelineGet(value, context) { const raw = input("timeline", value); return response(await store.timeline(raw.user_id, raw.element_id ?? null, raw.limit ?? 50, raw.cursor ?? null, context)); },
    async movesAvailable(value, context) { const raw = input("moves", value); return response({ items: await store.availableMoves(raw.user_id, raw.element_id ?? null, context) }); },
    async moveClaim(value, context) { const raw = input("claim", value); const attemptId = raw.attempt_id ?? randomUUID(); return response(await run(raw.user_id, context, tx => tx.claimMove({ move_id: raw.move_id, attempt_id: attemptId, idempotency_key: raw.idempotency_key, executor_kind: raw.executor_kind, executor_id: raw.executor_id ?? context?.actorId ?? null, input: raw.input }, context?.actorId ?? null))); },
    async moveComplete(value, context) {
      const raw = input("complete", value);
      return response(await run(raw.user_id, context, tx => tx.completeAttempt(raw.attempt_id, raw.result, context?.actorId ?? null)));
    },
    async moveFail(value, context) { const raw = input("fail", value); return response(await run(raw.user_id, context, tx => tx.failAttempt(raw.attempt_id, raw.error_code, context?.actorId ?? null))); },
  };
}

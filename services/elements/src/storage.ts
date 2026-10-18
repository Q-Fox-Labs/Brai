// ABOUTME: Хранит Elements, Moves, попытки и outbox в собственной PostgreSQL-схеме.
// ABOUTME: Все изменения и соответствующее событие публикуются одной транзакцией.
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import { validateResult, type Element, type ElementKind, type ElementRevision, type ElementStatus, type EventEnvelope, type ExecutorKind, type Graph, type Move, type MoveAttempt, type MoveLink, type OperationContext, type Page, type TimelineItem } from "./contracts.js";
import { canActivate, ElementsFault, hierarchyParent, type ElementDraft, type ElementsStore, type ElementsTransaction, type LinkDraft, type MoveDraft, type StructureDraft } from "./domain.js";

type Row = QueryResultRow & Record<string, any>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const json = (value: unknown): string => JSON.stringify(value);
function failure(error: unknown): ElementsFault {
  if (error instanceof ElementsFault) return error;
  const code = (error as { code?: string })?.code ?? "";
  if (code === "23505") return new ElementsFault("CONFLICT");
  if (code === "23503" || code.startsWith("22") || ["23502", "23514"].includes(code)) return new ElementsFault("INVALID_ARGUMENT");
  if (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "ETIMEDOUT", "EPIPE", "40001", "40P01"].includes(code)) return new ElementsFault("DATABASE_UNAVAILABLE");
  return new ElementsFault("INTERNAL");
}
function check(context?: OperationContext): void { if (context && (context.signal.aborted || performance.now() >= context.deadlineAt)) throw new ElementsFault("DEADLINE_EXCEEDED"); }
function sqlTimeout(context?: OperationContext): string { return String(Math.max(1, Math.floor((context?.deadlineAt ?? performance.now() + 10_000) - performance.now()))); }
const elementFields = `e.id,e.owner_id,e.kind,e.parent_id,e.status,e.current_revision_id,
 r.id AS revision_id,r.revision,r.title,r.description,r.result_spec,r.created_by,r.created_at,
 (SELECT count(*)::int FROM elements.elements child WHERE child.parent_id=e.id) AS child_count`;
function element(row: Row): Element { return { id: row.id, owner_id: row.owner_id, kind: row.kind, parent_id: row.parent_id, status: row.status, child_count: Number(row.child_count ?? 0), current_revision: { id: row.revision_id, element_id: row.id, revision: Number(row.revision), title: row.title, description: row.description, result_spec: row.result_spec, created_by: row.created_by, created_at: iso(row.created_at) } }; }
function move(row: Row): Move { return { id: row.id, owner_id: row.owner_id, kind: row.kind, title: row.title, instructions: row.instructions, result_schema: row.result_schema, status: row.status, created_at: iso(row.created_at) }; }
function attempt(row: Row): MoveAttempt { return { id: row.id, move_id: row.move_id, executor_kind: row.executor_kind, executor_id: row.executor_id, status: row.status, input: row.input ?? {}, result: row.result, error_code: row.error_code, started_at: iso(row.started_at), finished_at: row.finished_at ? iso(row.finished_at) : null }; }
function link(row: Row): MoveLink { return { move_id: row.move_id, element_id: row.element_id, revision_id: row.revision_id, role: row.role, required: row.required, position: Number(row.position) }; }
async function query(client: PoolClient, context: OperationContext | undefined, text: string, values: unknown[] = []) { check(context); await client.query("SELECT set_config('statement_timeout',$1,true)", [sqlTimeout(context)]); const result = await client.query<Row>(text, values); check(context); return result; }

function historyCodes(type: string): { category: string; code: string } { if (type.endsWith("created") || type === "structure.created") return { category: "object", code: "create" }; if (type.endsWith("revised")) return { category: "object", code: "update" }; if (type === "move.linked") return { category: "relationship", code: "link" }; if (type === "element.activated") return { category: "lifecycle", code: "activate" }; if (type === "element.completed") return { category: "state", code: "transition" }; return { category: "execution", code: "execute" }; }
function envelope(ownerId: string, actorId: string | null, actorKind: ExecutorKind | undefined, type: string, aggregate: EventEnvelope["aggregate"], data: Record<string, unknown>, notification?: EventEnvelope["notification"]): EventEnvelope { const codes = historyCodes(type); return { event_id: randomUUID(), event_version: 1, event_type: type, occurred_at: new Date().toISOString(), owner_id: ownerId, actor: { kind: actorKind ?? (actorId ? "agent" : "system"), id: actorId }, aggregate, data: { ...data, history_category_code: codes.category, history_type_code: codes.code }, ...(notification ? { notification } : {}) }; }
async function emit(client: PoolClient, ownerId: string, actorId: string | null, type: string, aggregate: EventEnvelope["aggregate"], data: Record<string, unknown>, notification?: EventEnvelope["notification"], actorKind?: ExecutorKind): Promise<void> {
  const event = envelope(ownerId, actorId, actorKind, type, aggregate, data, notification);
  await client.query(`INSERT INTO elements.outbox(id,event_type,subject,payload) VALUES($1,$2,$3,$4::jsonb)`, [event.event_id, event.event_type, `brai.elements.v1.events.${event.event_type}`, json(event)]);
}
async function selectedElement(client: PoolClient, ownerId: string, id: string, context?: OperationContext, forUpdate = false): Promise<Element> {
  const row = (await query(client, context, `SELECT ${elementFields} FROM elements.elements e JOIN elements.element_revisions r ON r.id=e.current_revision_id WHERE e.owner_id=$1 AND e.id=$2 ${forUpdate ? "FOR UPDATE" : ""}`, [ownerId, id])).rows[0];
  if (!row) throw new ElementsFault("NOT_FOUND");
  return element(row);
}
async function selectedMove(client: PoolClient, ownerId: string, id: string, context?: OperationContext, forUpdate = false): Promise<Move> {
  const row = (await query(client, context, `SELECT id,owner_id,kind,title,instructions,result_schema,status,created_at FROM elements.moves WHERE owner_id=$1 AND id=$2 ${forUpdate ? "FOR UPDATE" : ""}`, [ownerId, id])).rows[0];
  if (!row) throw new ElementsFault("NOT_FOUND");
  return move(row);
}
function parentCheck(parent: Element, kind: ElementKind): void { if (hierarchyParent(kind) !== parent.kind) throw new ElementsFault("INVALID_ARGUMENT"); }

function transactionPort(ownerId: string, client: PoolClient, context?: OperationContext): ElementsTransaction {
  const tx: ElementsTransaction = {
    async createElement(input: ElementDraft, actorId) {
      const id = input.id ?? randomUUID();
      if (input.parent_id) parentCheck(await selectedElement(client, ownerId, input.parent_id, context), input.kind);
      const revisionId = randomUUID();
      try {
        await query(client, context, `INSERT INTO elements.elements(id,owner_id,kind,parent_id,status,current_revision_id) VALUES($1,$2,$3,$4,'draft',$5)`, [id, ownerId, input.kind, input.parent_id, revisionId]);
        await query(client, context, `INSERT INTO elements.element_revisions(id,element_id,revision,title,description,result_spec,created_by) VALUES($1,$2,1,$3,$4,$5::jsonb,$6)`, [revisionId, id, input.title, input.description, json(input.result_spec), actorId ?? ownerId]);
        await emit(client, ownerId, actorId, "element.created", { kind: "element", id }, { element_kind: input.kind, revision: 1 });
      } catch (error) { throw failure(error); }
      return selectedElement(client, ownerId, id, context);
    },
    async reviseElement(input, actorId) {
      const current = await selectedElement(client, ownerId, input.element_id, context, true);
      const revisionId = randomUUID(); const revision = current.current_revision.revision + 1;
      await query(client, context, `INSERT INTO elements.element_revisions(id,element_id,revision,title,description,result_spec,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [revisionId, input.element_id, revision, input.title, input.description, json(input.result_spec), actorId ?? ownerId]);
      await query(client, context, `UPDATE elements.elements SET current_revision_id=$1 WHERE owner_id=$2 AND id=$3`, [revisionId, ownerId, input.element_id]);
      await emit(client, ownerId, actorId, "element.revised", { kind: "element", id: input.element_id }, { revision });
      return selectedElement(client, ownerId, input.element_id, context);
    },
    async createMove(input: MoveDraft) {
      const id = input.id ?? randomUUID();
      try { await query(client, context, `INSERT INTO elements.moves(id,owner_id,kind,title,instructions,result_schema,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,'planned')`, [id, ownerId, input.kind, input.title, input.instructions, json(input.result_schema)]); }
      catch (error) { throw failure(error); }
      await emit(client, ownerId, null, "move.created", { kind: "move", id }, { kind: input.kind });
      return selectedMove(client, ownerId, id, context);
    },
    async linkMove(input: LinkDraft) {
      const mv = await selectedMove(client, ownerId, input.move_id, context, true); const el = await selectedElement(client, ownerId, input.element_id, context, true);
      if ((input.role === "accept" || input.role === "launch") && mv.kind !== "operation") throw new ElementsFault("INVALID_ARGUMENT");
      const revisionId = input.revision_id ?? el.current_revision.id;
      if (revisionId !== el.current_revision.id) throw new ElementsFault("CONFLICT");
      try { await query(client, context, `INSERT INTO elements.move_element_links(move_id,element_id,revision_id,role,required,position) VALUES($1,$2,$3,$4,$5,$6)`, [input.move_id, input.element_id, revisionId, input.role, input.required ?? true, input.position ?? 0]); }
      catch (error) { throw failure(error); }
      await emit(client, ownerId, null, "move.linked", { kind: "move", id: input.move_id }, { element_id: input.element_id, role: input.role });
      return { move_id: input.move_id, element_id: input.element_id, revision_id: revisionId, role: input.role, required: input.required ?? true, position: input.position ?? 0 };
    },
    async activateElement(elementId, actorId) {
      const el = await selectedElement(client, ownerId, elementId, context, true);
      if (el.status !== "draft") throw new ElementsFault("INVALID_STATE");
      const children = Number((await query(client, context, `SELECT count(*)::int AS count FROM elements.elements WHERE owner_id=$1 AND parent_id=$2`, [ownerId, elementId])).rows[0].count);
      const accepts = Number((await query(client, context, `SELECT count(*)::int AS count FROM elements.move_element_links l JOIN elements.moves m ON m.id=l.move_id WHERE l.element_id=$1 AND l.role='accept' AND m.owner_id=$2`, [elementId, ownerId])).rows[0].count);
      canActivate(el.kind, children, accepts);
      await query(client, context, `UPDATE elements.elements SET status='active' WHERE owner_id=$1 AND id=$2`, [ownerId, elementId]);
      await emit(client, ownerId, actorId, "element.activated", { kind: "element", id: elementId }, { kind: el.kind });
      return selectedElement(client, ownerId, elementId, context);
    },
    async claimMove(input, actorId) {
      const mv = await selectedMove(client, ownerId, input.move_id, context, true);
      const existing = (await query(client, context, `SELECT id,move_id,executor_kind,executor_id,status,input,result,error_code,started_at,finished_at FROM elements.move_attempts WHERE owner_id=$1 AND move_id=$2 AND idempotency_key=$3`, [ownerId, input.move_id, input.idempotency_key])).rows[0];
      if (existing) return { attempt: attempt(existing), move: mv };
      if (mv.status === "succeeded") throw new ElementsFault("INVALID_STATE");
      const active = (await query(client, context, `SELECT 1 FROM elements.move_attempts WHERE owner_id=$1 AND move_id=$2 AND status='running'`, [ownerId, input.move_id])).rowCount;
      if (active) throw new ElementsFault("CONFLICT");
      try { await query(client, context, `INSERT INTO elements.move_attempts(id,owner_id,move_id,idempotency_key,executor_kind,executor_id,status,input) VALUES($1,$2,$3,$4,$5,$6,'running',$7::jsonb)`, [input.attempt_id, ownerId, input.move_id, input.idempotency_key, input.executor_kind, input.executor_id, json(input.input)]); await query(client, context, `UPDATE elements.moves SET status='claimed' WHERE owner_id=$1 AND id=$2`, [ownerId, input.move_id]); }
      catch (error) { throw failure(error); }
      await emit(client, ownerId, input.executor_id ?? actorId, "move.claimed", { kind: "attempt", id: input.attempt_id }, { move_id: input.move_id, executor_kind: input.executor_kind }, undefined, input.executor_kind);
      const row = (await query(client, context, `SELECT id,move_id,executor_kind,executor_id,status,input,result,error_code,started_at,finished_at FROM elements.move_attempts WHERE id=$1`, [input.attempt_id])).rows[0];
      return { attempt: attempt(row), move: { ...mv, status: "claimed" } };
    },
    async completeAttempt(attemptId, result, actorId) {
      const row = (await query(client, context, `SELECT a.id,a.move_id,a.executor_kind,a.executor_id,a.status,a.input,a.result,a.error_code,a.started_at,a.finished_at,m.result_schema,m.owner_id,m.kind,m.title,m.instructions,m.status AS move_status,m.created_at FROM elements.move_attempts a JOIN elements.moves m ON m.id=a.move_id WHERE a.owner_id=$1 AND a.id=$2 FOR UPDATE`, [ownerId, attemptId])).rows[0];
      if (!row) throw new ElementsFault("NOT_FOUND");
      if (row.status === "succeeded") return { attempt: attempt(row), move: move({ ...row, status: "succeeded" }), completed_elements: [] };
      if (row.status !== "running") throw new ElementsFault("INVALID_STATE");
      if (!validateResult(row.result_schema, result)) throw new ElementsFault("RESULT_INVALID");
      const accepts = Number((await query(client, context, `SELECT count(*)::int AS count FROM elements.move_element_links WHERE move_id=$1 AND role='accept'`, [row.move_id])).rows[0].count);
      if (accepts > 0 && row.executor_kind === "human") throw new ElementsFault("FORBIDDEN");
      await query(client, context, `UPDATE elements.move_attempts SET status='succeeded',result=$1::jsonb,finished_at=clock_timestamp() WHERE owner_id=$2 AND id=$3`, [json(result), ownerId, attemptId]);
      await query(client, context, `UPDATE elements.moves SET status='succeeded' WHERE owner_id=$1 AND id=$2`, [ownerId, row.move_id]);
      const completed = (await query(client, context, `UPDATE elements.elements e SET status='completed' WHERE e.owner_id=$1 AND e.id IN (SELECT element_id FROM elements.move_element_links WHERE move_id=$2 AND role='accept') RETURNING e.id`, [ownerId, row.move_id])).rows.map(item => item.id as string);
      await emit(client, ownerId, row.executor_id ?? actorId, "move.completed", { kind: "attempt", id: attemptId }, { move_id: row.move_id, result }, undefined, row.executor_kind);
      for (const id of completed) await emit(client, ownerId, row.executor_id ?? actorId, "element.completed", { kind: "element", id }, { move_id: row.move_id }, { type_code: "completed", title: "Элемент завершён", text: "Операция приняла результат хода.", data: { element_id: id, move_id: row.move_id } }, row.executor_kind);
      const saved = (await query(client, context, `SELECT id,move_id,executor_kind,executor_id,status,input,result,error_code,started_at,finished_at FROM elements.move_attempts WHERE id=$1`, [attemptId])).rows[0];
      return { attempt: attempt(saved), move: move({ ...row, status: "succeeded" }), completed_elements: completed };
    },
    async failAttempt(attemptId, errorCode, actorId) {
      const row = (await query(client, context, `SELECT id,move_id,executor_kind,executor_id,status,input,result,error_code,started_at,finished_at FROM elements.move_attempts WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [ownerId, attemptId])).rows[0];
      if (!row) throw new ElementsFault("NOT_FOUND"); if (row.status !== "running") throw new ElementsFault("INVALID_STATE");
      await query(client, context, `UPDATE elements.move_attempts SET status='failed',error_code=$1,finished_at=clock_timestamp() WHERE owner_id=$2 AND id=$3`, [errorCode, ownerId, attemptId]);
      await query(client, context, `UPDATE elements.moves SET status='planned' WHERE owner_id=$1 AND id=$2`, [ownerId, row.move_id]);
      await emit(client, ownerId, row.executor_id ?? actorId, "move.failed", { kind: "attempt", id: attemptId }, { move_id: row.move_id, error_code: errorCode }, undefined, row.executor_kind);
      return attempt({ ...row, status: "failed", error_code: errorCode, finished_at: new Date() });
    },
    async createStructure(input: StructureDraft, actorId) {
      const revisions = new Map<string, string>(); const elements: Element[] = []; const moves: Move[] = [];
      const remaining = [...input.elements]; const inserted = new Set<string>();
      while (remaining.length) {
        const index = remaining.findIndex(draft => draft.parent_id === null || inserted.has(draft.parent_id));
        if (index < 0) throw new ElementsFault("INVALID_ARGUMENT");
        const [draft] = remaining.splice(index, 1); if (!draft) throw new ElementsFault("INVALID_ARGUMENT");
        const revisionId = randomUUID(); revisions.set(draft.id, revisionId);
        await query(client, context, `INSERT INTO elements.elements(id,owner_id,kind,parent_id,status,current_revision_id) VALUES($1,$2,$3,$4,'draft',$5)`, [draft.id, ownerId, draft.kind, draft.parent_id, revisionId]);
        await query(client, context, `INSERT INTO elements.element_revisions(id,element_id,revision,title,description,result_spec,created_by) VALUES($1,$2,1,$3,$4,$5::jsonb,$6)`, [revisionId, draft.id, draft.title, draft.description, json(draft.result_spec), actorId ?? ownerId]);
        inserted.add(draft.id);
      }
      for (const draft of input.moves) { await query(client, context, `INSERT INTO elements.moves(id,owner_id,kind,title,instructions,result_schema,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,'planned')`, [draft.id, ownerId, draft.kind, draft.title, draft.instructions, json(draft.result_schema)]); }
      for (const draft of input.links) { const revisionId = revisions.get(draft.element_id); if (!revisionId) throw new ElementsFault("NOT_FOUND"); if (draft.revision_id && draft.revision_id !== revisionId) throw new ElementsFault("CONFLICT"); const mv = input.moves.find(item => item.id === draft.move_id); if (!mv) throw new ElementsFault("NOT_FOUND"); if ((draft.role === "accept" || draft.role === "launch") && mv.kind !== "operation") throw new ElementsFault("INVALID_ARGUMENT"); await query(client, context, `INSERT INTO elements.move_element_links(move_id,element_id,revision_id,role,required,position) VALUES($1,$2,$3,$4,$5,$6)`, [draft.move_id, draft.element_id, revisionId, draft.role, draft.required ?? true, draft.position ?? 0]); }
      await emit(client, ownerId, actorId, "structure.created", { kind: "element", id: input.elements[0]?.id ?? randomUUID() }, { elements: input.elements.map(item => item.id), moves: input.moves.map(item => item.id) });
      const graph = await loadGraph(client, ownerId, null, 20, context); elements.push(...graph.elements); moves.push(...graph.moves); return { elements, moves, links: graph.links };
    },
  };
  return tx;
}

async function loadGraph(client: PoolClient, ownerId: string, rootId: string | null, depth: number, context?: OperationContext): Promise<Graph> {
  const rows = (await query(client, context, `SELECT ${elementFields} FROM elements.elements e JOIN elements.element_revisions r ON r.id=e.current_revision_id WHERE e.owner_id=$1 ORDER BY e.created_at,e.id`, [ownerId])).rows;
  const all = rows.map(element); let visible = all;
  if (rootId) { const byParent = new Map<string | null, Element[]>(); for (const item of all) byParent.set(item.parent_id, [...(byParent.get(item.parent_id) ?? []), item]); const root = all.find(item => item.id === rootId); if (!root) throw new ElementsFault("NOT_FOUND"); visible = [root]; let frontier = [root]; for (let level = 0; level < depth; level++) { frontier = frontier.flatMap(item => byParent.get(item.id) ?? []); visible.push(...frontier); } }
  const ids = visible.map(item => item.id); if (!ids.length) return { elements: [], moves: [], links: [] };
  const links = (await query(client, context, `SELECT l.move_id,l.element_id,l.revision_id,l.role,l.required,l.position FROM elements.move_element_links l JOIN elements.moves m ON m.id=l.move_id WHERE m.owner_id=$1 AND l.element_id=ANY($2::uuid[]) ORDER BY l.position,l.move_id`, [ownerId, ids])).rows.map(link);
  const moves = (await query(client, context, `SELECT DISTINCT m.id,m.owner_id,m.kind,m.title,m.instructions,m.result_schema,m.status,m.created_at FROM elements.moves m JOIN elements.move_element_links l ON l.move_id=m.id WHERE m.owner_id=$1 AND l.element_id=ANY($2::uuid[]) ORDER BY m.created_at,m.id`, [ownerId, ids])).rows.map(move);
  return { elements: visible, moves, links };
}

export function createPostgresStore(pool: Pool): ElementsStore {
  const transaction = async <T>(ownerId: string, context: OperationContext | undefined, run: (tx: ElementsTransaction) => Promise<T>): Promise<T> => {
    let client: PoolClient | undefined; let begun = false;
    try { client = await pool.connect(); await client.query("BEGIN"); begun = true; await client.query("SELECT set_config('statement_timeout',$1,true)", [sqlTimeout(context)]); const value = await run(transactionPort(ownerId, client, context)); check(context); await client.query("COMMIT"); begun = false; return value; }
    catch (error) { if (begun && client) await client.query("ROLLBACK").catch(() => {}); throw failure(error); }
    finally { client?.release(); }
  };
  async function read<T>(context: OperationContext | undefined, fn: (client: PoolClient) => Promise<T>): Promise<T> { let client: PoolClient | undefined; try { client = await pool.connect(); return await fn(client); } catch (error) { throw failure(error); } finally { client?.release(); } }
  return {
    transaction,
    async element(ownerId, id, context) { return read(context, async client => { const row = (await query(client, context, `SELECT ${elementFields} FROM elements.elements e JOIN elements.element_revisions r ON r.id=e.current_revision_id WHERE e.owner_id=$1 AND e.id=$2`, [ownerId, id])).rows[0]; return row ? element(row) : null; }); },
    async graph(ownerId, rootId, depth, context) { return read(context, client => loadGraph(client, ownerId, rootId, depth, context)); },
    async availableMoves(ownerId, elementId, context) { return read(context, async client => { const graph = await loadGraph(client, ownerId, null, 20, context); const byId = new Map(graph.elements.map(item => [item.id, item])); const linksByMove = new Map<string, MoveLink[]>(); for (const item of graph.links) linksByMove.set(item.move_id, [...(linksByMove.get(item.move_id) ?? []), item]); const active = new Set((await query(client, context, `SELECT move_id FROM elements.move_attempts WHERE owner_id=$1 AND status='running'`, [ownerId])).rows.map(item => item.move_id as string)); return graph.moves.filter(mv => mv.status === "planned" && !active.has(mv.id) && (!elementId || (linksByMove.get(mv.id) ?? []).some(item => item.element_id === elementId))).filter(mv => (linksByMove.get(mv.id) ?? []).every(item => item.role !== "accept" || (byId.get(item.element_id)?.status === "active" && (linksByMove.get(mv.id) ?? []).filter(other => other.role === "input" && other.required).every(other => byId.get(other.element_id)?.status === "completed")))); }); },
    async timeline(ownerId, elementId, limit, _cursor, context) { return read(context, async client => { const rows = (await query(client, context, `SELECT a.id,a.move_id,a.executor_kind,a.executor_id,a.status,a.input,a.result,a.error_code,a.started_at,a.finished_at,m.owner_id,m.kind,m.title,m.instructions,m.result_schema,m.status AS move_status,m.created_at FROM elements.move_attempts a JOIN elements.moves m ON m.id=a.move_id WHERE a.owner_id=$1 ${elementId ? "AND EXISTS(SELECT 1 FROM elements.move_element_links x WHERE x.move_id=m.id AND x.element_id=$2)" : ""} ORDER BY a.started_at DESC,a.id DESC LIMIT $${elementId ? 3 : 2}`, [ownerId, ...(elementId ? [elementId] : []), Math.min(limit, 100)])).rows; const items = await Promise.all(rows.map(async row => ({ attempt: attempt(row), move: move({ ...row, status: row.move_status }), element_ids: (await query(client, context, `SELECT element_id FROM elements.move_element_links WHERE move_id=$1 ORDER BY position,element_id`, [row.move_id])).rows.map(item => item.element_id as string) }))); return { items, next_cursor: null }; }); },
    async pendingOutbox(limit) { return read(undefined, async client => (await client.query<Row>(`SELECT id,subject,payload FROM game_core.outbox WHERE published_at IS NULL ORDER BY created_at,id LIMIT $1`, [Math.min(limit, 100)])).rows.map(row => ({ id: row.id, subject: row.subject, payload: row.payload }))); },
    async markOutboxPublished(id) { await pool.query(`UPDATE game_core.outbox SET published_at=clock_timestamp() WHERE id=$1 AND published_at IS NULL`, [id]); },
    async ready() { await pool.query("SELECT 1 FROM elements.migrations"); },
  };
}

// ABOUTME: Управляет native чатами, ходами и формами через один CodexPort.
// ABOUTME: Владеет только bounded live проекцией; историю читает у Codex.
import { randomUUID, createHash } from 'node:crypto';
import { bytes, limits, validateCommand } from '../contracts/index.mjs';
import type { Command, EventEnvelope, NativeSnapshot, PendingRequest } from '../contracts/index.mjs';
import type { CodexPort, Observation } from './codex.js';
import { display, metadata, text } from './display.js';
export type Config = { codex: { socketUrl: string }; nats: { servers: string[]; user?: string; password?: string; inboxPrefix?: string }; projects: { projectId: string; name: string; cwd: string; available?: boolean }[]; allowedModels?: string[]; newThread?: { approvalsReviewer?: string | null; model?: string } };
type Session = { view: NativeSnapshot; opened: boolean; fresh: boolean; closing?: boolean; model: string | null; raw: Map<string, string | number>; revisions: Map<string, number> };
/** Собирает команды и единственного владельца live items/pending. */
export function createApplication(codex: CodexPort, config: Config, emit: (event: EventEnvelope) => void) {
  const sessions = new Map<string, Session>();
  let creating = 0, admission = Promise.resolve();
  const operations = new Map<string, { hash: string; result: Promise<any> }>();
  const openings = new Map<string, Promise<Session>>();
  function fail(code: string, outcome = 'not-sent'): never { throw Object.assign(new Error(code), { code, outcome }); }
  const project = (id?: string) => config.projects.find(p => p.projectId === id && p.available !== false) ?? fail('NOT_FOUND');
  const current = () => codex.status().generation;
  function publish(s: Session) {
    if (s.view.seq === Number.MAX_SAFE_INTEGER) { s.view.epoch = randomUUID(); s.view.seq = 0; }
    s.view.seq++;
    while (s.view.items.length > 128 || bytes(s.view) > limits.state) {
      const dropped = s.view.items.shift();
      if (!dropped) { s.view.requests = []; s.raw.clear(); s.view.state = 'executor-unavailable'; break; }
      s.revisions.delete(dropped.id);
      s.view.truncated = true;
    }
    emit({ projectId: s.view.projectId, threadId: s.view.threadId, generation: s.view.generation, epoch: s.view.epoch, seq: s.view.seq, event: { type: 'STATE_SNAPSHOT', snapshot: structuredClone(s.view) } });
  }
  function put(s: Session, item: any, turnId: string) {
    const value = display(item, turnId), index = s.view.items.findIndex(old => old.id === value.id);
    if (index < 0) s.view.items.push(value);
    else s.view.items[index] = value;
    s.revisions.set(value.id, s.view.seq + 1);
  }
  async function admit(projectId: string, thread: any, fresh = false): Promise<Session> {
    const previous = admission;
    let release!: () => void;
    admission = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
    if (sessions.size >= limits.threads) {
      const victim = [...sessions.values()].find(s => s.view.turn?.status !== 'inProgress' && !s.view.requests.length);
      if (!victim) fail('CAPACITY_EXHAUSTED');
      victim.closing = true;
      let response: any;
      try { response = await codex.call('thread/unsubscribe', { threadId: victim.view.threadId }, { mutation: true }); }
      catch (error: any) { if (error.outcome === 'not-sent') victim.closing = false; throw error; }
      if (!['unsubscribed', 'notLoaded', 'notSubscribed'].includes(response.status)) fail('CAPACITY_EXHAUSTED');
      victim.view.epoch = randomUUID();
      publish(victim);
      sessions.delete(victim.view.threadId);
    }
    const view: NativeSnapshot = { projectId, threadId: thread.id, generation: current(), epoch: randomUUID(), seq: 0, thread: metadata(thread), turn: null, state: 'idle', items: [], requests: [], truncated: false };
    const s: Session = { view, opened: fresh, fresh, model: thread.model ?? null, raw: new Map(), revisions: new Map() };
    sessions.set(thread.id, s);
    return s;
    } finally { release(); }
  }
  async function open(r: Command): Promise<Session> {
    const p = project(r.projectId), id = r.threadId!;
    let s = sessions.get(id);
    if (s && s.view.projectId !== p.projectId) fail('INVALID_ARGUMENT');
    if (s?.closing) fail('CAPACITY_EXHAUSTED');
    if (s?.opened) return s;
    if (openings.has(id)) return openings.get(id)!;
    const work = (async () => {
      const before = current();
      const native = await codex.call('thread/read', { threadId: id, includeTurns: false });
      if (native.thread.cwd !== p.cwd) fail('INVALID_ARGUMENT');
      if (!s) s = await admit(p.projectId, native.thread);
      const cut = s.view.seq;
      const resumed = await codex.call('thread/resume', { threadId: id, cwd: p.cwd, excludeTurns: true }, { mutation: true });
      const turns = await codex.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
      const items = await codex.call('thread/items/list', { threadId: id, limit: 100, sortDirection: 'desc' });
      if (before !== current()) fail('STALE_GENERATION', 'query');
      s.view.thread = metadata(resumed.thread);
      s.model = resumed.model;
      for (const entry of items.data.slice().reverse()) if ((s.revisions.get(entry.item.id) ?? 0) <= cut) put(s, entry.item, entry.turnId);
      if (s.view.seq === cut) {
        const turn = turns.data[0];
        s.view.turn = turn ? { id: turn.id, status: turn.status } : null;
        s.view.state = turn?.status === 'inProgress' && resumed.thread.status.type !== 'active' ? 'executor-unavailable' : turn?.status ?? 'idle';
      }
      s.opened = true;
      publish(s);
      return s;
    })().finally(() => openings.delete(id));
    openings.set(id, work);
    return work;
  }
  function observe(e: Observation) {
    if (e.type === 'connection') {
      operations.clear();
      for (const s of sessions.values()) {
        s.opened = s.fresh = s.closing = false;
        s.raw.clear();
        s.view.requests = [];
        s.view.generation = current();
        s.view.epoch = randomUUID();
        s.view.state = 'connection-lost';
        publish(s);
      }
      return;
    }
    const p = e.params, s = sessions.get(p?.threadId);
    if (!s) return;
    if (e.type === 'request') {
      const requestId = `${typeof e.id}:${e.id}`, kinds: Record<string, PendingRequest['kind']> = { 'item/commandExecution/requestApproval': 'command-approval', 'item/fileChange/requestApproval': 'file-change-approval', 'item/permissions/requestApproval': 'permissions', 'item/tool/requestUserInput': 'question' };
      if (s.view.requests.some(f => f.requestId === requestId)) return;
      if (s.view.requests.length >= limits.pending) { s.view.state = 'executor-unavailable'; publish(s); return; }
      const supported = e.supported && s.view.requests.length < limits.pending && bytes(s.view.requests) + bytes(p) < 131072;
      s.view.requests.push({ requestId, turnId: p.turnId, method: e.method!, kind: supported ? kinds[e.method!] ?? 'unsupported' : 'unsupported', params: supported ? p : {}, answered: false, ...(supported ? {} : { reason: 'unsupported-or-too-large' }) });
      s.raw.set(requestId, e.id!);
    } else if (e.method === 'serverRequest/resolved') {
      const id = `${typeof p.requestId}:${p.requestId}`;
      s.view.requests = s.view.requests.filter(f => f.requestId !== id);
      s.raw.delete(id);
    } else if (e.method === 'turn/started' || e.method === 'turn/completed') {
      s.view.turn = { id: p.turn.id, status: p.turn.status };
      s.view.state = p.turn.status;
      if (p.turn.status !== 'inProgress') { s.view.requests = []; s.raw.clear(); }
    } else if (e.method === 'item/started' || e.method === 'item/completed') put(s, p.item, p.turnId);
    else if (e.method?.endsWith('/delta') || e.method?.endsWith('/outputDelta')) {
      const item = s.view.items.find(i => i.id === p.itemId);
      if (!item) { s.opened = false; s.view.state = 'connection-lost'; }
      else {
        const field = e.method === 'item/agentMessage/delta' ? 'text' : 'output';
        item[field] = text((item[field] ?? '') + p.delta, field === 'text' ? 8192 : 32768);
        s.revisions.set(item.id, s.view.seq + 1);
      }
    } else if (e.method === 'turn/plan/updated') put(s, { id: `plan:${p.turnId}`, type: 'plan', text: p.plan.map((step: any) => `${step.status}: ${step.step}`).join('\n') }, p.turnId);
    else return;
    if (s.view.requests.some(f => !f.answered)) s.view.state = 'waiting';
    publish(s);
  }
  const unsubscribe = codex.subscribe(observe);
  async function execute(r: Command): Promise<any> {
    if (r.action === 'status') return { ...codex.status(), ready: codex.status().connection === 'connected' && codex.status().authorization === 'ready' };
    if (r.action === 'projects') return { generation: current(), projects: config.projects.map(p => ({ projectId: p.projectId, name: p.name, available: p.available !== false })) };
    if (codex.status().connection !== 'connected' || codex.status().authorization !== 'ready') fail('UPSTREAM_UNAVAILABLE', r.operationId ? 'not-sent' : 'query');
    const p = project(r.projectId);
    if (r.operationId && r.generation !== current()) fail('STALE_GENERATION');
    if (r.action === 'threads') {
      const page = await codex.call('thread/list', { cwd: p.cwd, limit: 100, cursor: r.cursor });
      return { generation: current(), data: page.data.filter((t: any) => t.cwd === p.cwd).map(metadata), nextCursor: page.nextCursor ?? null };
    }
    if (r.action === 'create') {
      if (sessions.size + creating >= limits.threads) fail('CAPACITY_EXHAUSTED');
      creating++;
      try {
      const native = await codex.call('thread/start', { cwd: p.cwd, allowProviderModelFallback: false, ...config.newThread }, { mutation: true });
      if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
      await admit(p.projectId, { ...native.thread, model: native.model }, true);
      if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
      return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: native.thread.id };
      } finally { creating--; }
    }
    const s = await open(r);
    if (r.action === 'open') return structuredClone(s.view);
    if (r.action === 'items' || r.action === 'turns') {
      if (s.fresh) return { generation: current(), data: [], nextCursor: null };
      const page = await codex.call(r.action === 'items' ? 'thread/items/list' : 'thread/turns/list', { threadId: r.threadId, limit: 100, cursor: r.cursor, sortDirection: 'desc', ...(r.action === 'items' ? { turnId: r.turnId } : { itemsView: 'notLoaded' }) });
      return { generation: current(), data: r.action === 'items' ? page.data.slice().reverse().map((e: any) => display(e.item, e.turnId, true)) : page.data.map((t: any) => ({ id: t.id, status: t.status })), nextCursor: page.nextCursor ?? null };
    }
    if (r.generation !== current()) fail('STALE_GENERATION');
    if (s.closing) fail('CAPACITY_EXHAUSTED');
    const active = s.view.turn?.status === 'inProgress';
    if (r.action === 'start' && (active || s.view.thread.canAcceptDirectInput === false)) fail('OPERATION_CONFLICT');
    if ((r.action === 'steer' || r.action === 'interrupt') && (!active || s.view.turn?.id !== (r.expectedTurnId ?? r.turnId))) fail('OPERATION_CONFLICT');
    if (r.action === 'start' && [...sessions.values()].filter(s => s.view.turn?.status === 'inProgress').length >= 4) fail('CAPACITY_EXHAUSTED');
    if (r.action === 'start' && config.allowedModels && !config.allowedModels.includes(s.model ?? '')) fail('UNSUPPORTED');
    const previousTurn = s.view.turn, previousState = s.view.state;
    if (r.action === 'start') { s.view.turn = { id: 'starting', status: 'inProgress' }; s.view.state = 'inProgress'; publish(s); }
    let turnId = r.turnId;
    if (r.action === 'answer') {
      const f = s.view.requests.find(f => f.requestId === r.requestId);
      if (!f || f.answered) fail('STALE_REQUEST');
      if (f.kind === 'unsupported' || !codex.validateAnswer(s.raw.get(f.requestId)!, r.answer) || !validAnswer(f, r.answer)) fail('INVALID_ARGUMENT');
      f.answered = true;
      publish(s);
      try { await codex.respond(s.raw.get(f.requestId)!, r.answer); }
      catch (error: any) { if (error.outcome === 'not-sent' && r.generation === current() && s.view.requests.includes(f)) { f.answered = false; publish(s); } throw error; }
    } else if (r.action === 'interrupt') await codex.call('turn/interrupt', { threadId: r.threadId, turnId: r.turnId }, { mutation: true });
    else {
      const params = { threadId: r.threadId, input: [{ type: 'text', text: r.text }], ...(r.action === 'steer' ? { expectedTurnId: r.expectedTurnId } : {}) };
      let value: any;
      try { value = await codex.call(r.action === 'steer' ? 'turn/steer' : 'turn/start', params, { mutation: true }); }
      catch (error: any) { if (r.action === 'start' && error.outcome === 'not-sent' && r.generation === current() && s.view.turn?.id === 'starting') { s.view.turn = previousTurn; s.view.state = previousState; publish(s); } throw error; }
      turnId = value.turn?.id ?? value.turnId;
      if (r.action === 'start' && s.view.turn?.id === 'starting') { s.view.turn = { id: turnId!, status: value.turn.status }; publish(s); }
      s.fresh = false;
    }
    if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
    return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: r.threadId, turnId, ...(r.requestId ? { requestId: r.requestId } : {}) };
  }
  /** Повтор того же operation ID возвращает исходный результат без native вызова. */
  async function request(r: Command): Promise<any> {
    if (!validateCommand(r)) fail('INVALID_ARGUMENT');
    if (!r.operationId) return execute(r);
    if (r.generation !== current()) fail('STALE_GENERATION');
    const canonical = JSON.stringify(r, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    const hash = createHash('sha256').update(canonical).digest('hex'), old = operations.get(r.operationId);
    if (old) return old.hash === hash ? old.result : fail('OPERATION_CONFLICT');
    if (operations.size >= limits.operations) fail('CAPACITY_EXHAUSTED');
    const result = Promise.resolve().then(() => execute(r));
    operations.set(r.operationId, { hash, result });
    return result;
  }
  return { request, close: unsubscribe };
}
function validAnswer(f: PendingRequest, answer: any): boolean {
  if (f.kind === 'command-approval' && f.params.availableDecisions) return f.params.availableDecisions.some((v: any) => JSON.stringify(v) === JSON.stringify(answer?.decision));
  if (f.kind === 'question') {
    if (Object.keys(answer?.answers ?? {}).sort().join() !== f.params.questions.map((q: any) => q.id).sort().join()) return false;
    return f.params.questions.every((q: any) => answer.answers[q.id].answers.length > 0 && answer.answers[q.id].answers.every((value: string) => value.trim() && (!q.options?.length || q.isOther || q.options.some((option: any) => option.label === value))));
  }
  if (f.kind === 'permissions') return answer?.scope === 'turn' && answer?.strictAutoReview !== true && (JSON.stringify(answer?.permissions) === JSON.stringify(f.params.permissions) || JSON.stringify(answer?.permissions) === '{}');
  return true;
}

// ABOUTME: Управляет native чатами, ходами и формами через один CodexPort.
// ABOUTME: Владеет только bounded live проекцией; историю читает у Codex.
import { randomUUID, createHash } from 'node:crypto';
import { bytes, limits, validateCommand } from '../contracts/index.mjs';
import type { Command, EventEnvelope, NativeSnapshot, PendingRequest, ModelCatalog, DisplayItem } from '../contracts/index.mjs';
import type { CodexPort, Observation } from './codex.js';
import { createLimitsMonitor } from './limits.js';
import { nameThread } from './title.js';
import { display, metadata, text, compact, summary } from './display.js';
export type Config = { codex: { socketUrl: string }; nats: { servers: string[]; user?: string; password?: string; inboxPrefix?: string }; projects: { projectId: string; name: string; cwd: string; available?: boolean }[]; allowedModels?: string[]; newThread?: { approvalsReviewer?: string | null; model?: string } };
type Session = { view: NativeSnapshot; opened: boolean; fresh: boolean; titleNeeded: boolean; titleRequest: string; naming?: boolean; closing?: boolean; activeModel?: string | null; raw: Map<string, string | number>; revisions: Map<string, number>; details: Map<string, DisplayItem> };
/** Собирает команды и единственного владельца live items/pending. */
export function createApplication(codex: CodexPort, config: Config, emit: (event: EventEnvelope) => void) {
  const sessions = new Map<string, Session>();
  const messageTimes = new Map<string, { updatedAt: number; lastMessageAt: number }>();
  let creating = 0, admission = Promise.resolve();
  let modelCatalog: { generation: string; result: Promise<ModelCatalog> } | undefined;
  const operations = new Map<string, { hash: string; result: Promise<any> }>();
  const openings = new Map<string, Promise<Session>>();
  function fail(code: string, outcome = 'not-sent'): never { throw Object.assign(new Error(code), { code, outcome }); }
  const project = (id?: string) => config.projects.find(p => p.projectId === id && p.available !== false) ?? fail('NOT_FOUND');
  const current = () => codex.status().generation;
  async function catalog(): Promise<ModelCatalog> {
    const generation = current();
    if (!modelCatalog || modelCatalog.generation !== generation) {
      const result = codex.call('model/list', { limit: 100, includeHidden: false }).then(page => {
        if (generation !== current()) fail('STALE_GENERATION', 'query');
        const data = page.data.filter((m: any) => !config.allowedModels || config.allowedModels.includes(m.model)).slice(0, 100).map((m: any) => {
          const inputModalities: string[] = m.inputModalities ?? ['text', 'image'];
          return { model: m.model, name: m.displayName, defaultEffort: m.defaultReasoningEffort, efforts: m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort), inputModalities, imageLimit: inputModalities.includes('image') ? limits.images : 0 };
        });
        return { generation, data, defaultModel: data.find((m: any) => m.model === config.newThread?.model)?.model ?? data[0]?.model ?? null };
      });
      modelCatalog = { generation, result };
      void result.catch(() => { if (modelCatalog?.result === result) modelCatalog = undefined; });
    }
    return modelCatalog.result;
  }
  function publish(s: Session) {
    if (s.view.seq === Number.MAX_SAFE_INTEGER) { s.view.epoch = randomUUID(); s.view.seq = 0; }
    s.view.thread.active = s.view.turn?.status === 'inProgress' && !['connection-lost', 'executor-unavailable'].includes(s.view.state);
    s.view.seq++;
    while (s.view.items.length > 128 || bytes(s.view) > limits.state) {
      const dropped = s.view.items.shift();
      if (!dropped) { s.view.requests = []; s.raw.clear(); s.view.state = 'executor-unavailable'; break; }
      s.revisions.delete(dropped.id);
      s.details.delete(dropped.id);
      s.view.truncated = true;
    }
    emit({ projectId: s.view.projectId, threadId: s.view.threadId, generation: s.view.generation, epoch: s.view.epoch, seq: s.view.seq, event: { type: 'STATE_SNAPSHOT', snapshot: structuredClone(s.view) } });
  }
  function put(s: Session, item: any, turnId: string, timestamp?: number, history = false) {
    const value = display(item, turnId), old = s.view.items.find(i => i.id === value.id);
    value.revision = history ? old?.revision ?? 0 : s.view.seq + 1;
    if (value.type === 'userMessage' || value.type === 'agentMessage') {
      value.timestamp = history ? timestamp ?? old?.timestamp ?? s.view.thread.updatedAt * 1000 : old?.timestamp ?? timestamp ?? Date.now();
      if (!history) s.view.thread.lastMessageAt = Math.max(s.view.thread.lastMessageAt ?? 0, value.timestamp);
    }
    const index = s.view.items.findIndex(old => old.id === value.id);
    if (index < 0) s.view.items.push(compact(value));
    else s.view.items[index] = compact(value);
    s.details.set(value.id, value);
    while (s.details.size > 128) s.details.delete(s.details.keys().next().value!);
    s.revisions.set(value.id, s.view.seq + 1);
  }
  async function detail(s: Session, turnId: string, itemId: string): Promise<DisplayItem> {
    const cached = s.details.get(itemId);
    if (cached?.turnId === turnId && !cached.imageCount) return structuredClone(cached);
    const generation = current(), cut = s.view.seq;
    // AIDEV-NOTE: native anchor исключает сам item; predecessor позволяет прочитать его без сканирования всей истории.
    const previous = await codex.call('thread/items/list', { threadId: s.view.threadId, turnId, limit: 1, sortDirection: 'desc', cursor: { type: 'item', itemId } });
    const predecessor = previous.data[0]?.item.id;
    const page = await codex.call('thread/items/list', { threadId: s.view.threadId, turnId, limit: 1, sortDirection: 'asc', ...(predecessor ? { cursor: { type: 'item', itemId: predecessor } } : {}) });
    if (generation !== current()) fail('STALE_GENERATION', 'query');
    const entry = page.data.find((e: any) => e.item.id === itemId && e.turnId === turnId);
    if (!entry) fail('NOT_FOUND', 'query');
    const newer = s.details.get(itemId);
    if (newer?.turnId === turnId && !newer.imageCount && (s.revisions.get(itemId) ?? 0) > cut) return structuredClone(newer);
    return { ...display(entry.item, turnId, false, true), revision: s.view.items.find(i => i.id === itemId)?.revision ?? 0 };
  }
  async function admit(projectId: string, thread: any, fresh = false): Promise<Session> {
    const previous = admission;
    let release!: () => void;
    admission = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
    if (sessions.size >= limits.threads) {
      const victim = [...sessions.values()].find(s => s.view.turn?.status !== 'inProgress' && !s.view.requests.length && !s.naming);
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
    const view: NativeSnapshot = { projectId, threadId: thread.id, generation: current(), epoch: randomUUID(), seq: 0, thread: { ...metadata(thread), lastMessageAt: messageTimes.get(thread.id)?.lastMessageAt ?? 0 }, turn: null, state: 'idle', items: [], requests: [], truncated: false };
    const s: Session = { view, opened: fresh, fresh, titleNeeded: !thread.name, titleRequest: thread.preview ?? '', raw: new Map(), revisions: new Map(), details: new Map() };
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
      const cut = s.view.seq, previousTurn = s.view.turn;
      const resumed = await codex.call('thread/resume', { threadId: id, cwd: p.cwd, excludeTurns: true }, { mutation: true });
      const turns = await codex.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
      const items = await codex.call('thread/items/list', { threadId: id, limit: 10, sortDirection: 'desc' });
      if (before !== current()) fail('STALE_GENERATION', 'query');
      s.view.thread = { ...metadata(resumed.thread), lastMessageAt: s.view.thread.lastMessageAt, model: resumed.model, reasoningEffort: resumed.reasoningEffort ?? null };
      const latestMessage = items.data.find((entry: any) => ['userMessage', 'agentMessage'].includes(entry.item.type));
      if (latestMessage && s.view.seq === cut) s.view.thread.lastMessageAt = latestMessage.startedAtMs ?? latestMessage.completedAtMs ?? s.view.thread.updatedAt * 1000;
      for (const entry of items.data.slice().reverse()) if ((s.revisions.get(entry.item.id) ?? 0) <= cut) put(s, entry.item, entry.turnId, entry.startedAtMs ?? entry.completedAtMs ?? s.view.thread.updatedAt * 1000, true);
      const pageIds = new Set(items.data.map((entry: any) => entry.item.id));
      s.view.items = [...items.data.slice().reverse().map((entry: any) => s!.view.items.find(item => item.id === entry.item.id)!), ...s.view.items.filter(item => !pageIds.has(item.id) && (s!.revisions.get(item.id) ?? 0) > cut)];
      if (s.view.turn === previousTurn) {
        const turn = turns.data[0];
        s.view.turn = turn ? { id: turn.id, status: turn.status } : null;
        s.view.state = s.view.requests.some(form => !form.answered) ? 'waiting' : turn?.status === 'inProgress' && resumed.thread.status.type !== 'active' ? 'executor-unavailable' : turn?.status ?? 'idle';
      }
      s.opened = true;
      publish(s);
      return s;
    })().finally(() => openings.delete(id));
    openings.set(id, work);
    return work;
  }
  function observe(e: Observation) {
    limitMonitor.observe(e);
    if (e.type === 'connection') {
      operations.clear(); modelCatalog = undefined; messageTimes.clear();
      for (const s of sessions.values()) {
        s.opened = s.fresh = s.closing = false;
        s.raw.clear();
        s.activeModel = undefined;
        s.details.clear();
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
    } else if (e.method === 'thread/name/updated') {
      s.view.thread.title = text(p.threadName ?? '', 512);
      s.titleNeeded = false;
    } else if (e.method === 'turn/started' || e.method === 'turn/completed') {
      s.view.turn = { id: p.turn.id, status: p.turn.status };
      s.view.state = p.turn.status;
      if (p.turn.status !== 'inProgress') { s.activeModel = undefined; s.view.requests = []; s.raw.clear(); }
    } else if (e.method === 'item/started' || e.method === 'item/completed') put(s, p.item, p.turnId);
    else if (e.method?.endsWith('/delta') || e.method?.endsWith('/outputDelta')) {
      const item = s.details.get(p.itemId);
      if (!item) { s.opened = false; s.view.state = 'connection-lost'; }
      else {
        const field = e.method === 'item/agentMessage/delta' ? 'text' : 'output';
        item[field] = text((item[field] ?? '') + p.delta, field === 'text' ? 8192 : 32768);
        item.revision = s.view.seq + 1;
        const index = s.view.items.findIndex(i => i.id === item.id);
        if (index >= 0) s.view.items[index] = compact(item);
        s.revisions.set(item.id, s.view.seq + 1);
      }
    } else if (e.method === 'turn/plan/updated') put(s, { id: `plan:${p.turnId}`, type: 'plan', text: p.plan.map((step: any) => `${step.status}: ${step.step}`).join('\n') }, p.turnId);
    else return;
    if (s.view.requests.some(f => !f.answered)) s.view.state = 'waiting';
    publish(s);
  }
  const limitMonitor = createLimitsMonitor(codex);
  const unsubscribe = codex.subscribe(observe);
  async function execute(r: Command): Promise<any> {
    if (r.action === 'status') return { ...codex.status(), ready: codex.status().connection === 'connected' && codex.status().authorization === 'ready', limits: limitMonitor.snapshot() };
    if (r.action === 'projects') return { generation: current(), projects: config.projects.map(p => ({ projectId: p.projectId, name: p.name, available: p.available !== false })) };
    if (codex.status().connection !== 'connected' || codex.status().authorization !== 'ready') fail('UPSTREAM_UNAVAILABLE', r.operationId ? 'not-sent' : 'query');
    if (r.action === 'models') return catalog();
    const p = project(r.projectId);
    if (r.operationId && r.generation !== current()) fail('STALE_GENERATION');
    if (r.action === 'threads') {
      const generation = current();
      const page = await codex.call('thread/list', { cwd: p.cwd, limit: 100, cursor: r.cursor, sortKey: 'updated_at', sortDirection: 'desc' });
      const threads = page.data.filter((t: any) => t.cwd === p.cwd), data = [];
      for (let offset = 0; offset < threads.length; offset += 4) data.push(...await Promise.all(threads.slice(offset, offset + 4).map(async (thread: any) => {
        const live = sessions.get(thread.id)?.view.thread;
        const cached = messageTimes.get(thread.id);
        let lastMessageAt = cached && cached.updatedAt === thread.updatedAt ? cached.lastMessageAt : undefined;
        if (lastMessageAt === undefined) {
          let cursor: string | undefined;
          lastMessageAt = 0;
          for (let index = 0; index < 10; index++) {
            const items = await codex.call('thread/items/list', { threadId: thread.id, limit: 10, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
            const message = items.data.find((entry: any) => ['userMessage', 'agentMessage'].includes(entry.item.type));
            if (message) { lastMessageAt = message.startedAtMs ?? message.completedAtMs ?? thread.updatedAt * 1000; break; }
            if (!items.nextCursor) break;
            cursor = items.nextCursor;
          }
          if (generation !== current()) fail('STALE_GENERATION', 'query');
          messageTimes.set(thread.id, { updatedAt: thread.updatedAt, lastMessageAt: lastMessageAt! });
          while (messageTimes.size > 1000) messageTimes.delete(messageTimes.keys().next().value!);
        }
        return { ...metadata(thread), lastMessageAt: Math.max(lastMessageAt!, live?.lastMessageAt ?? 0), active: live?.active ?? thread.status?.type === 'active' };
      })));
      if (generation !== current()) fail('STALE_GENERATION', 'query');
      return { generation, data: data.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.id.localeCompare(b.id)), nextCursor: page.nextCursor ?? null };
    }
    if (r.action === 'create') {
      if (sessions.size + creating >= limits.threads) fail('CAPACITY_EXHAUSTED');
      if (r.model && !(await catalog()).data.some(m => m.model === r.model)) fail('UNSUPPORTED');
      if (r.generation !== current()) fail('STALE_GENERATION');
      if (sessions.size + creating >= limits.threads) fail('CAPACITY_EXHAUSTED');
      creating++;
      try {
      const native = await codex.call('thread/start', { cwd: p.cwd, allowProviderModelFallback: false, ...config.newThread, ...permissions(r.permissionMode), ...(r.model ? { model: r.model } : {}) }, { mutation: true });
      if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
      await admit(p.projectId, { ...native.thread, model: native.model }, true);
      if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
      return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: native.thread.id };
      } finally { creating--; }
    }
    const s = await open(r);
    if (r.action === 'open') return structuredClone(s.view);
    if (r.action === 'activities' || r.action === 'item') {
      const generation = current();
      const data: DisplayItem[] = [];
      const ids = r.action === 'item' ? [r.itemId!] : r.itemIds!;
      for (let offset = 0; offset < ids.length; offset += 4) data.push(...await Promise.all(ids.slice(offset, offset + 4).map(id => detail(s, r.turnId!, id))));
      if (generation !== current()) fail('STALE_GENERATION', 'query');
      return r.action === 'item' ? { generation, item: data[0] } : { generation, data: data.map(summary) };
    }
    if (r.action === 'items' || r.action === 'turns') {
      if (s.fresh) return { generation: current(), data: [], nextCursor: null };
      const generation = current();
      const page: { data: any[]; nextCursor?: string | null } = { data: [], nextCursor: r.cursor };
      let messages = 0;
      do {
        // AIDEV-NOTE: Действия не расходуют десять сообщений; малые native страницы сохраняют предел media-кадра.
        const part = await codex.call(r.action === 'items' ? 'thread/items/list' : 'thread/turns/list', { threadId: r.threadId, limit: r.action === 'items' ? Math.min(10 - messages, 1000 - page.data.length) : 100, cursor: page.nextCursor, sortDirection: 'desc', ...(r.action === 'items' ? { turnId: r.turnId } : { itemsView: 'notLoaded' }) });
        if (generation !== current()) fail('STALE_GENERATION', 'query');
        if (part.nextCursor && (!part.data.length || part.nextCursor === page.nextCursor)) fail('UPSTREAM_UNAVAILABLE', 'query');
        messages += part.data.filter((e: any) => e.item?.type === 'userMessage' || e.item?.type === 'agentMessage').length;
        page.data.push(...(r.action === 'items' ? part.data.map((e: any) => {
          const revision = s.view.items.find(i => i.id === e.item.id)?.revision ?? 0;
          if (e.item.type !== 'userMessage' && e.item.type !== 'agentMessage') return { id: e.item.id, turnId: e.turnId, type: e.item.type, text: '', revision, ...(typeof e.item.status === 'string' ? { status: e.item.status } : {}), ...(Object.hasOwn(e.item, 'exitCode') ? { exitCode: e.item.exitCode } : {}) };
          return { ...display(e.item, e.turnId, true), revision, timestamp: e.startedAtMs ?? e.completedAtMs ?? s.view.thread.updatedAt * 1000 };
        }) : part.data.map((t: any) => ({ id: t.id, status: t.status }))));
        page.nextCursor = part.nextCursor ?? null;
      } while (r.action === 'items' && page.nextCursor && messages < 10 && page.data.length < 1000);
      return { generation, data: r.action === 'items' ? page.data.reverse() : page.data, nextCursor: page.nextCursor };
    }
    if (r.generation !== current()) fail('STALE_GENERATION');
    if (s.closing) fail('CAPACITY_EXHAUSTED');
    const active = s.view.turn?.status === 'inProgress';
    if (r.action === 'start' && (active || s.view.thread.canAcceptDirectInput === false)) fail('OPERATION_CONFLICT');
    if ((r.action === 'steer' || r.action === 'interrupt') && (!active || s.view.turn?.id !== (r.expectedTurnId ?? r.turnId))) fail('OPERATION_CONFLICT');
    if (r.action === 'start' && [...sessions.values()].filter(s => s.view.turn?.status === 'inProgress').length >= 4) fail('CAPACITY_EXHAUSTED');
    if (r.action === 'start' || r.action === 'steer' && r.images?.length) {
      const model = r.action === 'steer' ? s.activeModel ?? s.view.thread.model : r.model ?? s.view.thread.model;
      if (config.allowedModels && !config.allowedModels.includes(model ?? '')) fail('UNSUPPORTED');
      if (r.model || r.effort || r.images?.length) {
        const choice = (await catalog()).data.find(m => m.model === model);
        if (!choice || (r.effort && !choice.efforts.includes(r.effort)) || (r.images?.length && choice.imageLimit === 0)) fail('UNSUPPORTED');
      }
    }
    if (r.generation !== current()) fail('STALE_GENERATION');
    if (r.action === 'start' && (s.closing || s.view.turn?.status === 'inProgress' || [...sessions.values()].filter(value => value.view.turn?.status === 'inProgress').length >= 4)) fail('OPERATION_CONFLICT');
    if (r.action === 'steer' && (s.closing || s.view.turn?.status !== 'inProgress' || s.view.turn.id !== r.expectedTurnId)) fail('OPERATION_CONFLICT');
    const previousTurn = s.view.turn, previousState = s.view.state, previousModel = s.activeModel;
    if (r.action === 'start') { s.activeModel = r.model ?? s.view.thread.model; s.view.turn = { id: 'starting', status: 'inProgress' }; s.view.state = 'inProgress'; publish(s); }
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
      const input = [...(r.text?.trim() ? [{ type: 'text', text: r.text }] : []), ...(r.images ?? []).map(url => ({ type: 'image', url }))];
      const params = { threadId: r.threadId, input, ...(r.action === 'steer' ? { expectedTurnId: r.expectedTurnId } : { ...permissions(r.permissionMode, p.cwd), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) }) };
      let value: any;
      try { value = await codex.call(r.action === 'steer' ? 'turn/steer' : 'turn/start', params, { mutation: true }); }
      catch (error: any) { if (r.action === 'start' && error.outcome === 'not-sent' && r.generation === current() && s.view.turn?.id === 'starting') { s.view.turn = previousTurn; s.view.state = previousState; s.activeModel = previousModel; publish(s); } throw error; }
      turnId = value.turn?.id ?? value.turnId;
      if (r.action === 'start' && s.view.turn?.id === 'starting') { s.view.turn = { id: turnId!, status: value.turn.status }; publish(s); }
      if (r.action === 'start') { s.view.thread.model = r.model ?? s.view.thread.model; s.view.thread.reasoningEffort = r.effort ?? s.view.thread.reasoningEffort ?? null; publish(s); }
      s.fresh = false;
    }
    if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
    if (r.action === 'start' && s.titleNeeded && !s.naming && (!config.allowedModels || config.allowedModels.includes('gpt-6-luna'))) {
      s.titleNeeded = false; s.naming = true;
      // AIDEV-NOTE: Preview принадлежит первому заданию; восстановленный чат называем по нему, а не по продолжению.
      s.titleRequest = s.titleRequest.trim() || r.text?.trim() || 'Проанализировать присланные изображения';
      void nameThread(codex, r.threadId!, s.titleRequest).catch((error: any) => {
        s.titleNeeded = true;
        console.error('agent: TITLE_GENERATION_FAILED', { stage: error.titleStage, code: error.code, upstreamCode: error.upstreamCode, nativeCode: error.nativeCode });
      }).finally(() => { s.naming = false; });
    }
    return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: r.threadId, turnId, ...(r.requestId ? { requestId: r.requestId } : {}) };
  }
  /** Повтор того же operation ID возвращает исходный результат без native вызова. */
  async function request(r: Command): Promise<any> {
    if (!validateCommand(r)) fail('INVALID_ARGUMENT');
    if (r.images?.length && !validImages(r.images)) fail('INVALID_ARGUMENT');
    if (!r.operationId) return execute(r);
    if (r.generation !== current()) fail('STALE_GENERATION');
    const hash = commandHash(r), old = operations.get(r.operationId);
    if (old) return old.hash === hash ? old.result : fail('OPERATION_CONFLICT');
    if (operations.size >= limits.operations) fail('CAPACITY_EXHAUSTED');
    const result = Promise.resolve().then(() => execute(r));
    operations.set(r.operationId, { hash, result });
    return result;
  }
  return { request, close() { unsubscribe(); limitMonitor.close(); } };
}
/** Хеширует полную команду; ledger сохраняет digest и результат, без raw media. */
function commandHash(command: Command): string {
  const canonical = JSON.stringify(command, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHash('sha256').update(canonical).digest('hex');
}
/** Проверяет суммарные decoded bytes и сигнатуру MIME до открытия/изменения хода. */
function validImages(images: string[]): boolean {
  let total = 0;
  return images.every(image => {
    const comma = image.indexOf(','), mime = image.slice(5, image.indexOf(';'));
    const encoded = image.slice(comma + 1);
    total += encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (total > limits.imageBytes) return false;
    const data = Buffer.from(encoded, 'base64');
    if (mime === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mime === 'image/jpeg') return data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
    return mime === 'image/webp' && data.length >= 12 && data.subarray(0, 4).equals(Buffer.from('RIFF')) && data.subarray(8, 12).equals(Buffer.from('WEBP'));
  });
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

/** Три явных native режима; отсутствие выбора означает risk-based auto_review. */
function permissions(mode = 'auto', cwd?: string) {
  const full = mode === 'full';
  return { approvalPolicy: full ? 'never' : 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', ...(cwd ? { sandboxPolicy: full ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false } } : { sandbox: full ? 'danger-full-access' : 'workspace-write' }) };
}

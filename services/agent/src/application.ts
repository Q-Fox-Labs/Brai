// ABOUTME: Управляет native чатами, ходами и формами через один CodexPort.
// ABOUTME: Владеет только bounded live проекцией; историю читает у Codex.
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { bytes, limits, rpcTimeouts, validateCommand } from '../contracts/index.mjs';
import type { Command, EventEnvelope, NativeSnapshot, PendingRequest, NativeTurn, ModelCatalog, DisplayItem, GoalProjection, PlanProgress } from '../contracts/index.mjs';
import type { CodexPort, Observation } from './codex.js';
import { createAttachments, type ArtifactsConfig, type ArtifactsPort, type NatsConfig } from './attachments.js';
import { createResults } from './results.js';
import { createLimitsMonitor } from './limits.js';
import type { ReadStatePort } from './read-state.js';
import { nameThread } from './title.js';
import { display, messagePage, metadata, text, compact, summary, messageAttention, goal, progress } from './display.js';
import { asyncQuestionMethod, asyncQuestionRequest, asyncQuestionReply, asyncReplyIds } from './async-questions.js';
export type Config = { readStatePath?: string; ownerId?: string; artifacts?: ArtifactsConfig; codex: { socketUrl: string }; nats: NatsConfig; projects: { projectId: string; name: string; cwd: string; available?: boolean }[]; allowedModels?: string[]; newThread?: { approvalsReviewer?: string | null; model?: string } };
type Session = { answering: Set<string>; attention: ReturnType<typeof messageAttention>; view: NativeSnapshot & { goal: GoalProjection; planProgress: PlanProgress }; mutating?: boolean; goalRevision: number; opened: boolean; fresh: boolean; titleNeeded: boolean; titleRequest: string; naming?: boolean; closing?: boolean; activeModel?: string | null; raw: Map<string, string | number>; revisions: Map<string, number>; details: Map<string, DisplayItem> };
function pendingRequest(request: PendingRequest) { return request.kind !== 'unsupported' && !request.answered; }
function projectTurn(turn: any): NativeTurn {
  const info = turn.error?.codexErrorInfo;
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const message = typeof turn.error?.message === 'string' ? text(turn.error.message, 2048) : '';
  return { id: turn.id, status: turn.status, ...(message ? { error: { message, ...(code ? { code } : {}) } } : {}) };
}
/** Собирает команды и единственного владельца live items/pending. */
export function createApplication(codex: CodexPort, config: Config, emit: (event: EventEnvelope) => void, artifactsPort?: ArtifactsPort, resultsPort: ArtifactsPort | undefined = artifactsPort, readState?: ReadStatePort) {
  const attachments = createAttachments(codex, config.artifacts, artifactsPort);
  const results = createResults(codex, config.artifacts, config.ownerId, resultsPort);
  const decorate = async (r: Command, items: DisplayItem[], deadline?: number) => results.decorate(r, await attachments.decorate(r, items, deadline), deadline);
  const sessions = new Map<string, Session>();
  const messageTimes = new Map<string, { updatedAt: number; lastMessageAt: number; finalMessageId: string | null; awaitingReply: boolean; pendingForm: boolean }>();
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
    s.view.thread.active = (s.view.turn?.status === 'inProgress' || s.view.goal.state === 'ready' && s.view.goal.value?.status === 'active') && !['connection-lost', 'executor-unavailable'].includes(s.view.state);
    const latestMessage = [...s.view.items].reverse().find(item => item.type === 'userMessage' || item.type === 'agentMessage');
    if (latestMessage) s.attention = messageAttention(latestMessage);
    Object.assign(s.view.thread, s.attention);
    s.view.thread.awaitingReply = s.view.requests.some(pendingRequest) || (!s.view.thread.active && s.attention.awaitingReply);
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
    const question = asyncQuestionRequest(item, turnId);
    if (question && !s.view.requests.some(request => request.requestId === question.requestId)) {
      if (s.view.requests.length >= limits.pending) {
        const resolved = s.view.requests.findIndex(request => request.answered || request.kind === 'unsupported');
        if (resolved >= 0) s.view.requests.splice(resolved, 1);
      }
      if (s.view.requests.length < limits.pending) s.view.requests.push(question);
    }
    // AIDEV-NOTE: Reply может прийти live раньше чтения исторического исходного вопроса.
    const replied = new Set([...asyncReplyIds(item), ...s.view.items.flatMap(asyncReplyIds)]);
    for (const request of s.view.requests) if (request.kind === 'question' && request.method === asyncQuestionMethod && !request.answered && replied.size) {
      const remaining = request.params.questions.filter((question: any) => !replied.has(question.id));
      if (!remaining.length) request.answered = true;
      else request.params.questions = remaining;
    }
    const resultCount = results.count(item);
    const value = display(item, turnId), old = s.view.items.find(i => i.id === value.id);
    if (resultCount) value.resultCount = resultCount;
    value.revision = history ? old?.revision ?? 0 : s.view.seq + 1;
    if (value.type === 'userMessage' || value.type === 'agentMessage') {
      value.timestamp = history ? timestamp ?? old?.timestamp ?? s.view.thread.updatedAt * 1000 : old?.timestamp ?? timestamp ?? Date.now();
      s.attention = messageAttention(value);
      Object.assign(s.view.thread, s.attention);
      if (!history) s.view.thread.lastMessageAt = Math.max(s.view.thread.lastMessageAt ?? 0, value.timestamp);
    }
    const index = s.view.items.findIndex(old => old.id === value.id);
    if (index < 0) s.view.items.push(compact(value));
    else s.view.items[index] = compact(value);
    s.details.set(value.id, value);
    while (s.details.size > 128) s.details.delete(s.details.keys().next().value!);
    s.revisions.set(value.id, s.view.seq + 1);
  }
  async function detail(s: Session, turnId: string, itemId: string, fullMessage = false, cursor?: string, ownerId?: string, deadline?: number): Promise<{ item: DisplayItem; nextCursor?: string | null }> {
    const cached = s.details.get(itemId);
    if (cached?.turnId === turnId && !cached.imageCount && !cursor && !(fullMessage && cached.truncated && ['userMessage', 'agentMessage'].includes(cached.type))) return { item: structuredClone(cached) };
    const generation = current(), cut = s.view.seq;
    // AIDEV-NOTE: native anchor исключает сам item; predecessor позволяет прочитать его без сканирования всей истории.
    const previous = await codex.call('thread/items/list', { threadId: s.view.threadId, turnId, limit: 1, sortDirection: 'desc', cursor: { type: 'item', itemId } });
    const predecessor = previous.data[0]?.item.id;
    const page = await codex.call('thread/items/list', { threadId: s.view.threadId, turnId, limit: 1, sortDirection: 'asc', ...(predecessor ? { cursor: { type: 'item', itemId: predecessor } } : {}) });
    if (generation !== current()) fail('STALE_GENERATION', 'query');
    const entry = page.data.find((e: any) => e.item.id === itemId && e.turnId === turnId);
    if (!entry) fail('NOT_FOUND', 'query');
    results.trackItems({ action: 'item', projectId: s.view.projectId, threadId: s.view.threadId }, [entry]);
    const newer = s.details.get(itemId);
    if (newer?.turnId === turnId && !newer.imageCount && !cursor && !(fullMessage && newer.truncated && ['userMessage', 'agentMessage'].includes(newer.type)) && (s.revisions.get(itemId) ?? 0) > cut) return { item: structuredClone(newer) };
    await attachments.recoverItems({ action: 'item', projectId: s.view.projectId, threadId: s.view.threadId, ownerId }, [entry], deadline);
    const native = historyItem(entry, s.view.turn), revision = s.view.items.find(i => i.id === itemId)?.revision ?? 0;
    if (fullMessage && ['userMessage', 'agentMessage'].includes(native.type)) {
      const page = messagePage(native, turnId, cursor);
      const resultCount = results.count(native); if (resultCount) page.item.resultCount = resultCount;
      page.item.revision = revision;
      return page;
    }
    if (cursor) fail('INVALID_ARGUMENT', 'query');
    const resultCount = results.count(native);
    return { item: { ...display(native, turnId), revision, ...(resultCount ? { resultCount } : {}) } };
  }
  async function admit(projectId: string, thread: any, fresh = false): Promise<Session> {
    const previous = admission;
    let release!: () => void;
    admission = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
    if (sessions.size >= limits.threads) {
      const victim = [...sessions.values()].find(s => s.view.turn?.status !== 'inProgress' && !s.view.requests.some(pendingRequest) && !s.naming && !s.mutating && s.view.goal.value?.status !== 'active');
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
    const view: Session['view'] = { projectId, threadId: thread.id, generation: current(), epoch: randomUUID(), seq: 0, thread: { ...metadata(thread), lastMessageAt: messageTimes.get(thread.id)?.lastMessageAt ?? 0 }, turn: null, state: 'idle', items: [], requests: [], truncated: false, goal: { state: fresh ? 'ready' : 'unavailable', value: null }, planProgress: { state: 'unavailable', turnId: null, explanation: null, steps: [], truncated: false } };
    const s: Session = { answering: new Set(), attention: { finalMessageId: null, awaitingReply: false }, goalRevision: 0, view, opened: fresh, fresh, titleNeeded: !thread.name, titleRequest: thread.preview ?? '', raw: new Map(), revisions: new Map(), details: new Map() };
    sessions.set(thread.id, s);
    return s;
    } finally { release(); }
  }
  async function open(r: Command, deadline?: number): Promise<Session> {
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
      await readGoal(s);
      const turns = await codex.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
      const items: { data: any[]; nextCursor?: string | null } = { data: [] };
      let messages = 0;
      do {
        const part = await codex.call('thread/items/list', { threadId: id, limit: Math.min(10, 1000 - items.data.length), sortDirection: 'desc', ...(items.nextCursor ? { cursor: items.nextCursor } : {}) });
        if (part.nextCursor && (!part.data.length || part.nextCursor === items.nextCursor)) break;
        items.data.push(...part.data); items.nextCursor = part.nextCursor;
        messages += part.data.filter((entry: any) => ['userMessage', 'agentMessage'].includes(entry.item.type)).length;
        // AIDEV-NOTE: Десять действий после async вопроса не должны скрыть карточку при восстановлении.
      } while (items.nextCursor && messages < 10 && items.data.length < 1000 && bytes(items) < limits.state);
      if (before !== current()) fail('STALE_GENERATION', 'query');
      results.trackItems(r, items.data);
      s.view.thread = { ...metadata(resumed.thread), lastMessageAt: s.view.thread.lastMessageAt, model: resumed.model, reasoningEffort: resumed.reasoningEffort ?? null };
      const latestMessage = items.data.find((entry: any) => ['userMessage', 'agentMessage'].includes(entry.item.type));
      if (latestMessage) s.view.thread.lastMessageAt = Math.max(s.view.thread.lastMessageAt ?? 0, latestMessage.startedAtMs ?? latestMessage.completedAtMs ?? s.view.thread.updatedAt * 1000);
      for (const entry of items.data.slice().reverse()) if ((s.revisions.get(entry.item.id) ?? 0) <= cut) put(s, historyItem(entry, turns.data[0]), entry.turnId, entry.startedAtMs ?? entry.completedAtMs ?? s.view.thread.updatedAt * 1000, true);
      await attachments.recoverItems(r, items.data, deadline);
      const pageIds = new Set(items.data.map((entry: any) => entry.item.id));
      s.view.items = [...items.data.slice().reverse().map((entry: any) => s!.view.items.find(item => item.id === entry.item.id)!), ...s.view.items.filter(item => !pageIds.has(item.id) && (s!.revisions.get(item.id) ?? 0) > cut)];
      if (s.view.turn === previousTurn) {
        const turn = turns.data[0];
        s.view.turn = turn ? projectTurn(turn) : null;
        s.view.state = s.view.requests.some(pendingRequest) ? 'waiting' : turn?.status === 'inProgress' && resumed.thread.status.type !== 'active' ? 'executor-unavailable' : turn?.status ?? 'idle';
      }
      s.opened = true;
      publish(s);
      return s;
    })().finally(() => openings.delete(id));
    openings.set(id, work);
    return work;
  }
  async function readGoal(s: Session): Promise<void> {
    const generation = current(), revision = s.goalRevision;
    try {
      const result = await codex.call('thread/goal/get', { threadId: s.view.threadId });
      if (generation !== current()) fail('STALE_GENERATION', 'query');
      if (revision === s.goalRevision) s.view.goal = { state: 'ready', value: goal(result.goal) };
    } catch (error: any) {
      if (generation !== current()) fail('STALE_GENERATION', 'query');
      if (revision === s.goalRevision) s.view.goal.state = s.view.goal.value ? 'stale' : 'unavailable';
    }
  }
  async function mutation<T>(s: Session, r: Command, work: (call: (method: string, params: any) => Promise<any>) => Promise<T>): Promise<T> {
    if (s.mutating) fail('OPERATION_CONFLICT');
    s.mutating = true;
    let affected = false;
    try {
      return await work(async (method, params) => {
        if (r.generation !== current()) fail('STALE_GENERATION', affected ? 'unknown' : 'not-sent');
        const result = await codex.call(method, params, { mutation: true });
        affected = true;
        if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
        return result;
      });
    } catch (error: any) {
      // AIDEV-NOTE: Принятый первый этап нельзя повторять, даже если второй этап точно не отправлен.
      if (affected && error.outcome !== 'unknown') error.outcome = 'unknown';
      if (error.outcome === 'unknown') { s.opened = s.fresh = false; s.view.goal.state = s.view.goal.value ? 'stale' : 'unavailable'; publish(s); }
      throw error;
    } finally { s.mutating = false; }
  }
  async function changeGoal(s: Session, params: any, call: (method: string, params: any) => Promise<any>) {
    const revision = s.goalRevision;
    const result = await call('thread/goal/set', params);
    if (s.goalRevision === revision) s.view.goal = { state: 'ready', value: goal(result.goal) };
    s.fresh = false;
    publish(s);
  }
  async function stopGoalTurn(s: Session, call: (method: string, params: any) => Promise<any>) {
    const turn = s.view.turn;
    if (turn?.status === 'inProgress' && turn.id !== 'starting') await call('turn/interrupt', { threadId: s.view.threadId, turnId: turn.id });
  }
  async function validateGoalModel(s: Session) {
    const model = s.view.thread.model, effort = s.view.thread.reasoningEffort;
    if (!model || config.allowedModels && !config.allowedModels.includes(model)) fail('UNSUPPORTED');
    const choice = (await catalog()).data.find(m => m.model === model);
    if (!choice || effort && !choice.efforts.includes(effort)) fail('UNSUPPORTED');
  }
  function title(s: Session, r: Command) {
    if (!s.titleNeeded || s.naming || config.allowedModels && !config.allowedModels.includes('gpt-6-luna')) return;
    s.titleNeeded = false; s.naming = true;
    // AIDEV-NOTE: Preview принадлежит первому заданию, включая задание новой цели.
    s.titleRequest = s.titleRequest.trim() || r.text?.trim() || 'Проанализировать присланные изображения';
    void nameThread(codex, r.threadId!, s.titleRequest).catch((error: any) => {
      s.titleNeeded = true;
      console.error('agent: TITLE_GENERATION_FAILED', { stage: error.titleStage, code: error.code, upstreamCode: error.upstreamCode, nativeCode: error.nativeCode });
    }).finally(() => { s.naming = false; });
  }
  function observe(e: Observation) {
    limitMonitor.observe(e);
    if (e.type === 'connection') {
      operations.clear(); modelCatalog = undefined; messageTimes.clear();
      for (const s of sessions.values()) {
        s.opened = s.fresh = s.closing = false;
        s.raw.clear();
        s.answering = new Set();
        s.activeModel = undefined;
        s.details.clear();
        s.view.requests = s.view.requests.filter(request => request.kind === 'unsupported');
        s.view.generation = current();
        s.view.epoch = randomUUID();
        s.view.state = 'connection-lost';
        s.view.contextUsage = null;
        s.view.goal.state = s.view.goal.value ? 'stale' : 'unavailable';
        if (s.view.planProgress.state === 'live') s.view.planProgress.state = 'stale';
        publish(s);
      }
      return;
    }
    const p = e.params, s = sessions.get(p?.threadId);
    if (!s) return;
    if (e.type === 'request') {
      const requestId = typeof e.id + ':' + e.id, kinds: Record<string, PendingRequest['kind']> = { 'item/commandExecution/requestApproval': 'command-approval', 'item/fileChange/requestApproval': 'file-change-approval', 'item/permissions/requestApproval': 'permissions', 'item/tool/requestUserInput': 'question' };
      if (s.view.requests.some(f => f.requestId === requestId)) return;
      const kind = kinds[e.method!], pendingCount = s.view.requests.filter(pendingRequest).length;
      const reason = e.reason ?? (!kind ? 'unsupported-method' : pendingCount >= limits.pending ? 'too-many-pending' : bytes(s.view.requests) + bytes(p) >= 131072 ? 'presentation-limit' : undefined);
      const supported = e.supported === true && !reason;
      if (!supported) {
        const rejection = reason ?? 'unsupported-method';
        // AIDEV-NOTE: Другой клиент общего backend может представить запрос и ответить на него.
        if (s.view.requests.length >= limits.pending) {
          const oldestNotice = s.view.requests.findIndex(request => request.kind === 'unsupported');
          if (oldestNotice >= 0) s.view.requests.splice(oldestNotice, 1);
          else { s.view.state = 'executor-unavailable'; publish(s); return; }
        }
        const turnId = typeof p?.turnId === 'string' && p.turnId ? text(p.turnId, 128) : 'unknown';
        const metadata = e.method === 'item/tool/call' ? {
          ...(typeof p?.tool === 'string' ? { tool: p.tool } : {}),
          ...(typeof p?.namespace === 'string' ? { namespace: p.namespace } : {}),
        } : {};
        s.view.requests.push({ requestId, turnId, method: e.method!, kind: 'unsupported', params: metadata, answered: false, reason: rejection });
      } else {
        s.view.requests.push({ requestId, turnId: p.turnId, method: e.method!, kind: kind!, params: p, answered: false });
        s.raw.set(requestId, e.id!);
      }
    } else if (e.method === 'serverRequest/resolved') {
      const id = typeof p.requestId + ':' + p.requestId;
      s.view.requests = s.view.requests.filter(f => f.requestId !== id);
      s.raw.delete(id);
    } else if (e.method === 'thread/name/updated') {
      s.view.thread.title = text(p.threadName ?? '', 512);
      s.titleNeeded = false;
    } else if (e.method === 'thread/goal/updated' || e.method === 'thread/goal/cleared') {
      s.goalRevision++;
      s.view.goal = { state: 'ready', value: e.method === 'thread/goal/cleared' ? null : goal(p.goal) };
    } else if (e.method === 'thread/tokenUsage/updated') {
      const usedTokens = p.tokenUsage?.last?.totalTokens, contextWindow = p.tokenUsage?.modelContextWindow;
      // AIDEV-NOTE: total — стоимость всей истории; last — размер последнего контекста с ответом.
      s.view.contextUsage = Number.isSafeInteger(usedTokens) && usedTokens >= 0
        ? { usedTokens, contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : null } : null;
    } else if (e.method === 'thread/settings/updated') {
      s.view.thread.model = p.threadSettings.model;
      s.view.thread.reasoningEffort = p.threadSettings.effort ?? null;
    } else if (e.method === 'turn/started' || e.method === 'turn/completed') {
      s.view.turn = projectTurn(p.turn);
      s.view.state = p.turn.status;
      if (e.method === 'turn/started') s.fresh = false;
      if (e.method === 'turn/started' && s.view.planProgress.turnId !== p.turn.id) s.view.planProgress = { state: 'unavailable', turnId: p.turn.id, explanation: null, steps: [], truncated: false };
      if (p.turn.status !== 'inProgress') { s.activeModel = undefined; s.view.requests = s.view.requests.filter(request => request.kind === 'unsupported' || request.method === asyncQuestionMethod); s.raw.clear(); }
    } else if (e.method === 'item/started' || e.method === 'item/completed') {
      if (e.method === 'item/completed' && p.item.type === 'agentMessage') void results.recoverItems({ action: 'items', projectId: s.view.projectId, threadId: s.view.threadId }, [{ item: p.item, turnId: p.turnId, completedAtMs: Date.now() }]);
      put(s, p.item.type === 'plan' ? { ...p.item, status: e.method === 'item/completed' ? 'completed' : 'inProgress' } : p.item, p.turnId);
    }
    else if (e.method?.endsWith('/delta') || e.method?.endsWith('/outputDelta')) {
      const item = s.details.get(p.itemId);
      if (!item) { s.opened = false; s.view.state = 'connection-lost'; }
      else {
        const field = e.method === 'item/agentMessage/delta' || e.method === 'item/plan/delta' ? 'text' : 'output';
        const cap = item.type === 'plan' || field === 'output' ? 32768 : 8192;
        const combined = (item[field] ?? '') + p.delta;
        item[field] = text(combined, cap);
        item.truncated = item.truncated || Buffer.byteLength(combined) > cap;
        if (item.type === 'plan') item.status = 'inProgress';
        item.revision = s.view.seq + 1;
        const index = s.view.items.findIndex(i => i.id === item.id);
        if (index >= 0) s.view.items[index] = compact(item);
        s.revisions.set(item.id, s.view.seq + 1);
      }
    } else if (e.method === 'turn/plan/updated') s.view.planProgress = progress(p);
    else return;
    if (s.view.requests.some(pendingRequest)) s.view.state = 'waiting';
    else if (s.view.state === 'waiting') s.view.state = s.view.turn?.status ?? 'idle';
    publish(s);
  }
  const limitMonitor = createLimitsMonitor(codex);
  const unsubscribe = codex.subscribe(observe);
  async function execute(r: Command, deadline?: number): Promise<any> {
    if (r.action === 'readState' || r.action === 'readMark') {
      if (!config.ownerId || r.ownerId !== config.ownerId) fail('INVALID_ARGUMENT', r.action === 'readState' ? 'query' : 'not-sent');
      if (!readState) fail('UNSUPPORTED', r.action === 'readState' ? 'query' : 'not-sent');
      if (r.action === 'readState') return readState.read(r.ownerId!);
      project(r.projectId);
      return readState.mark({ ownerId: r.ownerId!, projectId: r.projectId!, threadId: r.threadId!, messageId: r.messageId!, lastMessageAt: r.lastMessageAt! });
    }
    if (r.action === 'status') return { ...codex.status(), ready: codex.status().connection === 'connected' && codex.status().authorization === 'ready', limits: limitMonitor.snapshot() };
    if (r.action === 'projects') return { generation: current(), projects: config.projects.map(p => ({ projectId: p.projectId, name: p.name, available: p.available !== false })) };
    if (codex.status().connection !== 'connected' || codex.status().authorization !== 'ready') fail('UPSTREAM_UNAVAILABLE', r.operationId ? 'not-sent' : 'query');
    if (r.action === 'models') return catalog();
    const p = project(r.projectId);
    if (r.operationId && r.generation !== current()) fail('STALE_GENERATION');
    if (r.action === 'threads') {
      const generation = current();
      // AIDEV-NOTE: Список и необязательное чтение metadata должны уместиться в web deadline 10 секунд.
      const page = await codex.call('thread/list', { cwd: p.cwd, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], limit: 100, cursor: r.cursor, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true }, { timeoutMs: 4000 });
      const deadline = performance.now() + 4000;
      const threads = page.data.filter((t: any) => t.cwd === p.cwd), data = [];
      for (let offset = 0; offset < threads.length; offset += 4) data.push(...await Promise.all(threads.slice(offset, offset + 4).map(async (thread: any) => {
        const live = sessions.get(thread.id)?.view.thread;
        const cached = messageTimes.get(thread.id);
        let lastMessageAt = cached?.lastMessageAt ?? 0;
        let attention = { finalMessageId: cached?.finalMessageId ?? null, awaitingReply: cached?.awaitingReply ?? false };
        let pendingForm = cached?.pendingForm ?? false;
        if ((!cached || cached.updatedAt !== thread.updatedAt) && performance.now() < deadline) {
          try {
            let cursor: string | undefined;
            let readTime = 0, readAttention = { finalMessageId: null as string | null, awaitingReply: false };
            for (let index = 0; index < 10; index++) {
              const remaining = Math.floor(deadline - performance.now());
              if (remaining <= 0) fail('TIMEOUT', 'query');
              const items = await codex.call('thread/items/list', { threadId: thread.id, limit: 10, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }, { timeoutMs: Math.min(1000, remaining) });
              const message = items.data.find((entry: any) => ['userMessage', 'agentMessage'].includes(entry.item.type));
              if (message) {
                readAttention = messageAttention(display(message.item, message.turnId));
                pendingForm = Boolean(asyncQuestionRequest(message.item, message.turnId));
                readTime = message.startedAtMs ?? message.completedAtMs ?? thread.updatedAt * 1000;
                break;
              }
              if (!items.nextCursor) break;
              cursor = items.nextCursor;
            }
            if (generation !== current()) fail('STALE_GENERATION', 'query');
            lastMessageAt = readTime; attention = readAttention;
            messageTimes.set(thread.id, { updatedAt: thread.updatedAt, lastMessageAt, ...attention, pendingForm });
            while (messageTimes.size > 1000) messageTimes.delete(messageTimes.keys().next().value!);
          } catch {
            // AIDEV-NOTE: Сбой истории одного чата не скрывает список; не кэшируем неудачу как успешное чтение.
          }
        }
        const approvalPending = thread.status?.activeFlags?.includes('waitingOnApproval') ?? false;
        return { ...metadata(thread), ...attention, awaitingReply: approvalPending || pendingForm || (thread.status?.type !== 'active' && attention.awaitingReply), ...(live ? { finalMessageId: live.finalMessageId, awaitingReply: live.awaitingReply } : {}), lastMessageAt: Math.max(lastMessageAt, live?.lastMessageAt ?? 0), active: live?.active ?? thread.status?.type === 'active' };
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
    if (r.action === 'archive') {
      // AIDEV-NOTE: До первого хода native read может отказать; свежий чат уже проверен при admit.
      const known = sessions.get(r.threadId!);
      if (known) { if (known.view.projectId !== p.projectId) fail('INVALID_ARGUMENT'); }
      else {
        const native = await codex.call('thread/read', { threadId: r.threadId, includeTurns: false });
        if (native.thread.cwd !== p.cwd) fail('INVALID_ARGUMENT');
      }
      if (r.generation !== current()) fail('STALE_GENERATION');
      await codex.call('thread/archive', { threadId: r.threadId }, { mutation: true });
      if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
      sessions.delete(r.threadId!); messageTimes.delete(r.threadId!);
      return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: r.threadId };
    }
    const s = await open(r, deadline);
    const buildInput = (images: { type: string; url: string }[]) => ({ threadId: r.threadId, input: [...(r.text?.trim() ? [{ type: 'text', text: r.text }] : []), ...images], clientUserMessageId: attachments.clientId(r), ...(r.action === 'steer' ? { expectedTurnId: r.expectedTurnId } : { ...permissions(r.permissionMode, p.cwd), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), collaborationMode: collaboration(r.agentMode === 'plan' ? 'plan' : 'default', r.model ?? s.view.thread.model ?? config.newThread?.model ?? '', r.effort ?? s.view.thread.reasoningEffort) }) });
    const durableInput = Boolean(config.artifacts && ['start', 'steer'].includes(r.action) && r.agentMode !== 'goal');
    if (durableInput || r.attachments?.length) {
      if (!r.ownerId) fail('INVALID_ARGUMENT');
      const existing = await attachments.existing(r, buildInput); if (existing) return existing;
    }
    if (r.action === 'open') { const view = structuredClone(s.view); view.items = await decorate(r, view.items, deadline); return view; }
    if (r.action === 'goalGet') { await readGoal(s); publish(s); return { generation: current(), goal: structuredClone(s.view.goal) }; }
    if (r.action === 'activities' || r.action === 'item') {
      const generation = current();
      const pages: { item: DisplayItem; nextCursor?: string | null }[] = [];
      const ids = r.action === 'item' ? [r.itemId!] : r.itemIds!;
      for (let offset = 0; offset < ids.length; offset += 4) pages.push(...await Promise.all(ids.slice(offset, offset + 4).map(id => detail(s, r.turnId!, id, r.action === 'item', r.cursor, r.ownerId, deadline))));
      if (generation !== current()) fail('STALE_GENERATION', 'query');
      const decorated = await decorate(r, pages.map(page => page.item), deadline);
      return r.action === 'item' ? { generation, ...pages[0], item: decorated[0] } : { generation, data: decorated.map(item => ({ ...summary(item), ...(item.attachments ? { attachments: item.attachments, attachmentsState: item.attachmentsState } : {}), ...(item.imageCount ? { imageCount: item.imageCount, ...(item.attachmentsState ? { attachmentsState: item.attachmentsState } : {}) } : {}) })) };
    }
    if (r.action === 'items' || r.action === 'turns') {
      if (s.fresh) return { generation: current(), data: [], nextCursor: null };
      const generation = current();
      const page: { data: any[]; nextCursor?: string | null } = { data: [], nextCursor: r.cursor };
      let messages = 0;
      do {
        // AIDEV-NOTE: Действия не расходуют десять сообщений; малые native страницы сохраняют предел media-кадра.
        const part = await codex.call(r.action === 'items' ? 'thread/items/list' : 'thread/turns/list', { threadId: r.threadId, limit: r.action === 'items' ? Math.min(10 - messages, 1000 - page.data.length, Math.max(1, Math.floor((limits.state - bytes(page) - 2048) / 49152))) : 100, cursor: page.nextCursor, sortDirection: 'desc', ...(r.action === 'items' ? { turnId: r.turnId } : { itemsView: 'notLoaded' }) });
        if (generation !== current()) fail('STALE_GENERATION', 'query');
        if (part.nextCursor && (!part.data.length || part.nextCursor === page.nextCursor)) fail('UPSTREAM_UNAVAILABLE', 'query');
        if (r.action === 'items') { results.trackItems(r, part.data); await attachments.recoverItems(r, part.data, deadline); }
        messages += part.data.filter((e: any) => e.item?.type === 'userMessage' || e.item?.type === 'agentMessage').length;
        page.data.push(...(r.action === 'items' ? part.data.map((e: any) => {
          const revision = s.view.items.find(i => i.id === e.item.id)?.revision ?? 0;
          if (e.item.type !== 'userMessage' && e.item.type !== 'agentMessage' && e.item.type !== 'plan') return { id: e.item.id, turnId: e.turnId, type: e.item.type, text: '', revision, ...(e.item.type === 'reasoning' ? { hasContent: (e.item.summary ?? []).some((part: string) => Boolean(part.trim())) } : {}), ...(typeof e.item.status === 'string' ? { status: e.item.status } : {}), ...(Object.hasOwn(e.item, 'exitCode') ? { exitCode: e.item.exitCode } : {}) };
          const resultCount = results.count(e.item);
          return { ...display(historyItem(e, s.view.turn), e.turnId, true), revision, timestamp: e.startedAtMs ?? e.completedAtMs ?? s.view.thread.updatedAt * 1000, ...(resultCount ? { resultCount } : {}) };
        }) : part.data.map((t: any) => ({ id: t.id, status: t.status }))));
        page.nextCursor = part.nextCursor ?? null;
      } while (r.action === 'items' && page.nextCursor && messages < 10 && page.data.length < 1000 && bytes(page) < limits.state - 51200);
      return { generation, data: r.action === 'items' ? await decorate(r, page.data.reverse(), deadline) : page.data, nextCursor: page.nextCursor };
    }
    if (r.generation !== current()) fail('STALE_GENERATION');
    if (s.closing) fail('CAPACITY_EXHAUSTED');
    if (s.mutating && ['start', 'goalSet', 'goalClear'].includes(r.action)) fail('OPERATION_CONFLICT');
    if (r.action === 'goalSet' || r.action === 'goalClear') {
      if (s.view.thread.canAcceptDirectInput === false) fail('OPERATION_CONFLICT');
      if (r.action === 'goalSet' && !r.objective && !s.view.goal.value) fail('INVALID_ARGUMENT');
      const activation = r.action === 'goalSet' && (r.status === 'active' || r.status === undefined && (s.view.goal.value?.status ?? 'active') === 'active');
      if (activation) await validateGoalModel(s);
      if (r.generation !== current()) fail('STALE_GENERATION');
      await mutation(s, r, async call => {
        if (r.action === 'goalClear') {
          const revision = s.goalRevision;
          await call('thread/goal/clear', { threadId: r.threadId });
          if (revision === s.goalRevision) s.view.goal = { state: 'ready', value: null };
          publish(s);
          await stopGoalTurn(s, call);
        } else {
          if (activation) {
            if (!s.view.thread.model) fail('UNSUPPORTED');
            await call('thread/settings/update', { threadId: r.threadId, collaborationMode: collaboration('default', s.view.thread.model, s.view.thread.reasoningEffort) });
          }
          await changeGoal(s, { threadId: r.threadId, ...(r.objective !== undefined ? { objective: r.objective } : {}), ...(r.status ? { status: r.status } : {}), ...(r.tokenBudget !== undefined ? { tokenBudget: r.tokenBudget } : {}) }, call);
          if (r.status === 'paused') await stopGoalTurn(s, call);
        }
      });
      return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: r.threadId, goal: structuredClone(s.view.goal) };
    }
    const active = s.view.turn?.status === 'inProgress';
    if (r.action === 'start' && (active || s.view.thread.canAcceptDirectInput === false)) fail('OPERATION_CONFLICT');
    if ((r.action === 'steer' || r.action === 'interrupt') && (!active || s.view.turn?.id !== (r.expectedTurnId ?? r.turnId))) fail('OPERATION_CONFLICT');
    if (r.action === 'start' || r.action === 'steer' && r.attachments?.length) {
      const model = r.action === 'steer' ? s.activeModel ?? s.view.thread.model : r.model ?? s.view.thread.model;
      if (config.allowedModels && !config.allowedModels.includes(model ?? '')) fail('UNSUPPORTED');
      if (r.model || r.effort || r.attachments?.length) {
        const choice = (await catalog()).data.find(m => m.model === model);
        if (!choice || (r.effort && !choice.efforts.includes(r.effort)) || (r.attachments?.length && choice.imageLimit === 0)) fail('UNSUPPORTED');
      }
    }
    if (r.generation !== current()) fail('STALE_GENERATION');
    if (r.action === 'start' && (s.closing || s.view.turn?.status === 'inProgress')) fail('OPERATION_CONFLICT');
    if (r.action === 'steer' && (s.closing || s.view.turn?.status !== 'inProgress' || s.view.turn.id !== r.expectedTurnId)) fail('OPERATION_CONFLICT');
    const previousTurn = s.view.turn, previousState = s.view.state, previousModel = s.activeModel;
    if (r.action === 'start' && r.agentMode === 'goal') {
      const model = r.model ?? s.view.thread.model;
      if (!model) fail('UNSUPPORTED');
      await mutation(s, r, async call => {
        if (s.view.goal.value || s.view.goal.state !== 'ready') {
          const revision = s.goalRevision;
          await call('thread/goal/clear', { threadId: r.threadId });
          if (revision === s.goalRevision) s.view.goal = { state: 'ready', value: null };
          publish(s);
        }
        await call('thread/settings/update', { threadId: r.threadId, ...permissions(r.permissionMode, p.cwd), collaborationMode: collaboration('default', model, r.effort ?? s.view.thread.reasoningEffort) });
        if (s.view.turn?.status === 'inProgress') fail('OPERATION_CONFLICT');
        s.view.thread.model = model;
        s.view.thread.reasoningEffort = r.effort ?? s.view.thread.reasoningEffort ?? null;
        await changeGoal(s, { threadId: r.threadId, objective: r.text!.trim(), status: 'active', ...(r.tokenBudget !== undefined ? { tokenBudget: r.tokenBudget } : {}) }, call);
      });
      title(s, r);
      return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: r.threadId, goal: structuredClone(s.view.goal) };
    }
    let reference: Awaited<ReturnType<typeof attachments.reserve>> | undefined;
    let nativeParams: any;
    if (durableInput || r.attachments?.length) {
      const deadline = performance.now() + (config.artifacts?.timeoutMs ?? 10000);
      try {
        nativeParams = buildInput(await attachments.modelInput(r, deadline));
        if (performance.now() >= deadline) fail('TIMEOUT');
        if (r.generation !== current()) fail('STALE_GENERATION');
      }
      catch (error: any) { error.outcome = 'not-sent'; throw error; }
      reference = await attachments.reserve(r, nativeParams);
      if (!reference!.created) return attachments.result(reference!.reference, r);
      if (r.generation !== current() || s.closing || r.action === 'start' && s.view.turn?.status === 'inProgress' || r.action === 'steer' && (s.view.turn?.status !== 'inProgress' || s.view.turn.id !== r.expectedTurnId)) { await attachments.state(reference!.reference, 'not-sent'); fail('OPERATION_CONFLICT'); }
    }
    if (r.action === 'start') { s.activeModel = r.model ?? s.view.thread.model; s.view.turn = { id: 'starting', status: 'inProgress' }; s.view.state = 'inProgress'; publish(s); }
    let turnId = r.turnId;
    if (r.action === 'answer') {
      const f = s.view.requests.find(f => f.requestId === r.requestId);
      if (!f || s.answering.has(f.requestId)) fail('STALE_REQUEST');
      const asynchronous = f.kind === 'question' && f.method === asyncQuestionMethod;
      if (f.answered && !(asynchronous && config.artifacts)) fail('STALE_REQUEST');
      const asyncReply = asynchronous ? asyncQuestionReply(f, r.answer) : null;
      if (asynchronous ? !asyncReply || s.view.thread.canAcceptDirectInput === false || s.mutating : f.kind === 'unsupported' || !codex.validateAnswer(s.raw.get(f.requestId)!, r.answer) || !validAnswer(f, r.answer)) fail('INVALID_ARGUMENT');
      const claims = s.answering;
      claims.add(f.requestId);
      // AIDEV-NOTE: Локальный claim блокирует дубль, не скрывая карточку до результата отправки.
      try {
        // AIDEV-NOTE: Async вопрос не держит server request: Desktop отвечает обычным user input.
        if (asyncReply) {
          // AIDEV-NOTE: Оба Brai используют один ключ исходного вопроса; Desktop reserve не использует.
          const replyCommand = { ...r, operationId: 'async:' + createHash('sha256').update(f.params.itemId).digest('hex') };
          const params = { threadId: r.threadId, input: [{ type: 'text', text: asyncReply }], clientUserMessageId: attachments.clientId(replyCommand) };
          if (config.artifacts) {
            if (!r.ownerId) fail('INVALID_ARGUMENT');
            const existing = await attachments.existing(replyCommand, () => params);
            if (existing) { f.answered = true; publish(s); return { ...existing, operationId: r.operationId, requestId: r.requestId }; }
            if (f.answered) fail('STALE_REQUEST');
            reference = await attachments.reserve(replyCommand, params);
            if (!reference!.created) {
              const recovered = await attachments.result(reference!.reference, replyCommand);
              f.answered = true; publish(s);
              return { ...recovered, operationId: r.operationId, requestId: r.requestId };
            }
          }
          if (r.generation !== current() || s.closing || active && (s.view.turn?.status !== 'inProgress' || s.view.turn.id !== previousTurn?.id) || !active && s.view.turn?.status === 'inProgress') {
            if (reference) await attachments.state(reference.reference, 'not-sent');
            fail(r.generation !== current() ? 'STALE_GENERATION' : 'OPERATION_CONFLICT');
          }
          let value: any;
          try { value = active
            ? await codex.call('turn/steer', { ...params, expectedTurnId: s.view.turn!.id }, { mutation: true })
            : await mutation(s, r, call => call('turn/start', params)); }
          catch (error: any) {
            if (reference) { try { await attachments.state(reference.reference, error.outcome === 'not-sent' ? 'not-sent' : 'unknown'); } catch { error.outcome = 'unknown'; } }
            throw error;
          }
          turnId = value.turn?.id ?? value.turnId;
          if (!active && s.view.turn === previousTurn) { s.view.turn = projectTurn(value.turn); s.view.state = value.turn.status; publish(s); }
          s.fresh = false;
        } else await codex.respond(s.raw.get(f.requestId)!, r.answer);
        if (r.generation === current() && s.view.requests.includes(f)) {
          f.answered = true;
          if (!s.view.requests.some(pendingRequest) && s.view.state === 'waiting') s.view.state = s.view.turn?.status ?? 'idle';
          publish(s);
        }
      }
      catch (error: any) {
        if (error.outcome !== 'not-sent' && r.generation === current() && s.view.requests.includes(f)) { f.answered = true; publish(s); }
        throw error;
      } finally { claims.delete(f.requestId); }
    } else if (r.action === 'interrupt') await codex.call('turn/interrupt', { threadId: r.threadId, turnId: r.turnId }, { mutation: true });
    else {
      const params = nativeParams ?? buildInput([]);
      let value: any;
      try { value = r.action === 'steer' ? await codex.call('turn/steer', params, { mutation: true }) : await mutation(s, r, async call => {
        if (s.view.goal.value?.status === 'active') await changeGoal(s, { threadId: r.threadId, status: 'paused' }, call);
        if (s.view.turn?.status === 'inProgress' && s.view.turn.id !== 'starting') fail('OPERATION_CONFLICT');
        return call('turn/start', params);
      }); }
      catch (error: any) {
        if (reference) { try { await attachments.state(reference.reference, error.outcome === 'not-sent' ? 'not-sent' : 'unknown'); } catch { error.outcome = 'unknown'; } }
        if (r.action === 'start' && error.outcome === 'not-sent' && r.generation === current() && s.view.turn?.id === 'starting') { s.view.turn = previousTurn; s.view.state = previousState; s.activeModel = previousModel; publish(s); } throw error; }
      turnId = value.turn?.id ?? value.turnId;
      if (r.action === 'start' && s.view.turn?.id === 'starting') { s.view.turn = projectTurn(value.turn); publish(s); }
      if (r.action === 'start') { s.view.thread.model = r.model ?? s.view.thread.model; s.view.thread.reasoningEffort = r.effort ?? s.view.thread.reasoningEffort ?? null; publish(s); }
      s.fresh = false;
    }
    if (r.generation !== current()) fail('STALE_GENERATION', 'unknown');
    if (r.action === 'start') title(s, r);
    if (reference) return { ...await attachments.result(reference.reference, r, turnId), ...(r.requestId ? { requestId: r.requestId } : {}) };
    return { generation: current(), operationId: r.operationId, outcome: 'accepted', threadId: r.threadId, turnId, ...(r.requestId ? { requestId: r.requestId } : {}) };
  }
  /** Повтор того же operation ID возвращает исходный результат без native вызова. */
  async function request(r: Command): Promise<any> {
    if (!validateCommand(r)) fail('INVALID_ARGUMENT');
    // AIDEV-NOTE: Metadata делит один read budget с native чтением; остаётся запас для NATS ответа.
    if (!r.operationId) return execute(r, performance.now() + Math.min(config.artifacts?.timeoutMs ?? rpcTimeouts.read, rpcTimeouts.read - 500));
    if (r.generation !== current()) fail('STALE_GENERATION');
    const hash = commandHash(r), old = operations.get(r.operationId);
    if (old) return old.hash === hash ? old.result : fail('OPERATION_CONFLICT');
    if (operations.size >= limits.operations) fail('CAPACITY_EXHAUSTED');
    const result = Promise.resolve().then(() => execute(r));
    operations.set(r.operationId, { hash, result });
    if (r.attachments?.length || config.artifacts && (['start', 'steer'].includes(r.action) && r.agentMode !== 'goal' || r.action === 'answer' && r.requestId?.startsWith('async:'))) void result.catch(() => { if (operations.get(r.operationId!)?.result === result) operations.delete(r.operationId!); });
    return result;
  }
  return { request, close() { unsubscribe(); limitMonitor.close(); } };
}
/** Хеширует полную команду; ledger сохраняет digest и результат, без raw media. */
function commandHash(command: Command): string {
  const canonical = JSON.stringify(command, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHash('sha256').update(canonical).digest('hex');
}
function validAnswer(f: PendingRequest, answer: any): boolean {
  if (f.kind === 'command-approval' && f.params.availableDecisions) return f.params.availableDecisions.some((v: any) => JSON.stringify(v) === JSON.stringify(answer?.decision));
  if (f.kind === 'question') {
    if (Object.keys(answer?.answers ?? {}).sort().join() !== f.params.questions.map((q: any) => q.id).sort().join()) return false;
    // AIDEV-NOTE: Native schema допускает пустой answers — это явный пропуск, а не отсутствующий вопрос.
    return f.params.questions.every((q: any) => answer.answers[q.id].answers.every((value: string) => value.trim() && (!q.options?.length || q.isOther || q.options.some((option: any) => option.label === value))));
  }
  if (f.kind === 'permissions') return answer?.scope === 'turn' && answer?.strictAutoReview !== true && (JSON.stringify(answer?.permissions) === JSON.stringify(f.params.permissions) || JSON.stringify(answer?.permissions) === '{}');
  return true;
}

/** Три явных native режима; отсутствие выбора означает risk-based auto_review. */
function permissions(mode = 'auto', cwd?: string) {
  const full = mode === 'full';
  return { approvalPolicy: full ? 'never' : 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', ...(cwd ? { sandboxPolicy: full ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false } } : { sandbox: full ? 'danger-full-access' : 'workspace-write' }) };
}

/** Встроенные инструкции выбирает native Codex; явный default снимает прежний plan. */
function collaboration(mode: 'default' | 'plan', model: string, effort?: string | null) {
  return { mode, settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } };
}

/** Только native отметка завершения подтверждает окончательный предложенный документ. */
function historyItem(entry: any, turn?: { id: string; status: string } | null) {
  return entry.item.type === 'plan' ? { ...entry.item, status: entry.completedAtMs != null || turn?.id === entry.turnId && turn?.status === 'completed' ? 'completed' : 'inProgress' } : entry.item;
}

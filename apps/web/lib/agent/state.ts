// ABOUTME: Применяет ограниченные snapshot и AG-UI события к состоянию клиента.
// ABOUTME: Здесь нет транспорта, команды, таймеров или состояния интерфейса React.
import { limits, serializedBytes } from "@brai/agent/contracts";
import type { CodexMessagePhase, CustomOutput, EventEnvelope, HistoryItem, PendingRequest, Project, StatusResponse, ThreadMetadata, ThreadSnapshot } from "@brai/agent/contracts";
import type { ActivityDeltaEvent, ActivitySnapshotEvent, Event, Message } from "@ag-ui/core";
import type { AgentClientState } from "./types";

const traceLimit = 128 * 1024;
const messageLimit = limits.snapshotBytes;

export type AgentStateAction =
  | { type: "projects"; value: Project[] }
  | { type: "status"; value: StatusResponse }
  | { type: "project"; value: string | null }
  | { type: "threads"; value: ThreadMetadata[]; cursor: string | null; append: boolean }
  | { type: "thread"; value: ThreadSnapshot }
  | { type: "event"; value: EventEnvelope }
  | { type: "messages"; value: Message[] }
  | { type: "history"; value: HistoryItem[]; cursor: string | null; append: boolean }
  | { type: "history-error"; value: string }
  | { type: "draft"; value: string }
  | { type: "mutation"; value: AgentClientState["mutation"]; error?: string | null }
  | { type: "connection"; value: AgentClientState["connection"] }
  | { type: "read-error"; value: string | null }
  | { type: "resyncing"; value: boolean };

/** Применяет одно действие, сохраняя конечные пределы сообщений, трассы и форм. */
export function reduceAgentState(state: AgentClientState, action: AgentStateAction): AgentClientState {
  switch (action.type) {
    case "projects": return { ...state, projects: action.value };
    case "status": return { ...state, status: action.value };
    case "project": return {
      ...state, selectedProjectId: action.value, threads: [], threadsCursor: null,
      selectedThreadId: null, messages: [], pendingRequests: [], traceItems: [], activityEvents: [], subagentEvents: [], messagePhases: {}, pendingMessagePhases: {}, threadStatus: null,
      generation: null, activeTurnId: null, streamEpoch: null, lastSeq: null, truncation: null,
      historyItems: [], historyCursor: null, historyTruncated: false, historyError: null,
      readError: null,
    };
    case "threads": return {
      ...state,
      threads: action.append ? [...state.threads, ...action.value].slice(-200) : action.value,
      threadsCursor: action.cursor,
    };
    case "thread": return withSnapshot(state, action.value);
    case "event": return withEvent(state, action.value);
    case "messages": {
      return withMessages(state, action.value);
    }
    case "history": {
      const items = action.append ? [...state.historyItems, ...action.value] : action.value;
      const bounded = boundHistory(items);
      return {
        ...state, historyItems: bounded.items, historyCursor: bounded.overflow ? null : action.cursor,
        historyTruncated: state.historyTruncated || bounded.overflow,
        historyError: bounded.overflow ? "Локальный предел истории достигнут; дальнейшая страница не загружена." : null,
      };
    }
    case "history-error": return { ...state, historyError: action.value };
    case "draft": return { ...state, draft: action.value };
    case "mutation": return { ...state, mutation: action.value, mutationError: action.error ?? null };
    case "connection": return { ...state, connection: action.value };
    case "read-error": return { ...state, readError: action.value };
    case "resyncing": return { ...state, resyncing: action.value };
  }
}

function withSnapshot(state: AgentClientState, snapshot: ThreadSnapshot): AgentClientState {
  const forms = boundForms(snapshot.pendingRequests);
  const trace = boundTrace(snapshot.traceItems);
  const messages = boundMessages(snapshot.messages);
  const messageIds = new Set(messages.messages.map(message => message.id));
  const messagePhases = Object.fromEntries(Object.entries(snapshot.messagePhases ?? {}).filter(([id]) => messageIds.has(id)));
  return {
    ...state, selectedProjectId: snapshot.projectId, selectedThreadId: snapshot.threadId,
    generation: snapshot.generation, activeTurnId: snapshot.activeTurnId, streamEpoch: snapshot.streamEpoch, lastSeq: snapshot.seq,
    threadStatus: snapshot.state, messages: messages.messages,
    pendingRequests: forms.requests, traceItems: trace.items, activityEvents: [], subagentEvents: [],
    messagePhases, pendingMessagePhases: {},
    truncation: messages.truncated || trace.truncated ? { truncated: true, reason: "item-limit" } : snapshot.truncation,
    resyncing: forms.overflow,
  };
}

function withEvent(state: AgentClientState, envelope: EventEnvelope): AgentClientState {
  const event = envelope.event as Event;
  let next: AgentClientState = { ...state, lastSeq: envelope.seq };
  switch (event.type) {
    case "RUN_STARTED": next.threadStatus = "working"; next.activeTurnId = envelope.turnId; break;
    case "RUN_ERROR": next.threadStatus = "error"; next.activeTurnId = null; break;
    case "RUN_FINISHED": {
      const outcome = event.outcome?.type;
      if (outcome === "cancelled" || outcome === "interrupt") next.threadStatus = "interrupted";
      else if (outcome === "success") next.threadStatus = "completed";
      next.activeTurnId = null;
      break;
    }
    case "MESSAGES_SNAPSHOT": next = withMessages(next, event.messages); break;
    case "ACTIVITY_SNAPSHOT": next = appendActivity(next, event); break;
    case "ACTIVITY_DELTA": next = appendActivity(next, event); break;
    case "SUBAGENT_STARTED": case "SUBAGENT_FINISHED": case "SUBAGENT_ERROR":
      next = { ...next, subagentEvents: [...next.subagentEvents.slice(-31), event] }; break;
    case "CUSTOM": next = applyCustom(next, envelope, event.name, event.value); break;
  }
  return next;
}

function appendActivity(state: AgentClientState, event: ActivitySnapshotEvent | ActivityDeltaEvent): AgentClientState {
  const events = [...state.activityEvents.slice(-99), event];
  let truncated = false;
  while (events.length && serializedBytes(events) > traceLimit) { events.shift(); truncated = true; }
  return { ...state, activityEvents: events, truncation: truncated ? { truncated: true, reason: "item-limit" } : state.truncation };
}

function withMessages(state: AgentClientState, messages: Message[]): AgentClientState {
  const bounded = boundMessages(messages);
  const ids = new Set(bounded.messages.map(message => message.id));
  const messagePhases: Record<string, CodexMessagePhase | null> = {};
  for (const [id, phase] of Object.entries(state.messagePhases)) if (ids.has(id)) messagePhases[id] = phase;
  const pendingMessagePhases: Record<string, CodexMessagePhase | null> = {};
  for (const [id, phase] of Object.entries(state.pendingMessagePhases).slice(-256)) {
    if (ids.has(id)) messagePhases[id] = phase;
    else pendingMessagePhases[id] = phase;
  }
  return {
    ...state, messages: bounded.messages, messagePhases, pendingMessagePhases,
    truncation: bounded.truncated ? { truncated: true, reason: "byte-budget" } : state.truncation,
  };
}

function applyCustom(state: AgentClientState, envelope: EventEnvelope, name: string, value: unknown): AgentClientState {
  if (!value || typeof value !== "object") return state;
  const record = value as Record<string, unknown>;
  if (name === "brai.agent.request.opened") {
    const request = record.request as PendingRequest | undefined;
    if (!request) return state;
    if (request.kind === "unsupported") {
      const requests = [...state.pendingRequests.filter(item => item.kind !== "unsupported"), request];
      const forms = boundForms(requests);
      return forms.overflow ? { ...state, resyncing: true } : { ...state, pendingRequests: forms.requests, threadStatus: "waiting" };
    }
    if (state.pendingRequests.some(item => item.requestId === request.requestId)) return state;
    const forms = boundForms([...state.pendingRequests, request]);
    return forms.overflow ? { ...state, resyncing: true } : { ...state, pendingRequests: forms.requests, threadStatus: "waiting" };
  }
  if (name === "brai.agent.request.resolved" && typeof record.requestId === "string") {
    const pendingRequests = state.pendingRequests.filter(item => item.requestId !== record.requestId);
    return { ...state, pendingRequests, threadStatus: pendingRequests.length ? "waiting" : state.activeTurnId ? "working" : state.threadStatus };
  }
  if (name === "brai.agent.connection") {
    if (record.state === "disconnected") return { ...state, threadStatus: "connection-lost" };
    if (record.state === "executor-unavailable") return { ...state, threadStatus: "executor-unavailable" };
  }
  if (name === "brai.agent.message.phase" && typeof record.itemId === "string") {
    const ids = new Set(state.messages.map(message => message.id));
    if (ids.has(record.itemId)) return { ...state, messagePhases: { ...state.messagePhases, [record.itemId]: record.phase as CodexMessagePhase | null } };
    return { ...state, pendingMessagePhases: {
      ...Object.fromEntries(Object.entries(state.pendingMessagePhases).slice(-255)),
      [record.itemId]: record.phase as CodexMessagePhase | null,
    } };
  }
  if (name === "brai.agent.output") {
    if (typeof record.itemId !== "string") return state;
    if (typeof record.text !== "string") return state;
    const previousIndex = state.traceItems.findIndex(item => item.itemId === record.itemId);
    const previous = previousIndex < 0 ? undefined : state.traceItems[previousIndex];
    const output = record as unknown as CustomOutput;
    const commandPresent = Object.prototype.hasOwnProperty.call(record, "command");
    const isCommand = commandPresent || previous?.trace.type === "command" || typeof previous?.trace.command === "string";
    const trace = {
      ...(previous?.trace ?? {}),
      type: isCommand ? "command" as const : "output" as const,
      status: Object.prototype.hasOwnProperty.call(record, "status") ? output.status! : previous?.trace.status ?? "updated",
      ...(commandPresent ? { command: output.command! } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "exitCode") ? { exitCode: output.exitCode! } : {}),
      output: record.text,
    };
    const item: ThreadSnapshot["traceItems"][number] = {
      itemId: record.itemId, order: previous?.order ?? state.lastSeq ?? 0, kind: isCommand ? "command" : "output",
      content: record.text, truncated: record.truncated === true, contentBytes: typeof record.contentBytes === "number" ? record.contentBytes : serializedBytes(record.text),
      turnId: envelope.turnId ?? previous?.turnId ?? "", trace,
    };
    const items = state.traceItems.slice();
    if (previousIndex < 0) items.push(item);
    else items[previousIndex] = item;
    const bounded = boundTrace(items);
    return { ...state, traceItems: bounded.items, truncation: bounded.truncated ? { truncated: true, reason: "item-limit" } : state.truncation };
  }
  if (name === "brai.agent.diff") {
    if (typeof record.itemId !== "string") return state;
    if (typeof record.diff !== "string") return state;
    const previous = state.traceItems.filter(item => item.itemId !== record.itemId);
    const item: ThreadSnapshot["traceItems"][number] = {
      itemId: record.itemId, order: state.lastSeq ?? 0, kind: "file-change",
      content: record.diff, truncated: record.truncated === true, contentBytes: typeof record.contentBytes === "number" ? record.contentBytes : serializedBytes(record.diff),
      turnId: envelope.turnId ?? "", trace: { type: "file-change", status: "updated", diffSummary: record.diff },
    };
    const bounded = boundTrace([...previous, item]);
    return { ...state, traceItems: bounded.items, truncation: bounded.truncated ? { truncated: true, reason: "item-limit" } : state.truncation };
  }
  if (name === "brai.agent.truncation" && typeof record.reason === "string") {
    return { ...state, truncation: { truncated: true, reason: record.reason as "byte-budget" | "item-limit" | "upstream-limit" } };
  }
  return state;
}

function boundMessages(messages: Message[]): { messages: Message[]; truncated: boolean } {
  let result = messages.slice(-256);
  let truncated = result.length !== messages.length;
  while (result.length > 1 && serializedBytes(result) > messageLimit) {
    result = result.slice(1);
    truncated = true;
  }
  if (serializedBytes(result) > messageLimit && result.length === 1) {
    const item = result[0] as Message;
    if (item.role !== "activity" && typeof item.content === "string") {
      let content = item.content;
      while (content && serializedBytes([{ ...item, content }]) > messageLimit - 256) content = content.slice(Math.ceil(content.length / 8));
      result = [{ ...item, content: `[Ранний вывод сообщения ограничен]\n${content}` }];
      truncated = true;
    } else {
      result = [];
      truncated = true;
    }
  }
  return { messages: result, truncated };
}

function boundTrace(items: ThreadSnapshot["traceItems"]): { items: ThreadSnapshot["traceItems"]; truncated: boolean } {
  let result = items.slice(-200).map(fitTraceItem);
  let truncated = result.length !== items.length || result.some((item, index) => serializedBytes(item) !== serializedBytes(items[items.length - result.length + index]));
  let bytes = result.reduce((sum, item) => sum + serializedBytes(item), 0);
  while (result.length > 0 && (result.length > 200 || bytes > traceLimit)) {
    bytes -= serializedBytes(result[0]);
    result = result.slice(1);
    truncated = true;
  }
  return { items: result, truncated };
}

function fitTraceItem(item: ThreadSnapshot["traceItems"][number]): ThreadSnapshot["traceItems"][number] {
  if (serializedBytes(item) <= 24 * 1024) return item;
  const content = `[Локальная трасса сокращена]\n${item.content.slice(-5_000)}`;
  const trace = {
    ...item.trace,
    ...(item.trace.command ? { command: `[Локально сокращено]\n${item.trace.command.slice(-2_000)}` } : {}),
    ...(item.trace.output ? { output: `[Локально сокращено]\n${item.trace.output.slice(-2_000)}` } : {}),
    ...(item.trace.diffSummary ? { diffSummary: `[Локально сокращено]\n${item.trace.diffSummary.slice(-2_000)}` } : {}),
  };
  return { ...item, content, trace, truncated: true };
}

function boundForms(requests: PendingRequest[]): { requests: PendingRequest[]; overflow: boolean } {
  const bytes = requests.reduce((sum, item) => sum + serializedBytes(item), 0);
  return { requests: requests.length <= 64 && bytes <= limits.pendingFormsBytes ? requests : [], overflow: requests.length > 64 || bytes > limits.pendingFormsBytes };
}

function boundHistory(items: HistoryItem[]): { items: HistoryItem[]; overflow: boolean } {
  const selected: HistoryItem[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  for (const item of items) {
    if (ids.has(item.itemId)) continue;
    const size = serializedBytes(item);
    if (selected.length >= 256 || bytes + size > limits.historyResponseBytes) return { items: selected, overflow: true };
    selected.push(item);
    ids.add(item.itemId);
    bytes += size;
  }
  selected.sort((left, right) => left.order - right.order);
  return { items: selected, overflow: false };
}

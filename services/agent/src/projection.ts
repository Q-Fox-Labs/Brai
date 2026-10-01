// ABOUTME: Преобразует наблюдения Codex в ограниченные проверенные события AG-UI.
// ABOUTME: Проекция не владеет историей: сообщения, трасса, формы и границы потока принадлежат state.

import { limits, serializedBytes, validateDto, validateEventEnvelope } from "../contracts/index.mjs";
import type { Event as AguiEvent, Message } from "@ag-ui/core";
import type { CodexObservation } from "./ports.js";
import type { Session, StateChange } from "./state.js";
import { toolText } from "./tool-text.js";

type Owner = ReturnType<typeof import("./state.js").createState>;
export type EventEnvelope = {
  projectId: string;
  threadId: string;
  turnId: string | null;
  generation: string;
  streamEpoch: string;
  seq: number;
  event: AguiEvent;
};
export type ProjectionListener = (event: EventEnvelope) => void | Promise<void>;

type QueueEntry = { event: EventEnvelope; bytes: number };
type Subscriber = {
  listener: ProjectionListener;
  onClose?: (reason: "overflow" | "slow-listener" | "listener-error" | "closed") => void;
  queue: QueueEntry[];
  bytes: number;
  running: boolean;
  closed: boolean;
  closeAfterDrain: boolean;
};

const TEXT_LIMIT = 64 * 1024;
const QUEUE_LIMIT = 64;
const QUEUE_BYTES = 1024 * 1024;
const LISTENER_LIMIT = 128;
const LISTENER_TIMEOUT_MS = 1000;
const marker = "\n[содержимое сокращено]";

/** Возвращает текст в UTF-8-пределе и размер исходной строки. */
function boundedText(value: string, maxBytes = TEXT_LIMIT) {
  const contentBytes = Buffer.byteLength(value, "utf8");
  if (contentBytes <= maxBytes) return { text: value, truncated: false, contentBytes };
  const suffix = marker;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let text = "";
  let usedBytes = 0;
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (usedBytes + pointBytes > budget) break;
    usedBytes += pointBytes;
    text += point;
  }
  return { text: text + suffix, truncated: true, contentBytes };
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function nativeText(item: Record<string, any>): string {
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return toolText(item);
  if (item.type === "agentMessage") return typeof item.text === "string" ? item.text : "";
  if (item.type === "reasoning" && Array.isArray(item.summary)) return item.summary.filter((line: unknown) => typeof line === "string").join("\n");
  if (item.type === "collabAgentToolCall") return `${String(item.tool ?? "agent")}: ${String(item.status ?? "unknown")}`;
  if (item.type === "subAgentActivity") return `${String(item.kind ?? "agent")}: ${String(item.status ?? "unknown")}`;
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    return item.content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
  }
  return "";
}

function traceKind(type: string): string {
  if (type === "commandExecution") return "command";
  if (type === "fileChange") return "file-change";
  if (type === "agentMessage" || type === "userMessage") return "message";
  return "other";
}

function commandOutputMetadata(item: Record<string, any>): Record<string, unknown> {
  return {
    ...(typeof item.command === "string" ? { command: boundedText(item.command, 16 * 1024).text } : {}),
    ...(typeof item.status === "string" ? { status: item.status } : {}),
    ...(Object.hasOwn(item, "exitCode") && (typeof item.exitCode === "number" || item.exitCode === null) ? { exitCode: item.exitCode } : {}),
  };
}

/** Создаёт проекцию с конечными очередями подписчиков; Codex callbacks не ждут listeners. */
export function createProjection() {
  const subscribers = new Set<Subscriber>();
  let closed = false;

  function notifyClose(subscriber: Subscriber, reason: "overflow" | "slow-listener" | "listener-error" | "closed"): void {
    if (!subscriber.onClose) return;
    queueMicrotask(() => { try { subscriber.onClose?.(reason); } catch { /* Transport cleanup cannot delay projection callbacks. */ } });
  }

  function envelope(session: Session, owner: Owner, event: Record<string, any>, turnId: string | null): EventEnvelope | undefined {
    if (!owner.isCurrent(session)) return undefined;
    const epoch = session.streamEpoch;
    const seq = owner.nextSeq(session);
    const value: EventEnvelope = {
      projectId: session.projectId,
      threadId: session.threadId,
      turnId: turnId ?? session.activeTurnId,
      generation: session.generation,
      streamEpoch: session.streamEpoch,
      seq,
      event: structuredClone(session.streamEpoch === epoch ? event : { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "epoch-change" } }) as AguiEvent,
    };
    return validateEventEnvelope(value) ? value : undefined;
  }

  function resync(session: Session, owner: Owner, reason: "overflow" | "old-epoch" | "generation-change" | "epoch-change" | "gap"): EventEnvelope | undefined {
    return envelope(session, owner, { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason } }, session.activeTurnId);
  }

  function dispatch(entry: QueueEntry, subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.queue.push(entry);
    subscriber.bytes += entry.bytes;
    if (subscriber.queue.length > QUEUE_LIMIT || subscriber.bytes > QUEUE_BYTES) {
      subscriber.queue.length = 0;
      subscriber.bytes = 0;
      const overflow = {
        ...entry.event,
        event: { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "overflow" } } as AguiEvent,
      };
      const bytes = serializedBytes(overflow);
      if (bytes <= QUEUE_BYTES) {
        subscriber.queue.push({ event: overflow, bytes });
        subscriber.bytes = bytes;
        subscriber.closeAfterDrain = true;
        notifyClose(subscriber, "overflow");
      } else {
        subscriber.closed = true;
        subscribers.delete(subscriber);
        notifyClose(subscriber, "overflow");
      }
      if (subscriber.running) return;
    }
    if (subscriber.running) return;
    subscriber.running = true;
    void drain(subscriber);
  }

  async function drain(subscriber: Subscriber): Promise<void> {
    while (subscriber.queue.length && !subscriber.closed) {
      const item = subscriber.queue.shift()!;
      subscriber.bytes -= item.bytes;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await Promise.race([
          Promise.resolve(subscriber.listener(item.event)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("listener timeout")); }, LISTENER_TIMEOUT_MS); }),
        ]);
      } catch {
        if (timedOut && !subscriber.closeAfterDrain) {
          subscriber.closed = true;
          subscriber.queue.length = 0;
          subscribers.delete(subscriber);
          notifyClose(subscriber, "slow-listener");
        } else if (!timedOut) {
          subscriber.closed = true;
          subscriber.queue.length = 0;
          subscribers.delete(subscriber);
          notifyClose(subscriber, "listener-error");
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (subscriber.closeAfterDrain) {
      subscriber.closed = true;
      subscribers.delete(subscriber);
    }
    subscriber.running = false;
  }

  function emit(session: Session | undefined, owner: Owner, event: Record<string, any>, turnId: string | null): void {
    if (!session || closed) return;
    const value = envelope(session, owner, event, turnId);
    if (!value) {
      const required = resync(session, owner, "old-epoch");
      if (required) for (const subscriber of subscribers) dispatch({ event: structuredClone(required), bytes: serializedBytes(required) }, subscriber);
      return;
    }
    const bytes = serializedBytes(value);
    if (!bytes || bytes > limits.natsSseFrameBytes) {
      const required = resync(session, owner, "overflow");
      if (required) for (const subscriber of subscribers) dispatch({ event: structuredClone(required), bytes: serializedBytes(required) }, subscriber);
      return;
    }
    for (const subscriber of subscribers) dispatch({ event: structuredClone(value), bytes }, subscriber);
  }

  function truncation(session: Session, owner: Owner, itemId: string, turnId: string, result: ReturnType<typeof boundedText>): void {
    if (!result.truncated) return;
    owner.markTruncated(session, "byte-budget");
    emit(session, owner, { type: "CUSTOM", name: "brai.agent.truncation", value: { threadId: session.threadId, reason: "byte-budget" } }, turnId);
    void itemId;
  }

  function recordItem(session: Session, owner: Owner, item: Record<string, any>, turnId: string): void {
    if (typeof item.id !== "string") return;
    const id = item.id;
    const kind = traceKind(String(item.type ?? ""));
    const text = nativeText(item);
    const itemPayload = item.type === "commandExecution" && typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : item.type === "fileChange" && Array.isArray(item.changes)
        ? item.changes.map((change: any) => String(change.diff ?? "")).join("\n")
        : text;
    const limited = boundedText(itemPayload);
    const status = typeof item.status === "string" ? item.status : "inProgress";
    const trace: Record<string, unknown> = {
      itemId: id,
      order: object(session.trace.find((entry) => object(entry).itemId === id)).order ?? session.trace.length,
      kind,
      content: limited.text,
      truncated: limited.truncated,
      contentBytes: limited.contentBytes,
      turnId,
      trace: {
        type: kind === "file-change" ? "file-change" : kind === "command" ? "command" : kind === "message" ? "message" : "other",
        status,
        ...(typeof item.command === "string" ? { command: boundedText(item.command, 16 * 1024).text } : {}),
        ...(typeof item.exitCode === "number" || item.exitCode === null ? { exitCode: item.exitCode } : {}),
        ...(item.type === "commandExecution" && typeof item.aggregatedOutput === "string" ? { output: boundedText(item.aggregatedOutput).text } : {}),
        ...(item.type === "fileChange" && Array.isArray(item.changes) ? { diffSummary: boundedText(item.changes.map((change: any) => String(change.diff ?? "")).join("\n")).text } : {}),
        ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}),
      },
    };
    owner.upsertTrace(session, trace);
    if (limited.truncated) truncation(session, owner, id, turnId, limited);
  }

  function toolStart(session: Session, owner: Owner, item: Record<string, any>, turnId: string): void {
    const id = item.id;
    if (owner.messageLifecycle(session, id) !== "unknown") return;
    const name = item.type === "commandExecution" ? "command" : item.type === "fileChange" ? "fileChange" : String(item.tool ?? item.type);
    const args = item.type === "commandExecution"
      ? JSON.stringify({ command: item.command ?? "", cwd: item.cwd ?? "" })
      : item.type === "fileChange"
        ? JSON.stringify({ changes: Array.isArray(item.changes) ? item.changes.map((change: any) => ({ path: change.path, kind: change.kind })) : [] })
        : JSON.stringify(item.arguments ?? {});
    const limited = boundedText(args, 16 * 1024);
    owner.upsertMessage(session, { id, role: "assistant", content: "", toolCalls: [{ id, type: "function", function: { name, arguments: limited.text } }] });
    owner.setMessageLifecycle(session, id, "open");
    emit(session, owner, { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, messageId: id }, turnId);
    emit(session, owner, { type: "TOOL_CALL_ARGS", toolCallId: id, delta: limited.text }, turnId);
    emit(session, owner, { type: "TOOL_CALL_END", toolCallId: id, messageId: id }, turnId);
  }

  function toolResult(session: Session, owner: Owner, item: Record<string, any>, turnId: string): void {
    const id = item.id;
    let lifecycle = owner.messageLifecycle(session, id);
    if (lifecycle === "unknown") {
      toolStart(session, owner, item, turnId);
      lifecycle = "open";
    }
    const text = item.type === "commandExecution"
      ? `status=${String(item.status ?? "unknown")}; exitCode=${item.exitCode ?? "unknown"}\n${String(item.aggregatedOutput ?? "")}`
      : item.type === "fileChange"
        ? String(item.status ?? "")
        : item.type === "mcpToolCall" || item.type === "dynamicToolCall" ? toolText(item)
        : typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? item.status ?? "");
    const limited = boundedText(text);
    const resultId = `tool-result:${id}`;
    owner.upsertMessage(session, { id: resultId, role: "tool", content: limited.text, toolCallId: id });
    if (lifecycle !== "closed") emit(session, owner, { type: "TOOL_CALL_RESULT", toolCallId: id, messageId: resultId, role: "tool", content: limited.text }, turnId);
    owner.setMessageLifecycle(session, id, "closed");
    if (limited.truncated) truncation(session, owner, id, turnId, limited);
  }

  function finalMessage(session: Session, owner: Owner, item: Record<string, any>, turnId: string): void {
    if (typeof item.id !== "string") return;
    const lifecycle = owner.messageLifecycle(session, item.id);
    const before = structuredClone((owner.view(session).messages as any[]).find((message) => message?.id === item.id));
    const previousPhase = (owner.view(session).messagePhases as Record<string, string>)[item.id] ?? null;
    const limited = boundedText(nativeText(item));
    const role = item.type === "userMessage" ? "user" : "assistant";
    const message = { id: item.id, role, content: limited.text } as Message;
    const changed = !before || JSON.stringify(before) !== JSON.stringify(message);
    owner.upsertMessage(session, message);
    recordItem(session, owner, item, turnId);
    if (lifecycle === "unknown") emit(session, owner, { type: "TEXT_MESSAGE_START", messageId: item.id, role }, turnId);
    let phaseChanged = false;
    if (item.type === "agentMessage" && (item.phase === "commentary" || item.phase === "final_answer" || item.phase === null)) {
      owner.setMessagePhase(session, item.id, item.phase);
      phaseChanged = previousPhase !== item.phase;
      if (phaseChanged) emit(session, owner, { type: "CUSTOM", name: "brai.agent.message.phase", value: { itemId: item.id, phase: item.phase } }, turnId);
    }
    if (lifecycle === "unknown" && limited.text) emit(session, owner, { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: limited.text }, turnId);
    if (lifecycle !== "closed") emit(session, owner, { type: "TEXT_MESSAGE_END", messageId: item.id }, turnId);
    if (lifecycle !== "closed" || changed) emit(session, owner, { type: "MESSAGES_SNAPSHOT", messages: structuredClone(owner.view(session).messages) as Message[] }, turnId);
    owner.setMessageLifecycle(session, item.id, "closed");
    if (limited.truncated) truncation(session, owner, item.id, turnId, limited);
  }

  function onObservation(e: CodexObservation, session: Session | undefined, owner: Owner, change: StateChange): void {
    if (closed) return;
    if (e.type === "connection") {
      const sessions = owner.values();
      for (const current of sessions) {
        if (change.generationChanged) {
          emit(current, owner, { type: "CUSTOM", name: "brai.agent.connection", value: { state: "disconnected" } }, current.activeTurnId);
          emit(current, owner, { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "generation-change" } }, current.activeTurnId);
          if (e.status.connection === "connected") emit(current, owner, { type: "CUSTOM", name: "brai.agent.connection", value: { state: "connected" } }, current.activeTurnId);
        } else {
          emit(current, owner, { type: "CUSTOM", name: "brai.agent.connection", value: { state: e.status.connection } }, current.activeTurnId);
          if (e.code === "event-overflow") emit(current, owner, { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "overflow" } }, current.activeTurnId);
        }
      }
      return;
    }

    if (!session) return;
    const p = e.params;
    const turn = object(p.turn);
    const turnId = typeof p.turnId === "string" ? p.turnId : typeof turn.id === "string" ? turn.id : session?.activeTurnId ?? null;
    if (e.type === "request") {
      const pending = session ? owner.pendingView(session) as any[] : [];
      const form = pending.find((item) => item.requestId === change.openedRequestId);
      if (form) emit(session, owner, { type: "CUSTOM", name: "brai.agent.request.opened", value: { request: form } }, turnId);
      else if (session) emit(session, owner, { type: "CUSTOM", name: "brai.agent.connection", value: { state: "executor-unavailable" } }, turnId);
      return;
    }
    if (e.type !== "notification") return;

    if (e.method === "turn/started" && turnId) {
      emit(session, owner, { type: "RUN_STARTED", threadId: String(p.threadId), runId: turnId }, turnId);
      return;
    }
    if (e.method === "turn/completed" && turnId) {
      if (turn.status === "interrupted") emit(session, owner, { type: "RUN_FINISHED", threadId: String(p.threadId), runId: turnId, outcome: { type: "cancelled" } }, turnId);
      else if (turn.status === "failed") emit(session, owner, { type: "RUN_ERROR", threadId: String(p.threadId), runId: turnId, message: "Codex turn failed." }, turnId);
      else emit(session, owner, { type: "RUN_FINISHED", threadId: String(p.threadId), runId: turnId, outcome: { type: "success" } }, turnId);
      for (const requestId of change.closedRequestIds) emit(session, owner, { type: "CUSTOM", name: "brai.agent.request.resolved", value: { requestId, outcome: "stale" } }, turnId);
      return;
    }
    if (e.method === "serverRequest/resolved") {
      for (const requestId of change.closedRequestIds) emit(session, owner, { type: "CUSTOM", name: "brai.agent.request.resolved", value: { requestId, outcome: "unknown" } }, turnId);
      return;
    }
    if (e.method === "item/agentMessage/delta") {
      const id = String(p.itemId ?? "");
      if (!id) return;
      const lifecycle = owner.messageLifecycle(session, id);
      if (lifecycle === "closed") return;
      const incoming = String(p.delta ?? "");
      const priorTrace = (session.trace as any[]).find((item) => item?.itemId === id);
      const accumulated = owner.appendMessageDelta(session, id, incoming);
      const message = object(accumulated.message);
      if (lifecycle === "unknown") {
        owner.setMessageLifecycle(session, id, "open");
        emit(session, owner, { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }, turnId);
      }
      owner.upsertTrace(session, { ...(priorTrace ?? { itemId: id, order: session.trace.length, kind: "message", truncated: false, turnId: turnId ?? "", trace: { type: "message", status: "inProgress" } }), content: String(message.content ?? ""), contentBytes: accumulated.contentBytes, truncated: accumulated.truncated, turnId: turnId ?? "" });
      if (accumulated.replacement) {
        emit(session, owner, { type: "MESSAGES_SNAPSHOT", messages: structuredClone(owner.view(session).messages) as Message[] }, turnId);
      } else if (accumulated.delta) {
        emit(session, owner, { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: accumulated.delta }, turnId);
      }
      if (accumulated.truncated) truncation(session, owner, id, turnId ?? "", { text: String(message.content ?? ""), truncated: true, contentBytes: accumulated.contentBytes });
      return;
    }
    if (e.method === "item/commandExecution/outputDelta" || e.method === "item/fileChange/outputDelta") {
      const id = String(p.itemId ?? "");
      if (!id) return;
      const prior = (session?.trace ?? []).find((item: any) => item?.itemId === id) as any;
      const previous = typeof prior?.trace?.output === "string" ? prior.trace.output : "";
      const text = String(p.delta ?? "");
      const bounded = prior?.truncated
        ? { text: previous, truncated: true, contentBytes: Number(prior.contentBytes ?? 0) + Buffer.byteLength(text, "utf8") }
        : boundedText(previous + text);
      owner.upsertTrace(session!, { ...(prior ?? { itemId: id, order: session!.trace.length, kind: "output", content: "", truncated: false, contentBytes: 0, turnId: turnId ?? "" }), contentBytes: bounded.contentBytes, truncated: bounded.truncated, turnId: turnId ?? "", trace: { ...(prior?.trace ?? { type: "output", status: "inProgress" }), output: bounded.text } });
      const metadata = prior?.trace?.type === "command" ? commandOutputMetadata(prior.trace) : {};
      emit(session, owner, { type: "CUSTOM", name: "brai.agent.output", value: { itemId: id, text: bounded.text, truncated: bounded.truncated, contentBytes: bounded.contentBytes, ...metadata } }, turnId);
      if (bounded.truncated) truncation(session!, owner, id, turnId ?? "", bounded);
      return;
    }
    if (e.method === "turn/plan/updated") {
      const id = `plan:${turnId ?? "unknown"}`;
      const steps = Array.isArray(p.plan) ? p.plan.slice(0, 64).map((step: any) => ({ step: boundedText(String(step.step ?? ""), 2048).text, status: step.status })) : [];
      const activity = { steps };
      owner.upsertTrace(session!, { itemId: id, order: session!.trace.length, kind: "plan", content: JSON.stringify(activity), truncated: false, contentBytes: serializedBytes(activity), turnId: turnId ?? "", trace: { type: "other", status: "updated" } });
      emit(session, owner, { type: "ACTIVITY_SNAPSHOT", messageId: id, activityType: "plan", content: activity }, turnId);
      return;
    }
    if ((e.method === "item/started" || e.method === "item/completed") && p.item && typeof p.item === "object") {
      const item = p.item as Record<string, any>;
      if (item.type === "userMessage" && e.method === "item/started" && typeof item.id === "string") {
        if (owner.messageLifecycle(session, item.id) !== "unknown") return;
        const text = boundedText(nativeText(item));
        owner.upsertMessage(session, { id: item.id, role: "user", content: text.text });
        owner.setMessageLifecycle(session, item.id, "open");
        emit(session, owner, { type: "TEXT_MESSAGE_START", messageId: item.id, role: "user" }, turnId);
        if (text.text) emit(session, owner, { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text.text }, turnId);
        recordItem(session, owner, item, turnId ?? "");
        if (text.truncated) truncation(session, owner, item.id, turnId ?? "", text);
        return;
      }
      if (item.type === "agentMessage") {
        if (e.method === "item/started" && typeof item.id === "string") {
          if (owner.messageLifecycle(session, item.id) !== "unknown") return;
          const limited = boundedText(typeof item.text === "string" ? item.text : "");
          owner.upsertMessage(session, { id: item.id, role: "assistant", content: limited.text });
          owner.setMessageLifecycle(session, item.id, "open");
          emit(session, owner, { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" }, turnId);
          if (item.phase === "commentary" || item.phase === "final_answer" || item.phase === null) {
            owner.setMessagePhase(session, item.id, item.phase);
            emit(session, owner, { type: "CUSTOM", name: "brai.agent.message.phase", value: { itemId: item.id, phase: item.phase } }, turnId);
          }
          if (limited.text) emit(session, owner, { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: limited.text }, turnId);
          recordItem(session, owner, item, turnId ?? "");
        } else if (typeof item.id === "string") {
          finalMessage(session, owner, item, turnId ?? "");
        }
        return;
      }
      if (item.type === "userMessage" && e.method === "item/completed") {
        finalMessage(session, owner, item, turnId ?? "");
        return;
      }
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(String(item.type))) {
        if (e.method === "item/started") toolStart(session!, owner, item, turnId ?? "");
        else toolResult(session!, owner, item, turnId ?? "");
        recordItem(session!, owner, item, turnId ?? "");
        if (item.type === "commandExecution" && (e.method === "item/completed" || typeof item.command === "string")) {
          const limited = boundedText(typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "");
          emit(session, owner, { type: "CUSTOM", name: "brai.agent.output", value: { itemId: item.id, text: limited.text, truncated: limited.truncated, contentBytes: limited.contentBytes, ...commandOutputMetadata(item) } }, turnId);
        }
        if (item.type === "fileChange" && e.method === "item/completed") {
          const diff = (Array.isArray(item.changes) ? item.changes.map((change: any) => `--- ${change.path}\n${change.diff}`).join("\n") : "");
          const limited = boundedText(diff);
          emit(session, owner, { type: "CUSTOM", name: "brai.agent.diff", value: { itemId: item.id, diff: limited.text, truncated: limited.truncated, contentBytes: limited.contentBytes } }, turnId);
        }
        return;
      }
      if (item.type === "reasoning" && Array.isArray(item.summary) && item.summary.length) {
        const summary = boundedText(item.summary.join("\n"));
        recordItem(session!, owner, { ...item, text: summary.text, type: "reasoning" }, turnId ?? "");
        return;
      }
      if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
        const content = item.type === "collabAgentToolCall" ? `${item.tool ?? "agent"}: ${item.status ?? "unknown"}` : `${item.kind ?? "agent"}: ${item.status ?? "unknown"}`;
        recordItem(session!, owner, { ...item, text: content }, turnId ?? "");
        return;
      }
      recordItem(session!, owner, item, turnId ?? "");
    }
  }

  return {
    /** Преобразует одно подтверждённое Codex observation и ставит события в конечные очереди. */
    onObservation,
    /** Возвращает owner snapshot после проверки, что handle всё ещё принадлежит сеансу. */
    snapshot(session: Session, owner: Owner) {
      if (!owner.isCurrent(session)) throw Object.assign(new Error("Session expired"), { code: "NOT_FOUND" });
      const snapshot = structuredClone(owner.view(session));
      if (!validateDto("ThreadSnapshot", snapshot)) throw Object.assign(new Error("Thread snapshot exceeds its contract"), { code: "CAPACITY_EXHAUSTED" });
      return snapshot;
    },
    /** Подписывает потребителя; переполнение или медленный listener завершают его с явным resync. */
    subscribe(listener: ProjectionListener, onClose?: Subscriber["onClose"]) {
      if (closed) throw new Error("Projection closed");
      if (subscribers.size >= LISTENER_LIMIT) throw Object.assign(new Error("Projection listener capacity exhausted"), { code: "CAPACITY_EXHAUSTED" });
      const subscriber: Subscriber = { listener, onClose, queue: [], bytes: 0, running: false, closed: false, closeAfterDrain: false };
      subscribers.add(subscriber);
      return () => { subscriber.closed = true; subscriber.queue.length = 0; subscriber.bytes = 0; subscribers.delete(subscriber); notifyClose(subscriber, "closed"); };
    },
    /** Сигнализирует старым подписчикам перед вытеснением сеанса. */
    onResync(session: Session, owner: Owner) {
      const event = resync(session, owner, "old-epoch");
      if (event) for (const subscriber of subscribers) dispatch({ event, bytes: serializedBytes(event) }, subscriber);
    },
    /** Освобождает очереди синхронно; in-flight listener не удерживает shutdown. */
    close() {
      closed = true;
      for (const subscriber of subscribers) { subscriber.closed = true; subscriber.queue.length = 0; subscriber.bytes = 0; notifyClose(subscriber, "closed"); }
      subscribers.clear();
    },
  };
}

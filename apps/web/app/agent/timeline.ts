// ABOUTME: Собирает элементы чата, сохраняя только сопоставимые порядки.
// ABOUTME: Исторический order никогда не сравнивается с live seq из трассы.
import type { Message } from "@ag-ui/core";
import type { HistoryItem, ThreadSnapshot } from "@brai/agent/contracts";

export type AgentFeedEntry =
  | { kind: "trace"; item: HistoryItem }
  | { kind: "message"; message: Message; phase?: "commentary" | "final_answer" | null };

/** Собирает историю по native order, затем добавляет live данные без смешения шкал. */
export function buildAgentTimeline(
  history: HistoryItem[],
  liveTrace: ThreadSnapshot["traceItems"],
  messages: Message[],
  phases: Record<string, "commentary" | "final_answer" | null>,
): AgentFeedEntry[] {
  const historyById = new Map<string, HistoryItem>();
  for (const item of history) historyById.set(item.itemId, item);
  const historyItems = [...historyById.values()].sort((left, right) => left.order - right.order);
  const historyIds = new Set(historyItems.map(item => item.itemId));
  const liveById = new Map(liveTrace.map(item => [item.itemId, item]));
  const messagesById = new Map(messages.map(message => [message.id, message]));
  const consumedMessages = new Set<string>();
  const consumedTrace = new Set<string>();
  const result: AgentFeedEntry[] = [];

  const appendMessage = (message: Message) => {
    result.push({ kind: "message", message, phase: phases[message.id] });
    consumedMessages.add(message.id);
    if (message.role !== "assistant") return;
    for (const call of message.toolCalls ?? []) {
      const trace = liveById.get(call.id);
      if (!trace || historyIds.has(call.id) || consumedTrace.has(call.id)) continue;
      result.push({ kind: "trace", item: trace });
      consumedTrace.add(call.id);
    }
  };

  for (const historyItem of historyItems) {
    const item = liveById.get(historyItem.itemId) ?? historyItem;
    const message = historyItem.trace.type === "message" ? messagesById.get(historyItem.itemId) : undefined;
    if (message) appendMessage(message);
    else result.push({ kind: "trace", item });
    consumedTrace.add(item.itemId);
  }

  for (const message of messages) if (!consumedMessages.has(message.id)) appendMessage(message);
  for (const item of liveTrace.slice(-200)) if (!consumedTrace.has(item.itemId)) result.push({ kind: "trace", item });
  return result;
}

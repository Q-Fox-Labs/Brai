// ABOUTME: Даёт действиям краткие подписи, значки и состояния для списка.
// ABOUTME: Использует только display summary; команды и содержимое остаются в деталях.
import type { DisplayItem } from "@brai/agent/contracts";

const labels: Record<string, string> = { commandExecution: "Команда", fileChange: "Изменения файлов", reasoning: "Рассуждение", plan: "План", mcpToolCall: "Инструмент", dynamicToolCall: "Инструмент", collabAgentToolCall: "Совместная работа" };
const paths: Record<string, string> = {
  commandExecution: "m4 5 5 5-5 5m8 0h8",
  fileChange: "M14 2H6v20h12V6l-4-4Zm0 0v5h5M9 12h6m-6 4h6",
  reasoning: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z",
  plan: "m3 6 2 2 3-3m3 2h10M3 14h5m3 0h10M3 21h5m3 0h10",
  collabAgentToolCall: "M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 8v-2a6 6 0 0 1 12 0v2m2-8a4 4 0 0 0 0-8m0 10a6 6 0 0 1 6 6v2",
};

/** Возвращает подпись без команды/вывода; native имя инструмента берёт из уже прочитанной summary. */
export function activityPresentation(item: DisplayItem) {
  let title = labels[item.type] ?? "Действие агента";
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    const name = item.summary?.trim().split("\n")[0];
    if (name && name !== item.type) title = name.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/\//g, " · ").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  }
  const failed = item.status === "failed" || typeof item.exitCode === "number" && item.exitCode !== 0;
  const state = failed ? "failed" : item.status ?? "";
  const status = failed ? "Ошибка" : ({ inProgress: "Выполняется", completed: "Готово", cancelled: "Отменено", canceled: "Отменено", interrupted: "Прервано", declined: "Отклонено" } as Record<string, string>)[state] ?? "";
  return { title, state, status, icon: paths[item.type] ?? "M9 3H3v6h6V3Zm12 0h-6v6h6V3ZM9 15H3v6h6v-6Zm12 0h-6v6h6v-6ZM9 6h6M6 9v6m12-6v6m-9 3h6" };
}

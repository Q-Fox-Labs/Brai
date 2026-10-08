// ABOUTME: Проверяет краткие подписи действий без раскрытия содержимого.
// ABOUTME: Тестирует display данные; загрузка деталей остаётся у lazy reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityPresentation } from "../lib/agent/activity.ts";
import type { DisplayItem } from "@brai/agent/contracts";
const item = (type: string, extra: Partial<DisplayItem> = {}): DisplayItem => ({ id: "action", turnId: "turn", type, text: "PRIVATE OUTPUT", ...extra });

test("command and file rows show short names without commands, output or diff", () => {
  assert.equal(activityPresentation(item("commandExecution", { summary: "printf private", command: "printf private", output: "private" })).title, "Команда");
  assert.equal(activityPresentation(item("fileChange", { summary: "/private/path", diff: "private diff" })).title, "Изменения файлов");
  assert.equal(activityPresentation(item("unknown", { summary: "private content" })).title, "Действие агента");
});

test("tool names use existing summaries and normalize namespace separators", () => {
  assert.equal(activityPresentation(item("mcpToolCall", { summary: "socraticode/codebase_status" })).title, "socraticode · codebase status");
  assert.equal(activityPresentation(item("dynamicToolCall", { summary: "mcp__brai_history__get_events" })).title, "brai history · get events");
  assert.equal(activityPresentation(item("dynamicToolCall", { summary: "dynamicToolCall" })).title, "Инструмент");
  assert.equal(activityPresentation(item("collabAgentToolCall", { summary: "spawnAgent" })).title, "spawn Agent");
});

test("failure takes precedence and absent exit codes never create a failure", () => {
  for (const exitCode of [1, -1, 127]) assert.equal(activityPresentation(item("commandExecution", { status: "completed", exitCode })).status, "Ошибка");
  assert.equal(activityPresentation(item("mcpToolCall", { status: "failed" })).state, "failed");
  assert.equal(activityPresentation(item("commandExecution", { status: "completed", exitCode: null })).status, "Готово");
  assert.equal(activityPresentation(item("commandExecution", { status: "inProgress" })).status, "Выполняется");
  assert.equal(activityPresentation(item("collabAgentToolCall", { status: "interrupted" })).status, "Прервано");
});

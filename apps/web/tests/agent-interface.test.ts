// ABOUTME: Проверяет группировку, единственную команду composer и ленивые чтения с ограниченным кешем.
// ABOUTME: Входы owner заменяются портом; проверки не требуют браузера или внешних сервисов.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLazyReads } from "../lib/agent/lazy.ts";
import { formatLimitReset, limitCountdown } from "../lib/agent/limits.ts";
import { composerAction, groupTimeline } from "../app/agent/timeline.ts";
import type { Command, DisplayItem } from "@brai/agent/contracts";
const context = { generation: "gen", epoch: "epoch", projectId: "project", threadId: "chat" };
const item = (id: string, turnId = "turn", revision = 0): DisplayItem => ({ id, turnId, type: "commandExecution", text: "", revision });

test("actions form closed groups bounded by every user or agent message, including intermediate replies", () => {
  const values = [item("a"), item("b"), { ...item("message"), type: "agentMessage", text: "Update" }, { ...item("reason"), type: "reasoning" }, { ...item("user"), type: "userMessage", text: "Next" }, item("c")];
  const grouped = groupTimeline(values);
  assert.deepEqual(grouped.map(value => value.kind === "activities" ? value.items.map(item => item.id) : value.item.id), [["a", "b"], "message", ["reason"], "user", ["c"]]);
  assert.equal(composerAction(false, "  \n"), "start");
  assert.equal(composerAction(true, "  \n"), "interrupt");
  assert.equal(composerAction(true, "correction"), "steer");
  assert.equal(composerAction(false, "new task"), "start");
});

test("initialization does no reads, summaries batch by turn up to100, full body waits for detail", async () => {
  const calls: Command[] = [];
  const reads = createLazyReads(async command => {
    calls.push(command);
    return command.action === "item" ? { generation: "gen", item: { ...item(command.itemId!, command.turnId), command: "exact  command\n", output: "output" } } : { generation: "gen", data: command.itemIds!.map(id => ({ ...item(id, command.turnId), summary: "Short title" })) };
  });
  assert.equal(calls.length, 0);
  const actions = Array.from({ length: 205 }, (_, i) => item(String(i), i < 100 ? "first" : "second"));
  const headers = await reads.summaries(context, actions);
  assert.equal(headers.length, 205);
  assert.ok(calls.every(command => command.action === "activities" && command.itemIds!.length <= 100));
  assert.equal(calls.length, 3);
  await reads.summaries(context, actions); assert.equal(calls.length, 3);
  const full = await reads.detail(context, actions[0]);
  assert.equal(full.command, "exact  command\n");
  assert.equal(calls.at(-1)?.action, "item");
});

test("read cache isolates generation, epoch, chat and revision; errors can retry", async () => {
  const calls: Command[] = [];
  let fail = false;
  const reads = createLazyReads(async command => {
    calls.push(command); if (fail) throw new Error("temporary");
    return { generation: command.threadId === "other-generation" ? "other" : "gen", item: item(command.itemId!, command.turnId) };
  });
  const action = item("a");
  await reads.detail(context, action);
  await reads.detail(context, action);
  assert.equal(calls.length, 1);
  const same = item("a", "turn", 1);
  await reads.detail(context, same); assert.equal(calls.length, 2);
  await reads.detail({ ...context, epoch: "fresh" }, same); assert.equal(calls.length, 3);
  await reads.detail({ ...context, threadId: "other" }, same); assert.equal(calls.length, 4);
  await assert.rejects(reads.detail({ ...context, threadId: "other-generation" }, action), /Чат обновился/);
  fail = true; await assert.rejects(reads.detail(context, item("retry")), /temporary/);
  fail = false; await reads.detail(context, item("retry"));
});

test("concurrent reads coalesce and never exceed four owner requests", async () => {
  const releases: (() => void)[] = [];
  let running = 0, maximum = 0, calls = 0;
  const reads = createLazyReads(async command => {
    running++; calls++; maximum = Math.max(maximum, running);
    await new Promise<void>(resolve => releases.push(resolve)); running--;
    return { generation: "gen", item: item(command.itemId!) };
  });
  const duplicate = reads.detail(context, item("same"));
  const promises = [duplicate, reads.detail(context, item("same")), ...Array.from({ length: 10 }, (_, i) => reads.detail(context, item(String(i))))];
  assert.equal(calls, 4);
  while (releases.length || running) { releases.splice(0).forEach(release => release()); await new Promise<void>(resolve => setImmediate(resolve)); }
  await Promise.all(promises);
  assert.equal(calls, 11); assert.equal(maximum, 4);
});

const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
function component(name: string) {
  const source = readFileSync(new URL(`../app/agent/${name}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as { default: ComponentType<Record<string, unknown>> } };
  new Function("require", "module", "exports", compiled)((name: string) => name.endsWith(".css") ? {} : name === "./markdown" ? { default: component("markdown") } : name === "../../lib/agent/limits" ? { formatLimitReset, limitCountdown } : require(name), module, module.exports);
  return module.exports.default;
}

test("turn errors show Codex's model-capacity message and a next step", () => {
  const html = renderToStaticMarkup(createElement(component("turn-error"), { error: { code: "serverOverloaded", message: "Selected model is at capacity. Please try a different model." } }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Selected model is at capacity/);
  assert.match(html, /Выберите другую модель/);
});

test("rejected server requests explain that no user answer is needed", () => {
  const request = { requestId: "string:42", kind: "unsupported", method: "item/future/request", turnId: "turn", params: {}, answered: false, reason: "request-too-large" };
  const html = renderToStaticMarkup(createElement(component("request"), { request, disabled: false, send: async () => true }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Превышен лимит отдельного запроса Codex/);
  assert.match(html, /не длины вашего сообщения/);
  assert.match(html, /отвечать не нужно/);
  assert.doesNotMatch(html, /Отправить ответ|Ответ отправлен/);
});

test("real React renders closed activities without list markup, summaries or owner reads", () => {
  let calls = 0;
  const reads = createLazyReads(async () => { calls++; throw new Error("closed groups cannot read"); });
  const html = renderToStaticMarkup(createElement(component("activities"), { context, reads, items: [{ ...item("secret"), text: "FULL BODY", summary: "HIDDEN TITLE" }] }));
  assert.match(html, /<summary>Думаю/);
  assert.doesNotMatch(html, /FULL BODY|HIDDEN TITLE|agent-activity-list|data-item-id/);
  assert.equal(calls, 0);
});

test("sidebar keeps selection, sorts by messages with stable ties and shows an accessible active indicator", () => {
  const thread = { title: "title", preview: "", model: null, canAcceptDirectInput: true, updatedAt: 9999 };
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(component("sidebar"), {
    projects: [{ projectId: "project", name: "Project", available: true }],
    pages: { project: { data: [{ ...thread, id: "tool-latest", lastMessageAt: 1 }, { ...thread, id: "selected", lastMessageAt: 20, active: true }, { ...thread, id: "tie", lastMessageAt: 20 }], nextCursor: null, loading: false, error: "" } },
    projectId: "project", threadId: "selected", email: "user@example.test", open: true, busy: false, accountLimits: { state: "unavailable", revision: 0, observedAt: null, windows: [] }, select: noop, create: noop, more: noop, refresh: noop, close: noop, logout: noop,
  }));
  assert.ok(html.indexOf('data-thread-id="selected"') < html.indexOf('data-thread-id="tie"'));
  assert.ok(html.indexOf('data-thread-id="tie"') < html.indexOf('data-thread-id="tool-latest"'));
  assert.match(html, /data-thread-id="selected" class="agent-thread is-selected"/);
  assert.match(html, /role="status" aria-label="Агент работает"/);
});

test("sidebar renders both account limit windows with accessible remaining values and unknown reset", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(component("sidebar"), {
    projects: [], pages: {}, projectId: "", threadId: "", email: "user@example.test", open: true, busy: false,
    accountLimits: { state: "ready", revision: 4, observedAt: 1, windows: [
      { slot: "primary", remainingPercent: 0, windowDurationMins: 10080, resetsAt: null },
      { slot: "secondary", remainingPercent: 100, windowDurationMins: 300, resetsAt: null },
    ] },
    select: noop, create: noop, more: noop, refresh: noop, close: noop, logout: noop,
  }));
  assert.match(html, /Основное/);
  assert.match(html, /Дополнительное/);
  assert.doesNotMatch(html, /нед\.|agent-limit-time-track/);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /aria-valuenow="100"/);
  assert.equal((html.match(/сброс неизвестен/g) ?? []).length, 2);
});

test("countdown shows remaining days and hours and the fraction of the reset window", () => {
  const now = Date.UTC(2026, 9, 4), hour = 3_600_000;
  const reset = (remaining: number) => (now + remaining * hour) / 1000;
  assert.deepEqual(limitCountdown(reset(84), 10080, now), { label: "3 дн. 12 ч", percent: 50 });
  assert.equal(limitCountdown(reset(26.9), 10080, now)?.label, "1 дн. 2 ч");
  assert.equal(limitCountdown(reset(23.9), 10080, now)?.label, "23 ч");
  assert.equal(limitCountdown(reset(0.5), 10080, now)?.label, "0 ч");
  assert.deepEqual(limitCountdown(reset(-1), 10080, now), { label: "0 ч", percent: 0 });
  assert.equal(limitCountdown(reset(200), 10080, now)?.percent, 100);
  assert.equal(limitCountdown(reset(2.5), 300, now)?.percent, 50);
  assert.deepEqual(limitCountdown(reset(1), null, now), { label: "1 ч", percent: null });
  assert.equal(limitCountdown(reset(1), 0, now)?.percent, null);
  assert.equal(limitCountdown(null, 10080, now), null);
  assert.equal(limitCountdown(Number.MAX_SAFE_INTEGER, 10080, now), null);
});

test("reset formatting uses the local timezone and safely handles missing or invalid timestamps", () => {
  const timezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const reset = formatLimitReset(Date.UTC(2026, 0, 1, 1, 30) / 1000);
    assert.ok(reset);
    assert.match(reset.label, /31/);
    assert.match(reset.label, /17:30/);
    assert.match(reset.title, /17:30/);
    assert.equal(formatLimitReset(null), null);
    assert.equal(formatLimitReset(Number.MAX_SAFE_INTEGER), null);
  } finally {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  }
});

test("compact settings keep catalogue choices, labelled thumbs and icon-only permissions", () => {
  const noop = () => {};
  const models = ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"].map(model => ({ model, name: model, efforts: model === "gpt-6-luna" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" }));
  const props = { models, model: "gpt-6.1-sol", effort: "medium", permissionMode: "auto", disabled: false, chooseModel: noop, chooseEffort: noop, choosePermissions: noop };
  const html = renderToStaticMarkup(createElement(component("settings"), props));
  assert.equal((html.match(/type="range"/g) ?? []).length, 2);
  for (const name of ["Модель", "Рассуждение"]) assert.ok(html.includes(`aria-label="${name}"`));
  assert.match(html, /title="Разрешения: Подтверждать за меня"/);
  assert.match(html, />Sol<\/span>/);
  assert.match(html, />Med<\/span>/);
  assert.match(html, /aria-valuetext="Medium"/);
  assert.match(html, /aria-label="Рассуждение"[^>]*max="5"/);
  const luna = renderToStaticMarkup(createElement(component("settings"), { ...props, model: "gpt-6-luna", effort: "max" }));
  assert.match(luna, /aria-label="Рассуждение"[^>]*max="4"/);
  assert.match(luna, />Max<\/span>/);
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<select|<label|>Подтверждать за меня</);
  const locked = renderToStaticMarkup(createElement(component("settings"), { ...props, disabled: true }));
  assert.equal((locked.match(/disabled=""/g) ?? []).length, 3);
  const loading = renderToStaticMarkup(createElement(component("settings"), { ...props, models: [], model: "", effort: "" }));
  assert.equal((loading.match(/disabled=""/g) ?? []).length, 2);
  assert.match(loading, /Загрузка…/);
});

test("empty reasoning cannot create a group; a live nonempty revision reappears", () => {
  const empty = { ...item("empty"), type: "reasoning", hasContent: false };
  assert.deepEqual(groupTimeline([empty]), []);
  assert.deepEqual(groupTimeline([empty, { ...empty, id: "spaces" }]), []);
  assert.equal(groupTimeline([{ ...empty, hasContent: true, revision: 1 }]).length, 1);
  const reads = createLazyReads(async () => { throw new Error("empty group must not read"); });
  assert.equal(renderToStaticMarkup(createElement(component("activities"), { context, reads, items: [empty] })), "");
});

test("sidebar prioritizes questions over work and hides a read final check", () => {
  const noop = () => {}, thread = { title: "Chat", preview: "", model: null, canAcceptDirectInput: true, updatedAt: 1 };
  const props = { projects: [{ projectId: "p", name: "P", available: true }], pages: { p: { data: [
    { ...thread, id: "question", active: true, awaitingReply: true },
    { ...thread, id: "unread", finalMessageId: "final" },
    { ...thread, id: "read", finalMessageId: "seen" },
  ], nextCursor: null, loading: false, error: "" } }, projectId: "p", threadId: "question", email: "test@example.test", open: true, busy: false,
    accountLimits: { state: "unavailable", revision: 0, observedAt: null, windows: [] }, readMessages: { "p:read": "seen" }, select: noop, create: noop, more: noop, refresh: noop, archive: noop, close: noop, logout: noop };
  const html = renderToStaticMarkup(createElement(component("sidebar"), props));
  assert.equal((html.match(/aria-label="Агент ждёт ответа"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="Непрочитанный итог"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Агент работает/);
});


test("context ring uses the native window, caps its percent and distinguishes unknown data", () => {
  const props = { models: [], model: "", effort: "", permissionMode: "auto", disabled: false, chooseModel: () => {}, chooseEffort: () => {}, choosePermissions: () => {} };
  const render = (contextUsage?: { usedTokens: number; contextWindow: number | null } | null) => renderToStaticMarkup(createElement(component("settings"), { ...props, contextUsage }));
  assert.match(render({ usedTokens: 25000, contextWindow: 258000 }), /aria-label="Контекстное окно: 10% использовано"/);
  assert.match(render({ usedTokens: 300000, contextWindow: 258000 }), /stroke-dasharray="100 100"/);
  assert.match(render({ usedTokens: 0, contextWindow: 258000 }), /Контекстное окно: 0% использовано/);
  for (const usage of [undefined, null, { usedTokens: 25000, contextWindow: null }]) {
    const html = render(usage);
    assert.match(html, /Контекстное окно: данные недоступны/);
    assert.doesNotMatch(html, /stroke-dasharray/);
  }
});

test("long message details concatenate all pages and cache only the complete text", async () => {
  const message = { ...item("message"), type: "agentMessage", text: "preview", truncated: true };
  const chunks = ['я'.repeat(9000), '\n| Поле | Значение |\n', 'Последняя строка 😀'], calls: Command[] = [];
  const reads = createLazyReads(async command => {
    calls.push(command);
    const index = command.cursor ? Number(command.cursor) : 0;
    return { generation: "gen", item: { ...message, text: chunks[index], truncated: index < 2 }, nextCursor: index < 2 ? String(index + 1) : null };
  });
  const value = await reads.detail(context, message);
  assert.equal(value.text, chunks.join("")); assert.equal(value.truncated, false); assert.equal(calls.length, 3);
  assert.equal((await reads.detail(context, message)).text, value.text); assert.equal(calls.length, 3);
});

test("message continuation errors, repeated cursors and revisions never cache partial success", async () => {
  const message = { ...item("message"), type: "userMessage", truncated: true };
  for (const failure of ["generation", "revision", "cursor", "legacy", "network"]) {
    let fail = true, calls = 0;
    const reads = createLazyReads(async command => {
      calls++;
      if (fail && command.cursor && failure === "network") throw new Error("offline");
      return { generation: fail && command.cursor && failure === "generation" ? "old" : "gen", item: { ...message, text: command.cursor ? "tail" : "start", revision: fail && command.cursor && failure === "revision" ? 3 : 0, truncated: fail && failure === "legacy" || !command.cursor || fail && failure === "cursor" }, nextCursor: fail && failure === "legacy" ? undefined : !command.cursor || fail && failure === "cursor" ? "next" : null };
    });
    await assert.rejects(reads.detail(context, message));
    const previous = calls; fail = false;
    assert.equal((await reads.detail(context, message)).text, "starttail"); assert.equal(calls, previous + 2);
  }
});

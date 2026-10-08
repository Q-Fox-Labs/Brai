// ABOUTME: Проверяет доступное управление очередью и отдельную форму через React SSR.
// ABOUTME: Использует реальные UI-компоненты; отправку и хранение заменяют явные порты.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as images from "../lib/agent/images.ts";
import type { QueueEntry } from "../lib/agent/queue.ts";
import type { QueueViewState } from "../lib/agent/queue-controller.ts";

const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
const loaded = new Map<string, Record<string, unknown>>();
function load(path: string): Record<string, unknown> {
  const cached = loaded.get(path);
  if (cached) return cached;
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", compiled)((dependency: string) => {
    if (dependency.startsWith("@/components/ui/")) {
      const name = dependency.slice("@/components/ui/".length);
      return load(`../components/ui/${name}.${name === "cn" ? "ts" : "tsx"}`);
    }
    if (dependency === "../../lib/agent/images") return images;
    return require(dependency);
  }, module, module.exports);
  loaded.set(path, module.exports);
  return module.exports;
}
const components = load("../app/agent/queue-panel.tsx");
const Panel = components.default as ComponentType<Record<string, unknown>>;
const Editor = components.QueueEditor as ComponentType<Record<string, unknown>>;
const scope = { userId: "user", projectId: "project", threadId: "thread" };
const settings = { model: "gpt-6.1-sol", effort: "medium", permissionMode: "auto", agentMode: "plan" } as const;
const entry = (id: string, state: QueueEntry["state"] = "waiting"): QueueEntry => ({ id, scope, generation: "generation", draft: { text: `Message ${id}`, revision: 1, images: [] }, settings, state, ...(state === "unknown" ? { attempt: { operationId: "persisted-operation", action: "start", generation: "generation" } } : {}) });
const models = [{ model: settings.model, name: "Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", inputModalities: ["text", "image"], imageLimit: 4 }];
const actions = { edit: async () => true, move: async () => true, remove: async () => true, dispatch: async () => true, reconcile: async () => true, pause() {}, resume: async () => true };
const view = (entries: QueueEntry[], overrides: Partial<QueueViewState> = {}): QueueViewState => ({ scope, revision: 1, entries, paused: true, available: true, loading: false, error: null, ...overrides });
const render = (state: QueueViewState) => renderToStaticMarkup(createElement(Panel, { state, models, actions }));

test("queue exposes edit, order, immediate send, delete and explicit resume above a separate editor", () => {
  const html = render(view([entry("first"), entry("second")]));
  for (const label of ["Очередь сообщений", "Продолжить", "Изменить", "Выше", "Ниже", "Отправить сейчас", "Удалить"]) assert.ok(html.includes(label), label);
  assert.match(html, /После перезагрузки и «Стоп»/);
  assert.match(html, /Планирование · gpt-6.1-sol · medium/);
  assert.doesNotMatch(html, /agent-draft|<form/);
  assert.match(html, /aria-label="Выше"[^>]*disabled=""/);
  assert.match(html, /aria-label="Ниже"[^>]*disabled=""/);
});

test("unknown result blocks every send and resume, provides check and removal explanation", () => {
  const html = render(view([entry("unknown", "unknown"), entry("waiting")]));
  assert.match(html, /Удаление из очереди не отменяет возможное выполнение/);
  assert.match(html, />Проверить<\/button>/);
  assert.match(html, />Убрать<\/button>/);
  for (const label of ["Продолжить", "Отправить сейчас"]) {
    const button = html.match(new RegExp(`<button[^>]*>${label}<\\/button>`))?.[0];
    assert.ok(button); assert.match(button, /disabled=""/);
  }
  assert.doesNotMatch(html, /Повторить автоматически/);
});

test("unsupported storage disables all queue management and empty ready queue occupies no space", () => {
  const html = render(view([entry("first")], { available: false, error: "Хранилище недоступно" }));
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0);
  assert.ok(buttons.every(button => button.includes('disabled=""')));
  assert.match(html, /role="alert">Хранилище недоступно/);
  assert.equal(render(view([])), "");
});

test("editing form contains independent text, image and every saved setting control", () => {
  const html = renderToStaticMarkup(createElement(Editor, { entry: entry("edit"), models, save: actions.edit, close() {} }));
  assert.match(html, /<form[^>]*aria-label="Изменить сообщение в очереди"/);
  assert.match(html, /<textarea[^>]*>Message edit<\/textarea>/);
  assert.match(html, /type="file"/);
  for (const label of ["Модель", "Рассуждение", "Разрешения", "Режим", "Сохранить", "Отмена"]) assert.ok(html.includes(label));
  assert.match(html, /Редактирование ставит очередь на паузу/);
  assert.match(html, /При отправке в активный ход сохраняются его модель, режим и разрешения/);
  assert.doesNotMatch(html, /agent-draft/);
});

test("editor preserves an unavailable saved model and effort until explicit user choice", () => {
  const saved = entry("obsolete"); saved.settings = { ...settings, model: "removed-model", effort: "ultra" };
  const html = renderToStaticMarkup(createElement(Editor, { entry: saved, models, save: actions.edit, close() {} }));
  assert.match(html, /value="removed-model" selected="">removed-model · недоступна/);
  assert.match(html, /value="ultra" selected="">ultra · недоступно/);
});

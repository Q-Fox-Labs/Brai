// ABOUTME: Проверяет квоту при сбое обновления через React SSR.
// ABOUTME: Sidebar и shared UI рендерятся из исходников на синтетических данных.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as helpers from "../lib/agent/limits.ts";
import { unreadFinal } from "../lib/agent/read-state.ts";

const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
const uiCache = new Map<string, Record<string, unknown>>();
function ui(name: string): Record<string, unknown> {
  const path = name.slice("@/components/ui/".length), cached = uiCache.get(path);
  if (cached) return cached;
  const extension = path === "cn" ? "ts" : "tsx", source = readFileSync(new URL(`../components/ui/${path}.${extension}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} as Record<string, unknown> };
  uiCache.set(path, loaded.exports);
  new Function("require", "module", "exports", output)((dependency: string) => dependency.startsWith("@/components/ui/") ? ui(dependency) : require(dependency), loaded, loaded.exports);
  uiCache.set(path, loaded.exports);
  return loaded.exports;
}
const compiled = ts.transpileModule(readFileSync(new URL("../app/agent/sidebar.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { default: ComponentType<Record<string, unknown>> } };
new Function("require", "module", "exports", compiled)((name: string) => name === "../../lib/agent/limits" ? helpers : name === "../../lib/agent/read-state" ? { unreadFinal } : name.startsWith("@/components/ui/") ? ui(name) : require(name), module, module.exports);

function render(state: string) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(module.exports.default, {
    projects: [], pages: {}, projectId: "", threadId: "", email: "test@example.test", open: true, busy: false,
    accountLimits: { state, revision: 4, observedAt: 1, windows: [{ slot: "primary", remainingPercent: 94, windowDurationMins: 10080, resetsAt: 1_900_000_000 }] },
    select: noop, create: noop, more: noop, refresh: noop, archive: noop, close: noop, logout: noop,
  }));
}

test("refresh failures preserve visible quota markup and expose delay only in the tooltip", () => {
  const ready = render("ready"), stale = render("stale");
  assert.match(stale, /title="Обновление лимита задерживается\. Показаны последние полученные данные\."/);
  assert.equal(stale.replace(/ title="Обновление лимита задерживается\. Показаны последние полученные данные\."/, ""), ready);
  assert.doesNotMatch(stale, /Данные устарели|Устарело ·/);
  assert.match(stale, /aria-valuenow="94"/);
});
